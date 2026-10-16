import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Library from "./Library";
import { ToastProvider } from "../components/toast";
import { PageActiveContext } from "../lib/page-active";
import type { Comic, LocalComic } from "../api";

// S1 seam：书架页。mock 存储域与 api 层，验证三种列表的删除接线，
// 以及滑动行的内容外壳「拖过之后落下的点击不算点击」。

vi.mock("../api", () => ({
    scanLocal: vi.fn(),
    listDownloaded: vi.fn(),
    readComicMeta: vi.fn(),
    deleteDownloaded: vi.fn(),
    imgSrc: (url: string) => url,
    FLAT_SOURCE: "local",
}));

vi.mock("../lib/storage/favorites", () => ({
    getFavorites: vi.fn(),
    removeFavorite: vi.fn(),
}));

vi.mock("../lib/storage/follow", () => ({
    getFollowStates: vi.fn(),
    removeFollowState: vi.fn(),
}));

vi.mock("../lib/storage/progress", () => ({
    getProgressAll: vi.fn(),
}));

vi.mock("../lib/follow-check", () => ({
    runFollowCheckNow: vi.fn(),
}));

vi.mock("../lib/storage/history", () => ({
    getHistory: vi.fn(),
    removeHistory: vi.fn(),
}));

vi.mock("../lib/storage/settings", () => ({
    getSettings: vi.fn(),
    DEFAULT_IMAGE_CACHE_LIMIT: 1024 * 1024 * 1024,
}));

vi.mock("../lib/storage/store", () => ({
    comicKey: (source: string, id: string) => `${source}:${id}`,
}));

vi.mock("../lib/sources", () => ({
    sourceTitle: (id: string) => id,
}));

import { scanLocal, deleteDownloaded, listDownloaded, readComicMeta } from "../api";
import { getFavorites, removeFavorite } from "../lib/storage/favorites";
import { getFollowStates, removeFollowState } from "../lib/storage/follow";
import { getProgressAll } from "../lib/storage/progress";
import { runFollowCheckNow } from "../lib/follow-check";
import { getHistory, removeHistory } from "../lib/storage/history";
import { DEFAULT_IMAGE_CACHE_LIMIT, getSettings } from "../lib/storage/settings";

const mockedScan = vi.mocked(scanLocal);
const mockedDeleteDownloaded = vi.mocked(deleteDownloaded);
const mockedListDownloaded = vi.mocked(listDownloaded);
const mockedReadComicMeta = vi.mocked(readComicMeta);
const mockedFavorites = vi.mocked(getFavorites);
const mockedRemoveFavorite = vi.mocked(removeFavorite);
const mockedFollowStates = vi.mocked(getFollowStates);
const mockedRemoveFollowState = vi.mocked(removeFollowState);
const mockedProgressAll = vi.mocked(getProgressAll);
const mockedRunCheck = vi.mocked(runFollowCheckNow);
const mockedHistory = vi.mocked(getHistory);
const mockedRemoveHistory = vi.mocked(removeHistory);
const mockedSettings = vi.mocked(getSettings);

function comic(id: string, source = "mangadex"): Comic {
    return {
        id,
        source,
        sourceTitle: source,
        title: `作品 ${id}`,
        author: "作者",
        intro: "",
        cover: "https://example.com/c.jpg",
        status: "serial",
        updateTime: "",
        lastChapter: "1",
        tags: [],
        lastReadChapter: 0,
        lastReadTime: 0,
    };
}

function renderLibrary() {
    return render(
        <MemoryRouter initialEntries={["/library"]}>
            <ToastProvider>
                <Routes>
                    <Route path="/library" element={<Library />} />
                    <Route path="/comic/:source/:comicId" element={<div>作品详情</div>} />
                </Routes>
            </ToastProvider>
        </MemoryRouter>,
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    mockedFavorites.mockResolvedValue([]);
    mockedFollowStates.mockResolvedValue({});
    mockedProgressAll.mockResolvedValue({});
    mockedRunCheck.mockResolvedValue({ updated: [], failures: [] });
    mockedRemoveFollowState.mockResolvedValue(undefined);
    mockedScan.mockResolvedValue([]);
    mockedListDownloaded.mockResolvedValue({});
    mockedReadComicMeta.mockResolvedValue(null);
    mockedSettings.mockResolvedValue({
        downloadDir: null,
        darkMode: false,
        autoTrim: false,
        followUpdate: true,
        lastSource: null,
        lastCategory: {},
        followCheckedAt: null,
        imageCacheLimit: DEFAULT_IMAGE_CACHE_LIMIT,
    });
    mockedHistory.mockResolvedValue([
        { comic: comic("a"), chapterIndex: 3, chapterTitle: "", lastReadAt: 2 },
        { comic: comic("b"), chapterIndex: 1, chapterTitle: "", lastReadAt: 1 },
    ]);
});

afterEach(() => {
    cleanup();
});

describe("书架页的删除", () => {
    it("书架只有历史、收藏、下载三个 tab", async () => {
        renderLibrary();
        await waitFor(() => expect(screen.getByText("作品 a")).toBeTruthy());
        expect(screen.getAllByRole("tab")).toHaveLength(3);
        expect(screen.queryByRole("tab", { name: /本地文件/ })).toBeNull();
    });

    it("历史列表来自历史域，一行一部作品", async () => {
        renderLibrary();
        await waitFor(() => expect(screen.getByText("作品 a")).toBeTruthy());
        expect(screen.getByText("作品 b")).toBeTruthy();
        expect(screen.getByText("读到 第 3 话")).toBeTruthy();
    });

    it("历史行显示章节标题，而不是源内部的话序号", async () => {
        // 漫画柜这类源的话序号是站内的章节 id（七八位数字），不是话名
        mockedHistory.mockResolvedValue([
            {
                comic: comic("a", "manhuagui"),
                chapterIndex: 1234567,
                chapterTitle: "第 117 话 决战",
                lastReadAt: 2,
            },
        ]);
        renderLibrary();
        await waitFor(() => expect(screen.getByText("读到 第 117 话 决战")).toBeTruthy());
        expect(screen.queryByText(/1234567/)).toBeNull();
    });

    it("点删除后历史记录消失，且只删这一条", async () => {
        // jsdom 不实现 inert，滑动轨道里的按钮可以直接点到（真机上要先滑动露出来）
        mockedRemoveHistory.mockResolvedValue(undefined);
        renderLibrary();
        await waitFor(() => expect(screen.getByText("作品 a")).toBeTruthy());

        fireEvent.click(screen.getAllByRole("button", { name: "删除", hidden: true })[0]);

        await waitFor(() => expect(screen.queryByText("作品 a")).toBeNull());
        expect(mockedRemoveHistory).toHaveBeenCalledWith("mangadex", "a");
        expect(screen.getByText("作品 b")).toBeTruthy();
    });

    it("收藏列表删除走收藏域", async () => {
        mockedFavorites.mockResolvedValue([comic("x"), comic("y")]);
        mockedRemoveFavorite.mockResolvedValue(undefined);
        renderLibrary();
        await waitFor(() => expect(screen.getByText("作品 a")).toBeTruthy());

        fireEvent.click(screen.getByRole("tab", { name: /收藏/ }));
        await waitFor(() => expect(screen.getByText("作品 x")).toBeTruthy());

        fireEvent.click(screen.getAllByRole("button", { name: "删除", hidden: true })[0]);

        await waitFor(() => expect(screen.queryByText("作品 x")).toBeNull());
        expect(mockedRemoveFavorite).toHaveBeenCalledWith("mangadex", "x");
        expect(screen.getByText("作品 y")).toBeTruthy();
    });

    it("下载列表删除走磁盘目录，并带上当前下载位置", async () => {
        const items: LocalComic[] = [
            {
                source: "webtoons",
                comicId: "c1",
                chapterCount: 2,
                title: "作品甲",
                cover: "https://x/a.jpg",
            },
            { source: "webtoons", comicId: "c2", chapterCount: 1, title: "", cover: "" },
        ];
        mockedSettings.mockResolvedValue({
            downloadDir: "/mock/downloads",
            darkMode: false,
            autoTrim: false,
            followUpdate: true,
            lastSource: null,
            lastCategory: {},
            followCheckedAt: null,
            imageCacheLimit: DEFAULT_IMAGE_CACHE_LIMIT,
        });
        mockedScan.mockResolvedValue(items);
        mockedDeleteDownloaded.mockResolvedValue(undefined);
        renderLibrary();
        await waitFor(() => expect(screen.getByText("作品 a")).toBeTruthy());

        fireEvent.click(screen.getByRole("tab", { name: /下载/ }));
        // 卡片显示下载时记下的作品标题；没有元数据的旧下载回落到 comicId
        await waitFor(() => expect(screen.getByText("作品甲")).toBeTruthy());
        expect(screen.getByText("c2")).toBeTruthy();

        fireEvent.click(screen.getAllByRole("button", { name: "删除", hidden: true })[0]);

        await waitFor(() => expect(screen.queryByText("作品甲")).toBeNull());
        expect(mockedDeleteDownloaded).toHaveBeenCalledWith("/mock/downloads", "webtoons", "c1");
        expect(screen.getByText("c2")).toBeTruthy();
    });

    it("下载列表展开后显示作品元数据里的话名，没有元数据时回落到话序号", async () => {
        mockedSettings.mockResolvedValue({
            downloadDir: "/mock/downloads",
            darkMode: false,
            autoTrim: false,
            followUpdate: true,
            lastSource: null,
            lastCategory: {},
            followCheckedAt: null,
            imageCacheLimit: DEFAULT_IMAGE_CACHE_LIMIT,
        });
        mockedScan.mockResolvedValue([
            {
                source: "webtoons",
                comicId: "c1",
                chapterCount: 2,
                title: "作品甲",
                cover: "",
            },
        ]);
        mockedListDownloaded.mockResolvedValue({
            "900001": [{ url: "https://x/0.jpg", path: "chapter_900001/0.jpg" }],
            "900002": [{ url: "https://x/1.jpg", path: "chapter_900002/0.jpg" }],
        });
        mockedReadComicMeta.mockResolvedValue({
            source: "webtoons",
            comicId: "c1",
            title: "作品甲",
            cover: "",
            chapters: { "900001": "第 1 话" },
        });
        renderLibrary();
        await waitFor(() => expect(screen.getByText("作品 a")).toBeTruthy());

        fireEvent.click(screen.getByRole("tab", { name: /下载/ }));
        await waitFor(() => expect(screen.getByText("作品甲")).toBeTruthy());
        fireEvent.click(screen.getByRole("button", { name: "展开章节" }));

        await waitFor(() => expect(screen.getByText("第 1 话")).toBeTruthy());
        expect(screen.getByText("第 900002 话")).toBeTruthy();
    });

    it("下载卡片能从作品标题进作品详情", async () => {
        mockedSettings.mockResolvedValue({
            downloadDir: "/mock/downloads",
            darkMode: false,
            autoTrim: false,
            followUpdate: true,
            lastSource: null,
            lastCategory: {},
            followCheckedAt: null,
            imageCacheLimit: DEFAULT_IMAGE_CACHE_LIMIT,
        });
        mockedScan.mockResolvedValue([
            {
                source: "webtoons",
                comicId: "c1",
                chapterCount: 1,
                title: "作品甲",
                cover: "",
            },
        ]);
        renderLibrary();
        await waitFor(() => expect(screen.getByText("作品 a")).toBeTruthy());

        fireEvent.click(screen.getByRole("tab", { name: /下载/ }));
        await waitFor(() => expect(screen.getByText("作品甲")).toBeTruthy());

        fireEvent.click(screen.getByText("作品甲").closest("a")!);

        await waitFor(() => expect(screen.getByText("作品详情")).toBeTruthy());
    });
});

describe("书架追更角标", () => {
    function followRecord(newChapterIndexes: number[]): {
        checkedAt: number;
        baseline: { index: number };
        newChapterIndexes: number[];
        needsRebuild: boolean;
    } {
        return {
            checkedAt: 1,
            baseline: { index: 5 },
            newChapterIndexes,
            needsRebuild: false,
        };
    }

    it("收藏卡片显示未读数，读完最新一话后当场归零", async () => {
        mockedFavorites.mockResolvedValue([comic("x")]);
        mockedFollowStates.mockResolvedValue({ "mangadex:x": followRecord([6, 7, 8]) });
        renderLibrary();
        await waitFor(() => expect(screen.getByText("作品 a")).toBeTruthy());

        fireEvent.click(screen.getByRole("tab", { name: /收藏/ }));
        await waitFor(() => expect(screen.getByText("作品 x")).toBeTruthy());
        expect(screen.getByText("3")).toBeTruthy();
    });

    it("进度读到最新一话后角标不显示", async () => {
        mockedFavorites.mockResolvedValue([comic("x")]);
        mockedFollowStates.mockResolvedValue({ "mangadex:x": followRecord([6, 7, 8]) });
        mockedProgressAll.mockResolvedValue({
            "mangadex:x": { chapterIndex: 8, pageIndex: 0, offsetInPage: 0, updatedAt: 1 },
        });
        renderLibrary();
        await waitFor(() => expect(screen.getByText("作品 a")).toBeTruthy());

        fireEvent.click(screen.getByRole("tab", { name: /收藏/ }));
        await waitFor(() => expect(screen.getByText("作品 x")).toBeTruthy());
        expect(screen.queryByText("3")).toBeNull();
    });

    it("未读数超过 99 显示 99+", async () => {
        mockedFavorites.mockResolvedValue([comic("x")]);
        mockedFollowStates.mockResolvedValue({
            "mangadex:x": followRecord(Array.from({ length: 150 }, (_, i) => i + 6)),
        });
        renderLibrary();
        await waitFor(() => expect(screen.getByText("作品 a")).toBeTruthy());

        fireEvent.click(screen.getByRole("tab", { name: /收藏/ }));
        await waitFor(() => expect(screen.getByText("作品 x")).toBeTruthy());
        expect(screen.getByText("99+")).toBeTruthy();
    });

    it("进入书架触发一次检查，带上收藏列表", async () => {
        mockedFavorites.mockResolvedValue([comic("x"), comic("y")]);
        renderLibrary();
        await waitFor(() =>
            expect(mockedRunCheck).toHaveBeenCalledWith([comic("x"), comic("y")]),
        );
    });

    it("页面回到前台时再检查一次，在后台不检查", async () => {
        function Harness({ active }: { active: boolean }) {
            return (
                <PageActiveContext.Provider value={active}>
                    <MemoryRouter initialEntries={["/library"]}>
                        <ToastProvider>
                            <Routes>
                                <Route path="/library" element={<Library />} />
                            </Routes>
                        </ToastProvider>
                    </MemoryRouter>
                </PageActiveContext.Provider>
            );
        }
        const { rerender } = render(<Harness active={true} />);
        await waitFor(() => expect(mockedRunCheck).toHaveBeenCalledTimes(1));

        rerender(<Harness active={false} />);
        expect(mockedRunCheck).toHaveBeenCalledTimes(1);

        rerender(<Harness active={true} />);
        await waitFor(() => expect(mockedRunCheck).toHaveBeenCalledTimes(2));
    });

    it("删除收藏同时删掉追更状态", async () => {
        mockedFavorites.mockResolvedValue([comic("x")]);
        mockedRemoveFavorite.mockResolvedValue(undefined);
        renderLibrary();
        await waitFor(() => expect(screen.getByText("作品 a")).toBeTruthy());

        fireEvent.click(screen.getByRole("tab", { name: /收藏/ }));
        await waitFor(() => expect(screen.getByText("作品 x")).toBeTruthy());
        fireEvent.click(screen.getAllByRole("button", { name: "删除", hidden: true })[0]);

        await waitFor(() => expect(mockedRemoveFollowState).toHaveBeenCalledWith("mangadex", "x"));
    });
});

describe("书架追更的失败呈现与手动刷新", () => {
    function Harness({ active }: { active: boolean }) {
        return (
            <PageActiveContext.Provider value={active}>
                <MemoryRouter initialEntries={["/library"]}>
                    <ToastProvider>
                        <Routes>
                            <Route path="/library" element={<Library />} />
                        </Routes>
                    </ToastProvider>
                </MemoryRouter>
            </PageActiveContext.Provider>
        );
    }

    it("页头显示「N 部未检查成功」，点开列出作品与原因", async () => {
        mockedFavorites.mockResolvedValue([comic("x")]);
        mockedRunCheck.mockResolvedValue({
            updated: [],
            failures: [
                {
                    source: "mangadex",
                    comicId: "x",
                    title: "作品 x",
                    reason: "fetch(detail): HTTP 500",
                },
                { source: "mangadex", comicId: "y", title: "作品 y", reason: "没有取到章节" },
            ],
        });
        renderLibrary();
        await waitFor(() => expect(screen.getByText("2 部未检查成功")).toBeTruthy());
        // 原因默认收着
        expect(screen.queryByText("fetch(detail): HTTP 500")).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: /2 部未检查成功/ }));

        expect(screen.getByText("作品 x")).toBeTruthy();
        expect(screen.getByText("fetch(detail): HTTP 500")).toBeTruthy();
        expect(screen.getByText("作品 y")).toBeTruthy();
        expect(screen.getByText("没有取到章节")).toBeTruthy();
    });

    it("失败提示在任意 tab 都可见", async () => {
        mockedFavorites.mockResolvedValue([comic("x")]);
        mockedRunCheck.mockResolvedValue({
            updated: [],
            failures: [{ source: "mangadex", comicId: "x", title: "作品 x", reason: "HTTP 500" }],
        });
        renderLibrary();
        await waitFor(() => expect(screen.getByText("1 部未检查成功")).toBeTruthy());

        fireEvent.click(screen.getByRole("tab", { name: /下载/ }));

        expect(screen.getByText("1 部未检查成功")).toBeTruthy();
    });

    it("被节流跳过的那一次不清空上一次的失败提示", async () => {
        mockedFavorites.mockResolvedValue([comic("x")]);
        mockedRunCheck.mockResolvedValueOnce({
            updated: [],
            failures: [{ source: "mangadex", comicId: "x", title: "作品 x", reason: "HTTP 500" }],
        });
        const { rerender } = render(<Harness active={true} />);
        await waitFor(() => expect(screen.getByText("1 部未检查成功")).toBeTruthy());

        // 第二次进书架被节流：结果为空，失败提示应当保留
        mockedRunCheck.mockResolvedValueOnce({ updated: [], failures: [] });
        rerender(<Harness active={false} />);
        rerender(<Harness active={true} />);
        await waitFor(() => expect(mockedRunCheck).toHaveBeenCalledTimes(2));

        expect(screen.getByText("1 部未检查成功")).toBeTruthy();
    });

    it("手动刷新带 manual 选项，不受节流限制", async () => {
        mockedFavorites.mockResolvedValue([comic("x")]);
        renderLibrary();
        await waitFor(() => expect(mockedRunCheck).toHaveBeenCalledTimes(1));

        fireEvent.click(screen.getByRole("button", { name: /刷新追更/ }));

        await waitFor(() =>
            expect(mockedRunCheck).toHaveBeenCalledWith([comic("x")], { manual: true }),
        );
    });
});

describe("滑动行的点击外壳", () => {
    it("没拖动时点行进入作品详情", async () => {
        renderLibrary();
        await waitFor(() => expect(screen.getByText("作品 a")).toBeTruthy());

        fireEvent.click(screen.getByText("作品 a").closest("a")!);

        await waitFor(() => expect(screen.getByText("作品详情")).toBeTruthy());
    });

    it("横向拖过之后落下的那一次点击不触发跳转", async () => {
        renderLibrary();
        await waitFor(() => expect(screen.getByText("作品 a")).toBeTruthy());

        const link = screen.getByText("作品 a").closest("a")!;
        fireEvent.pointerDown(link, { clientX: 100, clientY: 100 });
        fireEvent.pointerMove(link, { clientX: 140, clientY: 100 });
        fireEvent.click(link);

        expect(screen.queryByText("作品详情")).toBeNull();
    });
});
