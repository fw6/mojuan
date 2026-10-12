import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

// vitest 不开 globals（vite.config.ts：#10 seam 测试显式 import）→ RTL 不会自动
// cleanup，DOM 会跨用例泄漏。手动在 afterEach 清理。

// S3 seam：两段式加载 module。mock api 层与 storage，验证缓存/新鲜窗口/空结果
// 保留/错误呈现/请求键变化这几条策略。

vi.mock("../../api", () => ({
    crawl: vi.fn(),
    crawlCached: vi.fn(),
    sourceErrors: vi.fn().mockResolvedValue({}),
}));

vi.mock("../storage/sources", () => ({
    persistSourceCache: vi.fn().mockResolvedValue(undefined),
    whenSourcesReady: vi.fn().mockResolvedValue(undefined),
}));

import { crawl, crawlCached, sourceErrors } from "../../api";
import { persistSourceCache, whenSourcesReady } from "../storage/sources";
import { useCrawl } from "./use-crawl";

const mockedCrawl = vi.mocked(crawl);
const mockedCached = vi.mocked(crawlCached);
const mockedErrors = vi.mocked(sourceErrors);
const mockedPersist = vi.mocked(persistSourceCache);
const mockedReady = vi.mocked(whenSourcesReady);

/** 缓存命中（指定抓取时刻）。 */
const hit = <T,>(data: T, fetchedAt = 0) => ({ data, fetchedAt });

beforeEach(() => {
    vi.clearAllMocks();
    mockedCached.mockResolvedValue(null);
    mockedCrawl.mockResolvedValue([]);
    mockedErrors.mockResolvedValue({});
    mockedReady.mockResolvedValue(undefined);
});

afterEach(() => {
    cleanup();
});

describe("useCrawl（两段式加载）", () => {
    it("缓存未命中：拉网络，data 为抓取结果", async () => {
        mockedCrawl.mockResolvedValue(["动作"]);
        const { result } = renderHook(() =>
            useCrawl<string[]>("categories", "mangadex", {}),
        );
        await waitFor(() => expect(result.current.data).toEqual(["动作"]));
        expect(result.current.loading).toBe(false);
        expect(result.current.stale).toBe(false);
        expect(result.current.error).toBeNull();
        expect(mockedCrawl).toHaveBeenCalledWith("categories", "mangadex", {});
    });

    it("窗口内的缓存直接用、不发请求", async () => {
        mockedCached.mockResolvedValue(hit(["动作"], Date.now()));
        const { result } = renderHook(() =>
            useCrawl<string[]>("categories", "mangadex", {}, { maxAge: 60_000 }),
        );
        await waitFor(() => expect(result.current.data).toEqual(["动作"]));
        expect(result.current.loading).toBe(false);
        expect(result.current.stale).toBe(false);
        expect(mockedCrawl).not.toHaveBeenCalled();
    });

    it("缓存过期：先渲染缓存（stale），网络结果到达后覆盖", async () => {
        let release!: () => void;
        const gate = new Promise<void>((r) => {
            release = r;
        });
        mockedCached.mockResolvedValue(hit(["旧"], Date.now() - 10 * 60 * 1000));
        mockedCrawl.mockImplementation(async () => {
            await gate;
            return ["新"];
        });
        const { result } = renderHook(() =>
            useCrawl<string[]>("categories", "mangadex", {}, { maxAge: 60_000 }),
        );
        // 缓存先上屏，同时还在拉最新
        await waitFor(() => expect(result.current.data).toEqual(["旧"]));
        expect(result.current.stale).toBe(true);
        expect(result.current.loading).toBe(true);
        await act(async () => {
            release();
            await gate;
        });
        await waitFor(() => expect(result.current.data).toEqual(["新"]));
        expect(result.current.stale).toBe(false);
        expect(result.current.loading).toBe(false);
    });

    it("源返回空结果：保留缓存展示", async () => {
        mockedCached.mockResolvedValue(hit(["旧"]));
        mockedCrawl.mockResolvedValue([]);
        const { result } = renderHook(() =>
            useCrawl<string[]>("categories", "mangadex", {}),
        );
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.data).toEqual(["旧"]);
    });

    it("没有缓存且结果为空：data 为 null（页面显示空状态）", async () => {
        mockedCrawl.mockResolvedValue([]);
        const { result } = renderHook(() =>
            useCrawl<string[]>("categories", "mangadex", {}),
        );
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.data).toBeNull();
    });

    it("抓取抛出错误：error 取首行，缓存留在屏上", async () => {
        mockedCached.mockResolvedValue(hit(["旧"]));
        mockedCrawl.mockRejectedValue(new Error("fetch(category): 失败\n@1:2"));
        const { result } = renderHook(() =>
            useCrawl<string[]>("categories", "mangadex", {}),
        );
        await waitFor(() => expect(result.current.error).toBe("fetch(category): 失败"));
        expect(result.current.data).toEqual(["旧"]);
        expect(result.current.loading).toBe(false);
    });

    it("抓取抛出但没有错误文本：给页面兜底说明", async () => {
        mockedCrawl.mockRejectedValue(new Error(""));
        const { result } = renderHook(() =>
            useCrawl<string[]>("categories", "mangadex", {}),
        );
        await waitFor(() =>
            expect(result.current.error).toBe("源没有返回错误信息"),
        );
    });

    it("结果为空且源错误登记表有记录：error 取登记表首行", async () => {
        mockedCrawl.mockResolvedValue([]);
        mockedErrors.mockResolvedValue({
            mangadex: { message: "fetch(category): 失败\n@1:2", at: 1 },
        });
        const { result } = renderHook(() =>
            useCrawl<string[]>("categories", "mangadex", {}),
        );
        await waitFor(() => expect(result.current.error).toBe("fetch(category): 失败"));
    });

    it("结果非空时不再挂登记表里的旧错误", async () => {
        mockedCrawl.mockResolvedValue(["动作"]);
        mockedErrors.mockResolvedValue({
            mangadex: { message: "一小时前的失败", at: 1 },
        });
        const { result } = renderHook(() =>
            useCrawl<string[]>("categories", "mangadex", {}),
        );
        await waitFor(() => expect(result.current.data).toEqual(["动作"]));
        expect(result.current.error).toBeNull();
    });

    it("detail 返回没有 comic 的空对象：算空结果、不覆盖缓存", async () => {
        mockedCached.mockResolvedValue(hit({ comic: { id: "c" }, chapters: [] }));
        mockedCrawl.mockResolvedValue({ chapters: [] });
        const { result } = renderHook(() =>
            useCrawl<{ comic?: unknown; chapters: unknown[] }>(
                "detail",
                "mangadex",
                { comicId: "c" },
            ),
        );
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.data).toEqual({ comic: { id: "c" }, chapters: [] });
    });

    it("enabled 为 false：不发请求，data 为 null", async () => {
        const { result } = renderHook(() =>
            useCrawl<string[]>("categories", "mangadex", {}, { enabled: false }),
        );
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.data).toBeNull();
        expect(mockedCached).not.toHaveBeenCalled();
        expect(mockedCrawl).not.toHaveBeenCalled();
    });

    it("reload() 重跑当前请求", async () => {
        mockedCrawl.mockResolvedValueOnce(["甲"]).mockResolvedValueOnce(["乙"]);
        const { result } = renderHook(() =>
            useCrawl<string[]>("categories", "mangadex", {}),
        );
        await waitFor(() => expect(result.current.data).toEqual(["甲"]));
        act(() => result.current.reload());
        await waitFor(() => expect(result.current.data).toEqual(["乙"]));
    });

    it("抓取成功后回灌该源的进程内缓存", async () => {
        mockedCrawl.mockResolvedValue(["动作"]);
        renderHook(() => useCrawl<string[]>("categories", "mangadex", {}));
        await waitFor(() => expect(mockedPersist).toHaveBeenCalledWith("mangadex"));
    });

    it("抓取前先等源脚本同步完成", async () => {
        mockedCrawl.mockResolvedValue(["动作"]);
        renderHook(() => useCrawl<string[]>("categories", "mangadex", {}));
        await waitFor(() => expect(mockedCrawl).toHaveBeenCalled());
        expect(mockedReady).toHaveBeenCalled();
    });

    // ---- 请求键变化（切分类/切源）----

    it("请求键变化且缓存未命中：旧数据留到读缓存有结果为止", async () => {
        let release!: () => void;
        const gate = new Promise<void>((r) => {
            release = r;
        });
        mockedCrawl.mockResolvedValueOnce(["甲"]).mockResolvedValueOnce(["乙"]);
        const { result, rerender } = renderHook(
            ({ label }: { label: string }) =>
                useCrawl<string[]>("category", "mangadex", { label }),
            { initialProps: { label: "甲" } },
        );
        await waitFor(() => expect(result.current.data).toEqual(["甲"]));

        mockedCached.mockImplementationOnce(async () => {
            await gate;
            return null;
        });
        rerender({ label: "乙" });
        // 读缓存还没回来：上一个请求的数据仍在屏上
        expect(result.current.data).toEqual(["甲"]);
        await act(async () => {
            release();
            await gate;
        });
        await waitFor(() => expect(result.current.data).toEqual(["乙"]));
    });

    it("请求键变化且缓存命中：直接换成缓存，不发请求", async () => {
        let release!: () => void;
        const gate = new Promise<void>((r) => {
            release = r;
        });
        mockedCrawl.mockResolvedValueOnce(["甲"]);
        const { result, rerender } = renderHook(
            ({ label }: { label: string }) =>
                useCrawl<string[]>("category", "mangadex", { label }, { maxAge: 60_000 }),
            { initialProps: { label: "甲" } },
        );
        await waitFor(() => expect(result.current.data).toEqual(["甲"]));

        mockedCached.mockImplementationOnce(async () => {
            await gate;
            return hit(["乙缓存"], Date.now());
        });
        mockedCrawl.mockClear();
        rerender({ label: "乙" });
        await act(async () => {
            release();
            await gate;
        });
        await waitFor(() => expect(result.current.data).toEqual(["乙缓存"]));
        expect(mockedCrawl).not.toHaveBeenCalled();
    });
});
