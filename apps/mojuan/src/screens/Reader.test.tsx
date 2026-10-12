import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, act, cleanup, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import Reader from "./Reader";
import type { Chapter, Comic } from "../api";
import type { ProgressRecord } from "../lib/storage/progress";

// S4 seam：阅读器的阅读位置。记录的是「话内第几张图 + 图内位置」，进入时按它恢复，
// 不依赖虚拟器「测量值有变化」。

vi.mock("../api", () => ({
    crawl: vi.fn(),
    crawlCached: vi.fn(),
    imgSrc: vi.fn((url: string) => url),
    listDownloaded: vi.fn().mockResolvedValue({}),
}));

vi.mock("../lib/storage/history", () => ({
    touchHistory: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/storage/progress", () => ({
    getProgress: vi.fn(),
    setProgress: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/storage/settings", () => ({
    getSettings: vi.fn().mockResolvedValue({ autoTrim: false, downloadDir: "/tmp/dl" }),
}));

vi.mock("@tauri-apps/api/window", () => ({
    getCurrentWindow: () => ({
        isFullscreen: vi.fn().mockResolvedValue(false),
        setFullscreen: vi.fn().mockResolvedValue(undefined),
    }),
}));

import { crawl, crawlCached, imgSrc, listDownloaded } from "../api";
import { touchHistory } from "../lib/storage/history";
import { getProgress, setProgress } from "../lib/storage/progress";
import { ToastProvider } from "../components/toast";

const mockedCrawl = vi.mocked(crawl);
const mockedCrawlCached = vi.mocked(crawlCached);
const mockedImgSrc = vi.mocked(imgSrc);
const mockedListDownloaded = vi.mocked(listDownloaded);
const mockedHistory = vi.mocked(touchHistory);
const mockedProgress = vi.mocked(getProgress);
const mockedSetProgress = vi.mocked(setProgress);

const COMIC: Comic = {
    id: "webtoons-1",
    source: "webtoons",
    sourceTitle: "Webtoons",
    title: "测试作品",
    author: "",
    intro: "",
    cover: "",
    status: "serial",
    updateTime: "",
    lastChapter: "",
    tags: [],
    lastReadChapter: 0,
    lastReadTime: 0,
};

function chapter(index: number): Chapter {
    return {
        index,
        title: `第 ${index} 话`,
        pages: [],
        external: false,
        downloaded: false,
        read: false,
    };
}

/** 详情走结果缓存（详情页每次进都刷新它），images 返回固定页数的占位地址。 */
const PAGES_PER_CHAPTER = 6;
function stubCrawl() {
    mockedCrawlCached.mockResolvedValue({
        data: { comic: COMIC, chapters: [chapter(1), chapter(2)] },
        fetchedAt: Date.now(),
    } as unknown as Awaited<ReturnType<typeof crawlCached>>);
    mockedCrawl.mockImplementation((async (op: string) => {
        if (op === "detail") {
            return { comic: COMIC, chapters: [chapter(1), chapter(2)] };
        }
        return Array.from(
            { length: PAGES_PER_CHAPTER },
            (_, i) => `https://img/${i}.jpg`,
        );
    }) as unknown as typeof crawl);
}

function renderReader() {
    return render(
        <ToastProvider>
            <MemoryRouter initialEntries={["/reader/webtoons/webtoons-1/1"]}>
                <Routes>
                    <Route
                        path="/reader/:source/:comicId/:chapterIndex"
                        element={<Reader />}
                    />
                    <Route
                        path="/local/:source/:comicId/:chapterIndex"
                        element={<Reader local />}
                    />
                </Routes>
            </MemoryRouter>
        </ToastProvider>,
    );
}

/** 离线场景：详情缓存为空、联网抓取给空结果，章节与页面只能来自下载目录。 */
function stubOffline() {
    mockedCrawlCached.mockResolvedValue(null);
    mockedCrawl.mockImplementation((async (op: string) =>
        op === "detail" ? {} : []) as unknown as typeof crawl);
    mockedListDownloaded.mockResolvedValue({
        "1": [
            { url: "https://img/0.jpg", path: "chapter_1/0.jpg" },
            { url: "", path: "chapter_1/1.jpg" },
        ],
    });
}

/** 阅读器自己的滚动容器（页面自带滚动，外层槽位不套一层）。 */
function scroller(container: HTMLElement): HTMLElement {
    const el = container.querySelector<HTMLElement>(".overflow-y-auto");
    if (!el) throw new Error("找不到阅读器滚动容器");
    return el;
}

/** 虚拟器撑出的内容总高（内层轨道元素的行内高度）。 */
function contentHeight(container: HTMLElement): number {
    const track = scroller(container).querySelector<HTMLElement>(":scope > div > div");
    return Number.parseFloat(track?.style.height ?? "0");
}

/** jsdom 没有布局，滚动容器的 clientHeight / scrollHeight 恒为 0，虚拟器据此算不出
 * 可滚动范围（`scrollToOffset` 会被夹到 0）。给容器一个几何，恢复才有落点。 */
const VIEWPORT = 800;
function stubGeometry(el: HTMLElement, content: number) {
    Object.defineProperty(el, "clientHeight", { value: VIEWPORT, configurable: true });
    Object.defineProperty(el, "scrollHeight", { value: content, configurable: true });
}

/** 手动控制 getProgress 何时返回：等容器几何就绪后再放行，恢复才量得到落点。 */
function deferredProgress() {
    let resolve!: (v: ProgressRecord | null) => void;
    const promise = new Promise<ProgressRecord | null>((r) => {
        resolve = r;
    });
    mockedProgress.mockReturnValue(promise);
    return resolve;
}

/** 页面按预留高度均匀铺开：每页 1440（列宽 720 × webtoons 兜底比例 2）。 */
const PAGE_HEIGHT = 1440;
/** 一页里 offset 处的点放回视口中心后，容器应当停在的 scrollTop。 */
function scrollTopForPoint(point: number): number {
    return point - VIEWPORT / 2;
}

beforeEach(() => {
    vi.clearAllMocks();
    stubCrawl();
});

afterEach(cleanup);

describe("阅读器的阅读位置恢复", () => {
    it("按记录的页码与页内位置恢复，把那一处放回视口中心", async () => {
        const resolve = deferredProgress();
        const { container } = renderReader();
        await waitFor(() => expect(contentHeight(container)).toBeGreaterThan(0));
        const sc = scroller(container);
        stubGeometry(sc, contentHeight(container));

        await act(async () => {
            resolve({ chapterIndex: 1, pageIndex: 2, offsetInPage: 0.5, updatedAt: 1 });
        });
        // 第 3 页（下标 2）的中间：2×1440 + 720
        expect(sc.scrollTop).toBeCloseTo(scrollTopForPoint(2 * PAGE_HEIGHT + 720), 0);
    });

    it("记录属于别的话时不套用（从头读这一话）", async () => {
        const resolve = deferredProgress();
        const { container } = renderReader();
        await waitFor(() => expect(contentHeight(container)).toBeGreaterThan(0));
        const sc = scroller(container);
        stubGeometry(sc, contentHeight(container));

        await act(async () => {
            resolve({ chapterIndex: 2, pageIndex: 5, offsetInPage: 0.8, updatedAt: 1 });
        });
        expect(sc.scrollTop).toBe(0);
    });

    it("没有进度记录时从头开始", async () => {
        const resolve = deferredProgress();
        const { container } = renderReader();
        await waitFor(() => expect(contentHeight(container)).toBeGreaterThan(0));
        const sc = scroller(container);
        stubGeometry(sc, contentHeight(container));

        await act(async () => {
            resolve(null);
        });
        expect(sc.scrollTop).toBe(0);
    });
});

describe("阅读器的阅读位置记录", () => {
    it("滚动后按视口中心写下话内页码与页内位置", async () => {
        const resolve = deferredProgress();
        const { container } = renderReader();
        await waitFor(() => expect(contentHeight(container)).toBeGreaterThan(0));
        const sc = scroller(container);
        stubGeometry(sc, contentHeight(container));
        await act(async () => {
            resolve(null);
        });

        // 视口中心落在第 4 页（下标 3）里：3×1440 + 400
        sc.scrollTop = 3 * PAGE_HEIGHT;
        fireEvent.scroll(sc);

        await waitFor(() => expect(mockedSetProgress).toHaveBeenCalled());
        expect(mockedSetProgress).toHaveBeenCalledWith(
            "webtoons",
            "webtoons-1",
            expect.objectContaining({
                chapterIndex: 1,
                pageIndex: 3,
                offsetInPage: 400 / PAGE_HEIGHT,
            }),
        );
    });
});

describe("阅读器的详情与取图来源", () => {
    // 虚拟器按元素的 offsetHeight 取外层尺寸，jsdom 里恒为 0（range 为 null → 一页都不挂载）。
    // 断言取图地址的用例需要页面真的渲染出来，给它一个固定视口高度。
    beforeEach(() => {
        Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
            get: () => VIEWPORT,
            configurable: true,
        });
    });

    it("缓存与下载都没有时联网拉详情，取图走 images op", async () => {
        mockedCrawlCached.mockResolvedValue(null);
        mockedListDownloaded.mockResolvedValue({});
        const { container } = renderReader();

        await waitFor(() => expect(container.textContent).toContain("测试作品"));
        expect(mockedCrawl).toHaveBeenCalledWith("detail", "webtoons", {
            comicId: "webtoons-1",
        });
        await waitFor(() =>
            expect(mockedCrawl).toHaveBeenCalledWith("images", "webtoons", {
                comicId: "webtoons-1",
                chapterIndex: 1,
            }),
        );
    });

    it("详情缓存与联网都拿不到时，章节与页面来自下载目录，且不写历史", async () => {
        stubOffline();
        const { container } = renderReader();

        // 章节表只有下载的那一话，且没有发过任何抓取请求
        await waitFor(() => expect(container.textContent).toContain("第 1 话"));
        expect(mockedCrawl).not.toHaveBeenCalled();

        // 页面来自下载清单：有索引记录的话用原图 URL，没有则回落到相对路径
        await waitFor(() =>
            expect(mockedImgSrc).toHaveBeenCalledWith("https://img/0.jpg", {
                source: "webtoons",
                comicId: "webtoons-1",
            }),
        );
        expect(mockedImgSrc).toHaveBeenCalledWith("chapter_1/1.jpg", {
            source: "webtoons",
            comicId: "webtoons-1",
        });

        // 下载目录里没有真实标题，历史不记这种条目
        const sc = scroller(container);
        stubGeometry(sc, contentHeight(container));
        sc.scrollTop = PAGE_HEIGHT;
        fireEvent.scroll(sc);
        await waitFor(() => expect(mockedSetProgress).toHaveBeenCalled());
        expect(mockedHistory).not.toHaveBeenCalled();
    });

    it("已下载的话不再联网取图，章节表来自缓存时照写历史", async () => {
        mockedListDownloaded.mockResolvedValue({
            "1": [{ url: "https://img/0.jpg", path: "chapter_1/0.jpg" }],
        });
        const { container } = renderReader();

        await waitFor(() => expect(container.textContent).toContain("测试作品"));
        expect(mockedCrawl).not.toHaveBeenCalledWith(
            "images",
            expect.anything(),
            expect.anything(),
        );
        await waitFor(() => expect(mockedHistory).toHaveBeenCalled());
    });
});
