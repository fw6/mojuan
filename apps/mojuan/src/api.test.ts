import { describe, it, expect, vi, beforeEach } from "vitest";

// S1 seam：api 契约。mock @tauri-apps/api/core 的 invoke，测 crawl 的
// payload 序列化/响应解析与 imgSrc 的热链重写（research #4 混合方案）。
vi.mock("@tauri-apps/api/core", () => ({
    invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { applySources } from "./lib/sources";
import {
    crawl,
    crawlCached,
    crawlDebug,
    imgSrc,
    initImgProxy,
    mojuanVersion,
    scanLocal,
    listDownloaded,
    readComicMeta,
    enqueueDownload,
    getDownloads,
    cancelDownload,
    retryDownload,
    clearDownloads,
    subscribeDownloads,
    webdavPut,
    webdavGet,
} from "./api";

const mockedInvoke = vi.mocked(invoke);

beforeEach(() => {
    mockedInvoke.mockReset();
});

/** 设置本机代理端口：mock invoke 返回端口后调 initImgProxy（research #31 换代理）。 */
async function setProxyPort(port: number) {
    mockedInvoke.mockResolvedValue(port);
    await initImgProxy();
}

describe("imgSrc（→ 本机代理 /img；research #31 换代理）", () => {
    beforeEach(() => {
        // 热链对由源文档声明（真实启动由源同步填充）
        applySources([
            {
                id: "webtoons",
                title: "Webtoons",
                hotlinkReferers: [
                    { domain: "pstatic.net", referer: "https://www.webtoons.com/" },
                ],
            },
        ]);
    });

    it("端口就绪后把 pstatic.net 热链图重写为 http://127.0.0.1:<port>/img，带 url 与 ref 参数", async () => {
        await setProxyPort(16320);
        const src = imgSrc("https://s.pstatic.net/dummy/cover.webp");
        expect(src).toBe(
            "http://127.0.0.1:16320/img?url=" +
                encodeURIComponent("https://s.pstatic.net/dummy/cover.webp") +
                "&ref=" +
                encodeURIComponent("https://www.webtoons.com/"),
        );
    });

    it("非热链域保持直连（吃 webview HTTP 缓存）", () => {
        const src = "https://uploads.mangadex.org/covers/abc/def.jpg";
        expect(imgSrc(src)).toBe(src);
    });

    it("带 source+comicId 的阅读页一律走代理（端点查下载索引），热链 Referer 一起带上", async () => {
        await setProxyPort(16320);
        const url = "https://s.pstatic.net/ch1/0.jpg";
        expect(imgSrc(url, { source: "webtoons", comicId: "c1" })).toBe(
            "http://127.0.0.1:16320/img?url=" +
                encodeURIComponent(url) +
                "&ref=" +
                encodeURIComponent("https://www.webtoons.com/") +
                "&source=webtoons&comicId=c1",
        );
    });

    it("非热链域的阅读页也走代理（本地有下载文件时读磁盘）", async () => {
        await setProxyPort(16320);
        const url = "https://uploads.mangadex.org/ch1/0.jpg";
        expect(imgSrc(url, { source: "mangadex", comicId: "c1" })).toBe(
            `http://127.0.0.1:16320/img?url=${encodeURIComponent(url)}&source=mangadex&comicId=c1`,
        );
    });

    it("本地文件路径（旧下载数据）→ /img?path=…，带上 source+comicId 供代理定位相对路径", async () => {
        await setProxyPort(16320);
        const abs = "/Users/me/Downloads/mojuan/webtoons/c1/chapter_1/0.jpg";
        expect(imgSrc(abs, { source: "webtoons", comicId: "c1" })).toBe(
            `http://127.0.0.1:16320/img?path=${encodeURIComponent(abs)}&source=webtoons&comicId=c1`,
        );
        expect(imgSrc("chapter_1/0.jpg", { source: "webtoons", comicId: "c1" })).toBe(
            `http://127.0.0.1:16320/img?path=${encodeURIComponent("chapter_1/0.jpg")}&source=webtoons&comicId=c1`,
        );
    });
});

describe("crawl（invoke 包装：payload 序列化 + JSON 解析）", () => {
    it("把 op/source/payload 以 JSON 字符串传给 crawl 命令并解析响应", async () => {
        mockedInvoke.mockResolvedValue(
            JSON.stringify([{ id: "a", title: "漫" }]),
        );
        const result = await crawl<{ id: string }[]>("search", "mangadex", {
            keyword: "one piece",
        });
        expect(mockedInvoke).toHaveBeenCalledWith("crawl", {
            op: "search",
            source: "mangadex",
            payload: JSON.stringify({ keyword: "one piece" }),
        });
        expect(result).toEqual([{ id: "a", title: "漫" }]);
    });

    it("invoke 被拒绝时原样抛出", async () => {
        mockedInvoke.mockRejectedValue(new Error("command failed"));
        await expect(
            crawl("search", "mangadex", { keyword: "x" }),
        ).rejects.toThrow("command failed");
    });

    it("响应不是合法 JSON 时拒绝（JSON.parse 抛错）", async () => {
        mockedInvoke.mockResolvedValue("{broken");
        await expect(crawl("search", "mangadex", { keyword: "x" })).rejects.toThrow();
    });
});

describe("crawlCached（结果缓存读取：stale-while-revalidate 的 stale 一侧）", () => {
    it("把 op/source/payload 传给 crawl_cached 并解析 {data, fetchedAt}", async () => {
        mockedInvoke.mockResolvedValue(
            JSON.stringify({ data: [{ id: "a" }], fetchedAt: 1700000000000 }),
        );
        const out = await crawlCached<{ id: string }[]>("category", "mangadex", {
            label: "动作",
        });
        expect(mockedInvoke).toHaveBeenCalledWith("crawl_cached", {
            op: "category",
            source: "mangadex",
            payload: JSON.stringify({ label: "动作" }),
        });
        expect(out).toEqual({ data: [{ id: "a" }], fetchedAt: 1700000000000 });
    });

    it("未命中（null）返回 null", async () => {
        mockedInvoke.mockResolvedValue("null");
        await expect(crawlCached("category", "mangadex", { label: "x" })).resolves.toBeNull();
    });

    it("缓存通道异常时按未命中降级（不抛错，不影响 crawl 主路径）", async () => {
        mockedInvoke.mockRejectedValue(new Error("command not found"));
        await expect(crawlCached("category", "mangadex", { label: "x" })).resolves.toBeNull();
    });
});

describe("crawlDebug（调试台一次运行：文档 + op + payload + 隐藏值快照）", () => {
    it("把文档/op/payload/隐藏值传给 crawl_debug 并解析运行记录的各步", async () => {
        mockedInvoke.mockResolvedValue(
            JSON.stringify({
                ok: true,
                data: [{ id: "a", title: "漫" }],
                hidden: { seriesUrl: { a: "https://x/1" } },
                steps: [
                    { stage: "validate", ok: true },
                    {
                        stage: "plan",
                        name: "list",
                        url: "https://x/search?q=1",
                        headers: { Referer: "https://x/" },
                    },
                    {
                        stage: "fetch",
                        name: "list",
                        url: "https://x/search?q=1",
                        body: "<html>",
                        truncated: false,
                    },
                    {
                        stage: "parse",
                        data: [{ id: "a", title: "漫" }],
                        hidden: [{ name: "seriesUrl", key: "a", value: "https://x/1" }],
                    },
                ],
                error: null,
            }),
        );

        const out = await crawlDebug('{"schema":1}', "search", { keyword: "1" }, {});

        expect(mockedInvoke).toHaveBeenCalledWith("crawl_debug", {
            document: '{"schema":1}',
            op: "search",
            payload: JSON.stringify({ keyword: "1" }),
            hidden: "{}",
        });
        expect(out.steps.map((s) => s.stage)).toEqual([
            "validate",
            "plan",
            "fetch",
            "parse",
        ]);
        expect(out.data).toEqual([{ id: "a", title: "漫" }]);
        expect(out.hidden.seriesUrl.a).toBe("https://x/1");
        expect(out.error).toBeNull();
    });

    it("失败记录带阶段名与停在哪一步", async () => {
        mockedInvoke.mockResolvedValue(
            JSON.stringify({
                ok: false,
                data: null,
                hidden: {},
                steps: [
                    { stage: "validate", ok: true },
                    {
                        stage: "plan",
                        name: "list",
                        url: "http://127.0.0.1:1/search",
                        headers: {},
                    },
                    {
                        stage: "fetch",
                        name: "list",
                        url: "http://127.0.0.1:1/search",
                        error: "fetch(search): error sending request",
                    },
                ],
                error: { stage: "fetch", message: "fetch(search): error sending request" },
            }),
        );

        const out = await crawlDebug('{"schema":1}', "search", {}, {});

        expect(out.ok).toBe(false);
        expect(out.error?.stage).toBe("fetch");
        expect(out.error?.message).toContain("fetch");
        const failed = out.steps[out.steps.length - 1];
        expect(failed.stage).toBe("fetch");
        expect(failed).toHaveProperty("error", "fetch(search): error sending request");
    });

    it("文档校验失败时只有 validate 一步", async () => {
        mockedInvoke.mockResolvedValue(
            JSON.stringify({
                ok: false,
                data: null,
                hidden: {},
                steps: [{ stage: "validate", ok: false, error: "validate(search): 文档解析失败" }],
                error: { stage: "validate", message: "validate(search): 文档解析失败" },
            }),
        );

        const out = await crawlDebug("{broken", "search", {}, {});

        expect(out.steps).toHaveLength(1);
        expect(out.steps[0].stage).toBe("validate");
        expect(out.error?.stage).toBe("validate");
    });
});

describe("mojuanVersion", () => {
    it("透传 invoke 返回值", async () => {
        mockedInvoke.mockResolvedValue("0.1.0");
        await expect(mojuanVersion()).resolves.toBe("0.1.0");
        expect(mockedInvoke).toHaveBeenCalledWith("mojuan_version");
    });
});

describe("scanLocal / listDownloaded / readComicMeta（本地下载命令包装）", () => {
    it("scanLocal 解析返回的 JSON 数组（含 source 与作品标题封面）", async () => {
        mockedInvoke.mockResolvedValue(
            JSON.stringify([
                {
                    source: "webtoons",
                    comicId: "a",
                    chapterCount: 3,
                    title: "作品甲",
                    cover: "https://x/a.jpg",
                },
            ]),
        );
        await expect(scanLocal("/tmp/dl")).resolves.toEqual([
            {
                source: "webtoons",
                comicId: "a",
                chapterCount: 3,
                title: "作品甲",
                cover: "https://x/a.jpg",
            },
        ]);
        expect(mockedInvoke).toHaveBeenCalledWith("scan_local", { dir: "/tmp/dl" });
    });

    it("listDownloaded 带 source 解析章节→[{url,path}]", async () => {
        mockedInvoke.mockResolvedValue(
            JSON.stringify({ "1": [{ url: "https://a/1.jpg", path: "chapter_1/1.jpg" }] }),
        );
        await expect(listDownloaded("/tmp/dl", "webtoons", "a")).resolves.toEqual({
            "1": [{ url: "https://a/1.jpg", path: "chapter_1/1.jpg" }],
        });
        expect(mockedInvoke).toHaveBeenCalledWith("list_downloaded", {
            dir: "/tmp/dl",
            source: "webtoons",
            comicId: "a",
        });
    });

    it("readComicMeta 解析作品元数据，没有这份元数据返回 null", async () => {
        mockedInvoke.mockResolvedValue(
            JSON.stringify({
                source: "webtoons",
                comicId: "a",
                title: "作品甲",
                cover: "https://x/a.jpg",
                chapters: { "7": "第 7 话" },
            }),
        );
        await expect(readComicMeta("/tmp/dl", "webtoons", "a")).resolves.toEqual({
            source: "webtoons",
            comicId: "a",
            title: "作品甲",
            cover: "https://x/a.jpg",
            chapters: { "7": "第 7 话" },
        });
        expect(mockedInvoke).toHaveBeenCalledWith("read_comic_meta", {
            dir: "/tmp/dl",
            source: "webtoons",
            comicId: "a",
        });

        mockedInvoke.mockResolvedValue("null");
        await expect(readComicMeta("/tmp/dl", "webtoons", "b")).resolves.toBeNull();
    });
});

describe("下载任务队列 API（wayfinder #20/#22/#23）", () => {
    it("enqueueDownload 把入队参数透传给 enqueue_download 并解析结果", async () => {
        mockedInvoke.mockResolvedValue(
            JSON.stringify({
                result: "queued",
                progress: { taskId: "webtoons/a/1", status: "queued", done: 0, total: 3 },
            }),
        );
        const out = await enqueueDownload({
            source: "webtoons",
            comicId: "a",
            comicTitle: "标题",
            comicCover: "https://x/cover.jpg",
            chapterIndex: 1,
            chapterTitle: "第 1 话",
            dir: "/tmp/dl",
            referer: "https://www.webtoons.com/",
            urls: ["https://x/0.jpg", "https://x/1.jpg", "https://x/2.jpg"],
        });
        expect(out.result).toBe("queued");
        expect(out.progress.total).toBe(3);
        expect(mockedInvoke).toHaveBeenCalledWith("enqueue_download", {
            source: "webtoons",
            comicId: "a",
            comicTitle: "标题",
            comicCover: "https://x/cover.jpg",
            chapterIndex: 1,
            chapterTitle: "第 1 话",
            dir: "/tmp/dl",
            referer: "https://www.webtoons.com/",
            urls: ["https://x/0.jpg", "https://x/1.jpg", "https://x/2.jpg"],
        });
    });

    it("getDownloads 解析快照数组（含展示字段）", async () => {
        mockedInvoke.mockResolvedValue(
            JSON.stringify([
                {
                    taskId: "webtoons/a/1",
                    source: "webtoons",
                    comicId: "a",
                    comicTitle: "标题",
                    comicCover: "https://x/cover.jpg",
                    chapterIndex: 1,
                    chapterTitle: "第 1 话",
                    status: "downloading",
                    done: 2,
                    total: 3,
                },
            ]),
        );
        const list = await getDownloads();
        expect(list).toHaveLength(1);
        expect(list[0].comicTitle).toBe("标题");
        expect(list[0].chapterTitle).toBe("第 1 话");
        expect(mockedInvoke).toHaveBeenCalledWith("get_downloads");
    });

    it("cancelDownload/retryDownload 解析进度或 null", async () => {
        mockedInvoke.mockResolvedValue(
            JSON.stringify({ taskId: "a", status: "cancelled", done: 0, total: 3 }),
        );
        await expect(cancelDownload("a")).resolves.toMatchObject({ status: "cancelled" });
        expect(mockedInvoke).toHaveBeenCalledWith("cancel_download", { taskId: "a" });

        mockedInvoke.mockResolvedValue(
            JSON.stringify({ taskId: "a", status: "queued", done: 0, total: 3 }),
        );
        await expect(retryDownload("a")).resolves.toMatchObject({ status: "queued" });
        expect(mockedInvoke).toHaveBeenCalledWith("retry_download", { taskId: "a" });

        mockedInvoke.mockResolvedValue("null");
        await expect(cancelDownload("missing")).resolves.toBeNull();
    });

    it("clearDownloads 返回移除数量", async () => {
        mockedInvoke.mockResolvedValue(2);
        await expect(clearDownloads()).resolves.toBe(2);
        expect(mockedInvoke).toHaveBeenCalledWith("clear_downloads");
    });

    it("subscribeDownloads 把 Channel 传给 subscribe_downloads", async () => {
        const channel = { id: 1 };
        await subscribeDownloads(channel as never);
        expect(mockedInvoke).toHaveBeenCalledWith("subscribe_downloads", { channel });
    });
});

describe("WebDAV 备份/恢复 API（wayfinder #24）", () => {
    it("webdavPut 透传 base/user/password/fileName/content 并解析结果", async () => {
        mockedInvoke.mockResolvedValue(JSON.stringify({ success: true, status: 201 }));
        await expect(
            webdavPut(
                "https://dav.example.com/dav/",
                "u",
                "p",
                "mojuan-backup.json",
                "{}",
            ),
        ).resolves.toEqual({ success: true, status: 201 });
        expect(mockedInvoke).toHaveBeenCalledWith("webdav_put", {
            base: "https://dav.example.com/dav/",
            user: "u",
            password: "p",
            fileName: "mojuan-backup.json",
            content: "{}",
        });
    });

    it("webdavGet 解析内容与错误字段", async () => {
        mockedInvoke.mockResolvedValue(
            JSON.stringify({ ok: true, content: '{"version":1}' }),
        );
        await expect(webdavGet("https://dav.example.com/", "u", "p", "mojuan-backup.json")).resolves.toEqual(
            { ok: true, content: '{"version":1}' },
        );
        expect(mockedInvoke).toHaveBeenCalledWith("webdav_get", {
            base: "https://dav.example.com/",
            user: "u",
            password: "p",
            fileName: "mojuan-backup.json",
        });
        mockedInvoke.mockResolvedValue(JSON.stringify({ ok: false, status: 404 }));
        await expect(webdavGet("https://dav.example.com/", "u", "p", "x.json")).resolves.toEqual(
            { ok: false, status: 404 },
        );
    });
});
