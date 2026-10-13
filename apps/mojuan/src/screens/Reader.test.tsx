import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
    render,
    waitFor,
    act,
    cleanup,
    fireEvent,
    screen,
    within,
} from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import Reader from "./Reader";
import type { Chapter, Comic, DownloadTaskView } from "../api";
import type { ProgressRecord } from "../lib/storage/progress";

// S4 seam：阅读器的阅读位置。记录的是「话内第几张图 + 图内位置」，进入时按它恢复，
// 不依赖虚拟器「测量值有变化」。

vi.mock("../api", () => ({
    crawl: vi.fn(),
    crawlCached: vi.fn(),
    getDownloads: vi.fn().mockResolvedValue([]),
    imgSrc: vi.fn((url: string) => url),
    listDownloaded: vi.fn().mockResolvedValue({}),
    setSystemBars: vi.fn().mockResolvedValue(undefined),
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

import { crawl, crawlCached, getDownloads, imgSrc, listDownloaded, setSystemBars } from "../api";
import { touchHistory } from "../lib/storage/history";
import { getProgress, setProgress } from "../lib/storage/progress";
import { ToastProvider } from "../components/toast";

const mockedCrawl = vi.mocked(crawl);
const mockedCrawlCached = vi.mocked(crawlCached);
const mockedGetDownloads = vi.mocked(getDownloads);
const mockedImgSrc = vi.mocked(imgSrc);
const mockedListDownloaded = vi.mocked(listDownloaded);
const mockedSetSystemBars = vi.mocked(setSystemBars);
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
    // mock 的实现不随 clearAllMocks 复位：上一个用例留下的下载清单与进度记录会漏进
    // 下一个（顺序一变就红），这里按各自的默认取值复位，用例再按需覆盖。
    mockedListDownloaded.mockResolvedValue({});
    mockedGetDownloads.mockResolvedValue([]);
    mockedProgress.mockResolvedValue(null);
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

/* ---------- 移动端的全屏阅读 ---------- */

/** test-setup 给 matchMedia 的桩恒为 false（useIsMobile 走窄屏判断）。 */
const realMatchMedia = window.matchMedia;

/** 窄屏：useIsMobile 读 matchMedia，这里换成按查询回答（窄屏查询为真）。 */
function stubMobile() {
    window.matchMedia = ((query: string) => ({
        matches: query.includes("max-width"),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
}

/** jsdom 没有布局：阅读区的宽度由 getBoundingClientRect 给（三分带按它算）。 */
function stubWidth(el: HTMLElement, width: number) {
    el.getBoundingClientRect = () =>
        ({
            left: 0,
            top: 0,
            right: width,
            bottom: 0,
            width,
            height: 0,
            x: 0,
            y: 0,
            toJSON: () => ({}),
        }) as DOMRect;
}

/** 顶栏（浮层）当前是否收着。 */
function chromeHidden(container: HTMLElement): boolean {
    const header = container.querySelector("header");
    if (!header) throw new Error("找不到阅读器顶栏");
    return header.className.includes("opacity-0");
}

describe("移动端的全屏阅读", () => {
    beforeEach(() => {
        // 虚拟器按元素 offsetHeight 取外层尺寸，jsdom 里恒为 0（页面挂不出来）
        Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
            get: () => VIEWPORT,
            configurable: true,
        });
        stubMobile();
    });

    afterEach(() => {
        window.matchMedia = realMatchMedia;
    });

    it("初始进入展示状态栏与导航栏", async () => {
        const { container } = renderReader();
        await waitFor(() => expect(contentHeight(container)).toBeGreaterThan(0));

        expect(mockedSetSystemBars).toHaveBeenCalledWith({
            hidden: false,
            lightIcons: true,
        });
        expect(chromeHidden(container)).toBe(false);
    });

    it("点左带翻上一页、点右带翻下一页（一屏一步）", async () => {
        const { container } = renderReader();
        await waitFor(() => expect(contentHeight(container)).toBeGreaterThan(0));
        const sc = scroller(container);
        stubGeometry(sc, contentHeight(container));
        stubWidth(sc, 300);

        sc.scrollTop = 1000;
        fireEvent.click(sc, { clientX: 290 });
        expect(sc.scrollTop).toBe(1000 + VIEWPORT);

        sc.scrollTop = 1000;
        fireEvent.click(sc, { clientX: 10 });
        expect(sc.scrollTop).toBe(1000 - VIEWPORT);
    });

    it("点中带切换沉浸式：系统栏隐藏，再点一次还原", async () => {
        const { container } = renderReader();
        await waitFor(() => expect(contentHeight(container)).toBeGreaterThan(0));
        const sc = scroller(container);
        stubGeometry(sc, contentHeight(container));
        stubWidth(sc, 300);

        mockedSetSystemBars.mockClear();
        fireEvent.click(sc, { clientX: 150 });
        await waitFor(() => expect(chromeHidden(container)).toBe(true));
        expect(mockedSetSystemBars).toHaveBeenCalledWith({
            hidden: true,
            lightIcons: true,
        });

        mockedSetSystemBars.mockClear();
        fireEvent.click(sc, { clientX: 150 });
        await waitFor(() => expect(chromeHidden(container)).toBe(false));
        expect(mockedSetSystemBars).toHaveBeenCalledWith({
            hidden: false,
            lightIcons: true,
        });
    });

    it("滑动进沉浸式，恢复阅读位置的那次滚动不算", async () => {
        const resolve = deferredProgress();
        const { container } = renderReader();
        await waitFor(() => expect(contentHeight(container)).toBeGreaterThan(0));
        const sc = scroller(container);
        stubGeometry(sc, contentHeight(container));

        // 恢复把那一处放回视口中心：不是用户滑的，状态栏留着
        await act(async () => {
            resolve({ chapterIndex: 1, pageIndex: 2, offsetInPage: 0.5, updatedAt: 1 });
        });
        // 落点要等页面量到高度（恢复自己会等下一帧）
        await waitFor(() => expect(sc.scrollTop).toBeGreaterThan(0));
        fireEvent.scroll(sc);
        expect(chromeHidden(container)).toBe(false);

        // 手指落下之后的滚动才是「开始阅读」
        fireEvent.pointerDown(sc);
        sc.scrollTop += 200;
        fireEvent.scroll(sc);
        await waitFor(() => expect(chromeHidden(container)).toBe(true));
    });
});

/* ---------- 阅读器的目录 ---------- */

/** 点顶栏的目录按钮，等面板出来。 */
async function openToc(): Promise<HTMLElement> {
    fireEvent.click(screen.getByRole("button", { name: "目录" }));
    return screen.findByRole("dialog", { name: "目录" });
}

/** 一条下载队列任务（只填目录面板用得到的字段）。 */
function downloadTask(
    chapterIndex: number,
    status: DownloadTaskView["status"],
): DownloadTaskView {
    return {
        taskId: `webtoons/webtoons-1/${chapterIndex}`,
        source: "webtoons",
        comicId: "webtoons-1",
        comicTitle: "测试作品",
        comicCover: "",
        chapterIndex,
        chapterTitle: `第 ${chapterIndex} 话`,
        status,
        done: 0,
        total: 10,
    };
}

/** 某一话那一行（面板里的话名与顶栏的当前话名同文，按角色限定在面板内找）。 */
function chapterRow(dialog: HTMLElement, title: string): HTMLElement {
    return within(dialog).getByRole("button", { name: new RegExp(title) });
}

describe("阅读器的目录", () => {
    it("列出全部章节，当前话标成当前", async () => {
        const { container } = renderReader();
        await waitFor(() => expect(contentHeight(container)).toBeGreaterThan(0));

        const dialog = await openToc();
        expect(within(dialog).getByText("第 1 话")).toBeTruthy();
        expect(within(dialog).getByText("第 2 话")).toBeTruthy();
        expect(chapterRow(dialog, "第 1 话").getAttribute("aria-current")).toBe("true");
        expect(chapterRow(dialog, "第 2 话").getAttribute("aria-current")).toBe(null);
        expect(within(dialog).getByText("共 2 话")).toBeTruthy();
    });

    it("已下载的话带对勾，队列里在途的话标出状态", async () => {
        mockedListDownloaded.mockResolvedValue({
            "1": [{ url: "https://img/0.jpg", path: "chapter_1/0.jpg" }],
        });
        mockedGetDownloads.mockResolvedValue([downloadTask(2, "queued")]);
        const { container } = renderReader();
        await waitFor(() => expect(contentHeight(container)).toBeGreaterThan(0));

        const dialog = await openToc();
        expect(within(dialog).getByRole("img", { name: "已下载" })).toBeTruthy();
        expect(within(dialog).getByText("排队中")).toBeTruthy();
        expect(within(dialog).getByText("共 2 话 · 已下载 1 话")).toBeTruthy();
    });

    it("只认这部作品的队列任务（别的作品同序号的话不算）", async () => {
        mockedGetDownloads.mockResolvedValue([
            { ...downloadTask(2, "downloading"), source: "mangadex", comicId: "别的作品" },
        ]);
        const { container } = renderReader();
        await waitFor(() => expect(contentHeight(container)).toBeGreaterThan(0));

        const dialog = await openToc();
        expect(within(dialog).queryByText("下载中")).toBe(null);
    });

    it("点另一话：从那一话重开，回到话首", async () => {
        const { container } = renderReader();
        await waitFor(() => expect(contentHeight(container)).toBeGreaterThan(0));
        const sc = scroller(container);
        stubGeometry(sc, contentHeight(container));
        sc.scrollTop = 2000;

        const dialog = await openToc();
        fireEvent.click(chapterRow(dialog, "第 2 话"));

        await waitFor(() =>
            expect(mockedCrawl).toHaveBeenCalledWith("images", "webtoons", {
                comicId: "webtoons-1",
                chapterIndex: 2,
            }),
        );
        expect(sc.scrollTop).toBe(0);
    });

    it("点正在读的这一话只回到话首，不重新取图", async () => {
        const { container } = renderReader();
        await waitFor(() => expect(contentHeight(container)).toBeGreaterThan(0));
        const sc = scroller(container);
        stubGeometry(sc, contentHeight(container));
        sc.scrollTop = 2000;
        mockedCrawl.mockClear();

        const dialog = await openToc();
        fireEvent.click(chapterRow(dialog, "第 1 话"));

        expect(sc.scrollTop).toBe(0);
        expect(mockedCrawl).not.toHaveBeenCalledWith(
            "images",
            expect.anything(),
            expect.anything(),
        );
    });

    it("没有章节时目录按钮不可用", async () => {
        mockedCrawlCached.mockResolvedValue({
            data: { comic: COMIC, chapters: [] },
            fetchedAt: Date.now(),
        } as unknown as Awaited<ReturnType<typeof crawlCached>>);
        const { container } = renderReader();
        await waitFor(() => expect(container.textContent).toContain("已经隐藏"));

        const button = screen.getByRole("button", { name: "目录" }) as HTMLButtonElement;
        expect(button.disabled).toBe(true);
    });
});
