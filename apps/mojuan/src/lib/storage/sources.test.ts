import { describe, it, expect, beforeEach, vi } from "vitest";

// S3 seam：源域（已装源同步 + 源进程内缓存的持久化）。mock 插件层与 core invoke。

vi.mock("@tauri-apps/plugin-store", async () => (await import("./test-doubles")).storePlugin);
vi.mock("@tauri-apps/api/core", async () => ({
    invoke: (await import("./test-doubles")).invokeMock,
}));

import {
    hydrateSourceCaches,
    persistSourceCache,
    resyncSources,
    whenSourcesReady,
} from "./sources";
import { SOURCES, hotlinkRefererFor } from "../sources";
import { invokeMock, resetDoubles, storePlugin } from "./test-doubles";

beforeEach(() => {
    resetDoubles();
});

describe("源进程内缓存的持久化", () => {
    it("hydrate：把各源已存映射回灌 Rust 进程内缓存", async () => {
        invokeMock.mockResolvedValue(JSON.stringify({}));
        const store = await storePlugin.load("sources-cache.json");
        await store.set("caches", {
            webtoons: { "1571": "https://www.webtoons.com/x/list?title_no=1571" },
        });
        await hydrateSourceCaches();
        expect(invokeMock).toHaveBeenCalledWith("crawl", {
            op: "cache_hydrate",
            source: "webtoons",
            payload: JSON.stringify({ "1571": "https://www.webtoons.com/x/list?title_no=1571" }),
        });
    });

    it("hydrate：无已存数据时不做任何调用", async () => {
        await hydrateSourceCaches();
        expect(invokeMock).not.toHaveBeenCalled();
    });

    it("persist：把 cache_dump 结果按源写入存储", async () => {
        invokeMock.mockResolvedValue(
            JSON.stringify({ "1571": "https://www.webtoons.com/x/list?title_no=1571" }),
        );
        await persistSourceCache("webtoons");
        const store = await storePlugin.load("sources-cache.json");
        expect(await store.get("caches")).toEqual({
            webtoons: { "1571": "https://www.webtoons.com/x/list?title_no=1571" },
        });
    });

    it("persist：该源没有持久缓存（dump 出空对象）时不写存储", async () => {
        invokeMock.mockResolvedValue(JSON.stringify({}));
        await persistSourceCache("hentara");
        const store = await storePlugin.load("sources-cache.json");
        expect(await store.get("caches")).toBeUndefined();
    });
});

describe("whenSourcesReady（源同步单例）", () => {
    it("并发与重复调用共享同一次同步（sync_sources 只发一次），载荷是已装源的有序文档列表", async () => {
        invokeMock.mockImplementation(async (cmd: string) => {
            if (cmd === "sync_sources") {
                return JSON.stringify({ sources: [], rejected: [] });
            }
            return undefined;
        });
        const store = await storePlugin.load("sources.json");
        await store.set("order", ["mangadex", "dongman"]);
        await store.set("sources", {
            mangadex: {
                sourceId: "mangadex",
                version: 3,
                document: '{"schema":1,"id":"mangadex"}',
                updatedAt: 1,
            },
            dongman: {
                sourceId: "dongman",
                version: 1,
                document: '{"schema":1,"id":"dongman"}',
                updatedAt: 2,
            },
        });

        await Promise.all([whenSourcesReady(), whenSourcesReady()]);
        await whenSourcesReady();
        const syncCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "sync_sources");
        expect(syncCalls).toHaveLength(1);
        expect(JSON.parse(syncCalls[0][1].payload)).toEqual({
            sources: [
                { id: "mangadex", document: '{"schema":1,"id":"mangadex"}' },
                { id: "dongman", document: '{"schema":1,"id":"dongman"}' },
            ],
        });
    });

    it("索引里的运行时也一并同步（装过才带）", async () => {
        invokeMock.mockImplementation(async (cmd: string) => {
            if (cmd === "sync_sources") {
                return JSON.stringify({ sources: [], rejected: [] });
            }
            return undefined;
        });
        const store = await storePlugin.load("sources.json");
        await store.set("runtime", { version: 2, script: "function plan(){} function parse(){}" });
        await resyncSources();
        const syncCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "sync_sources");
        expect(JSON.parse(syncCalls[0][1].payload).runtime).toBe(
            "function plan(){} function parse(){}",
        );
    });

    it("同步结果里的源事实填进前端清单与热链对（sync_sources 返回的是 JSON 字符串）", async () => {
        invokeMock.mockImplementation(async (cmd: string) => {
            if (cmd === "sync_sources") {
                return JSON.stringify({
                    sources: [
                        {
                            id: "webtoons",
                            title: "Webtoons",
                            hotlinkReferers: [
                                { domain: "pstatic.net", referer: "https://www.webtoons.com/" },
                            ],
                        },
                    ],
                    rejected: [],
                });
            }
            return undefined;
        });
        await resyncSources();
        expect(SOURCES).toEqual([{ id: "webtoons", title: "Webtoons" }]);
        expect(hotlinkRefererFor("https://webtoon-phinf.pstatic.net/x.jpg")).toBe(
            "https://www.webtoons.com/",
        );
    });

    it("没有文档的安装记录（旧模型留下的）不进同步载荷，并从存储里清掉", async () => {
        invokeMock.mockImplementation(async (cmd: string) => {
            if (cmd === "sync_sources") {
                return JSON.stringify({ sources: [], rejected: [] });
            }
            return undefined;
        });
        const store = await storePlugin.load("sources.json");
        await store.set("order", ["mangadex", "stale"]);
        await store.set("sources", {
            mangadex: {
                sourceId: "mangadex",
                version: 3,
                document: '{"schema":1,"id":"mangadex"}',
                updatedAt: 1,
            },
            stale: { sourceId: "stale", version: 1, updatedAt: 2 } as never,
        });

        await resyncSources();

        const syncCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "sync_sources");
        expect(JSON.parse(syncCalls[0][1].payload).sources).toEqual([
            { id: "mangadex", document: '{"schema":1,"id":"mangadex"}' },
        ]);
        expect(await store.get("sources")).toEqual({
            mangadex: {
                sourceId: "mangadex",
                version: 3,
                document: '{"schema":1,"id":"mangadex"}',
                updatedAt: 1,
            },
        });
        expect(await store.get("order")).toEqual(["mangadex"]);
    });
});
