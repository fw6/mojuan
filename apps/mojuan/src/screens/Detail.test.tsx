import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Detail from "./Detail";
import type { Chapter, Comic } from "../api";

// vitest 不开 globals（vite.config.ts：#10 seam 测试显式 import）→ RTL 不会自动
// cleanup，DOM 会跨用例泄漏。手动在 afterEach 清理。

// S5 seam：详情页的加载态与错误呈现。抓取走 useCrawl（缓存先上屏、再拉最新），
// 这里验证「有缓存但刷新失败」时缓存内容不被整页错误顶掉。

vi.mock("../api", () => ({
    crawl: vi.fn(),
    crawlCached: vi.fn(),
    sourceErrors: vi.fn().mockResolvedValue({}),
    listDownloaded: vi.fn().mockResolvedValue({}),
    enqueueDownload: vi.fn(),
    imgSrc: (url: string) => url,
}));

vi.mock("../lib/storage/favorites", () => ({
    isFavorite: vi.fn().mockResolvedValue(false),
    toggleFavorite: vi.fn(),
}));

vi.mock("../lib/storage/follow", () => ({
    getFollowState: vi.fn().mockResolvedValue(null),
    setFollowState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/storage/progress", () => ({
    getProgress: vi.fn().mockResolvedValue(null),
}));

vi.mock("../lib/storage/settings", () => ({
    getSettings: vi.fn().mockResolvedValue({ downloadDir: null }),
}));

vi.mock("../lib/storage/comics", () => ({
    getKnownComic: vi.fn().mockResolvedValue(null),
}));

vi.mock("../lib/storage/sources", () => ({
    whenSourcesReady: vi.fn().mockResolvedValue(undefined),
    persistSourceCache: vi.fn().mockResolvedValue(undefined),
}));

import { crawl, crawlCached } from "../api";
import { getKnownComic } from "../lib/storage/comics";
import { toggleFavorite } from "../lib/storage/favorites";
import { getFollowState, setFollowState } from "../lib/storage/follow";
import { getProgress } from "../lib/storage/progress";
import { ToastProvider } from "../components/toast";

const mockedCrawl = vi.mocked(crawl);
const mockedCached = vi.mocked(crawlCached);
const mockedKnown = vi.mocked(getKnownComic);
const mockedToggleFavorite = vi.mocked(toggleFavorite);
const mockedGetFollow = vi.mocked(getFollowState);
const mockedSetFollow = vi.mocked(setFollowState);
const mockedProgress = vi.mocked(getProgress);

const COMIC: Comic = {
    id: "webtoons-1",
    source: "webtoons",
    sourceTitle: "Webtoons",
    title: "测试作品",
    author: "",
    intro: "",
    cover: "https://example.com/cover.jpg",
    status: "serial",
    updateTime: "",
    lastChapter: "",
    tags: [],
    lastReadChapter: 0,
    lastReadTime: 0,
};

function chapter(index: number, opts: Partial<Chapter> = {}): Chapter {
    return {
        index,
        title: `第 ${index} 话`,
        pages: [],
        external: false,
        downloaded: false,
        read: false,
        ...opts,
    };
}

function renderDetail() {
    return render(
        <MemoryRouter initialEntries={["/comic/webtoons/webtoons-1"]}>
            <ToastProvider>
                <Routes>
                    <Route path="/comic/:source/:comicId" element={<Detail />} />
                </Routes>
            </ToastProvider>
        </MemoryRouter>,
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    mockedCached.mockResolvedValue(null);
    mockedKnown.mockResolvedValue(null);
    mockedProgress.mockResolvedValue(null);
    mockedGetFollow.mockResolvedValue(null);
    mockedToggleFavorite.mockResolvedValue(false);
    mockedSetFollow.mockResolvedValue(undefined);
    mockedCrawl.mockResolvedValue({ comic: COMIC, chapters: [chapter(1)] });
});

afterEach(() => {
    cleanup();
});

describe("Detail 详情页", () => {
    it("正常加载：显示作品与章节，没有错误横幅", async () => {
        renderDetail();
        expect(await screen.findByText("测试作品")).toBeTruthy();
        expect(screen.getByText("第 1 话")).toBeTruthy();
        expect(screen.queryByText(/加载失败/)).toBeNull();
    });

    it("书架里记着这部作品时，抓取还没回来就先把作品信息渲染出来", async () => {
        mockedKnown.mockResolvedValue({ ...COMIC, title: "书架里的标题" });
        mockedCrawl.mockImplementation(() => new Promise(() => {}));
        renderDetail();
        expect(await screen.findByText("书架里的标题")).toBeTruthy();
        // 章节还没取到：不能按「这部作品没有章节」渲染
        expect(screen.queryByText("没有可看的章节")).toBeNull();
        expect(screen.getAllByText("正在加载章节").length).toBeGreaterThan(0);
    });

    it("没有缓存且抓取失败：只显示错误横幅与重试", async () => {
        mockedCrawl.mockRejectedValue(new Error("fetch(detail): HTTP 404\n@1:2"));
        renderDetail();
        expect(await screen.findByText(/加载失败：fetch\(detail\): HTTP 404/)).toBeTruthy();
        expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
        expect(screen.queryByText("正在加载作品信息")).toBeNull();
    });

    it("有缓存但刷新失败：缓存的作品与章节照常显示，横幅挂在页面上", async () => {
        mockedCached.mockResolvedValue({
            data: { comic: COMIC, chapters: [chapter(1), chapter(2)] },
            fetchedAt: 0,
        });
        mockedCrawl.mockRejectedValue(new Error("fetch(detail): HTTP 500\n@1:2"));
        renderDetail();
        expect(await screen.findByText(/加载失败：fetch\(detail\): HTTP 500/)).toBeTruthy();
        expect(screen.getByText("测试作品")).toBeTruthy();
        expect(screen.getByText("第 1 话")).toBeTruthy();
    });

    it("继续阅读显示进度记录里的话名，而不是源内部的话序号", async () => {
        // 漫画柜这类源的话序号是站内的章节 id（七八位数字），不是话名
        mockedProgress.mockResolvedValue({
            chapterIndex: 1234567,
            chapterTitle: "第 117 话 决战",
            pageIndex: 0,
            offsetInPage: 0,
            updatedAt: 1,
        });
        mockedCrawl.mockResolvedValue({
            comic: COMIC,
            chapters: [{ ...chapter(1234567), title: "章节表里的另一个名字" }],
        });
        renderDetail();
        expect(await screen.findByText("继续阅读 第 117 话 决战")).toBeTruthy();
    });

    it("旧进度记录没有话名时，从章节表里按序号取话名", async () => {
        mockedProgress.mockResolvedValue({
            chapterIndex: 7,
            pageIndex: 0,
            offsetInPage: 0,
            updatedAt: 1,
        });
        mockedCrawl.mockResolvedValue({
            comic: COMIC,
            chapters: [{ ...chapter(7), title: "第七话 相遇" }],
        });
        renderDetail();
        expect(await screen.findByText("继续阅读 第七话 相遇")).toBeTruthy();
    });

    it("收藏一部没有进度的作品：基线取章节表最后一话（外链不算）", async () => {
        mockedToggleFavorite.mockResolvedValue(true);
        mockedCrawl.mockResolvedValue({
            comic: COMIC,
            chapters: [chapter(1), chapter(2), { ...chapter(3), external: true }],
        });
        renderDetail();
        expect(await screen.findByText("第 2 话")).toBeTruthy();

        fireEvent.click(screen.getByRole("button", { name: /收藏/ }));

        await waitFor(() =>
            expect(mockedSetFollow).toHaveBeenCalledWith("webtoons", "webtoons-1", {
                checkedAt: expect.any(Number),
                baseline: { index: 2, title: "第 2 话" },
                newChapterIndexes: [],
                needsRebuild: false,
            }),
        );
    });

    it("收藏一部已有进度的作品：基线取进度记录", async () => {
        mockedToggleFavorite.mockResolvedValue(true);
        mockedProgress.mockResolvedValue({
            chapterIndex: 7,
            chapterTitle: "第七话 相遇",
            pageIndex: 0,
            offsetInPage: 0,
            updatedAt: 1,
        });
        mockedCrawl.mockResolvedValue({
            comic: COMIC,
            chapters: [chapter(7), chapter(8)],
        });
        renderDetail();
        expect(await screen.findByText("第 8 话")).toBeTruthy();

        fireEvent.click(screen.getByRole("button", { name: /收藏/ }));

        await waitFor(() =>
            expect(mockedSetFollow).toHaveBeenCalledWith("webtoons", "webtoons-1", {
                checkedAt: expect.any(Number),
                baseline: { index: 7, title: "第七话 相遇" },
                newChapterIndexes: [],
                needsRebuild: false,
            }),
        );
    });

    it("取消收藏时不写追更状态", async () => {
        mockedToggleFavorite.mockResolvedValue(false);
        renderDetail();
        expect(await screen.findByText("第 1 话")).toBeTruthy();

        fireEvent.click(screen.getByRole("button", { name: /收藏/ }));

        await waitFor(() => expect(mockedToggleFavorite).toHaveBeenCalled());
        expect(mockedSetFollow).not.toHaveBeenCalled();
    });

    it("追更基线失配（待重建）时，打开详情页即以当前进度重建基线", async () => {
        mockedGetFollow.mockResolvedValue({
            checkedAt: 1,
            baseline: { index: 500, title: "第五百话" },
            newChapterIndexes: [],
            needsRebuild: true,
        });
        // 源改版：进度里的旧序号在新表里不存在，靠话名落到新表那一话
        mockedProgress.mockResolvedValue({
            chapterIndex: 500,
            chapterTitle: "第二话",
            pageIndex: 0,
            offsetInPage: 0,
            updatedAt: 1,
        });
        mockedCrawl.mockResolvedValue({
            comic: COMIC,
            chapters: [chapter(101, { title: "第一话" }), chapter(102, { title: "第二话" })],
        });
        renderDetail();

        await waitFor(() =>
            expect(mockedSetFollow).toHaveBeenCalledWith("webtoons", "webtoons-1", {
                checkedAt: expect.any(Number),
                baseline: { index: 102, title: "第二话" },
                newChapterIndexes: [],
                needsRebuild: false,
            }),
        );
    });

    it("待重建且进度在新表里也落不到时，基线落到最后一话（不显示积压）", async () => {
        mockedGetFollow.mockResolvedValue({
            checkedAt: 1,
            baseline: { index: 500, title: "第五百话" },
            newChapterIndexes: [],
            needsRebuild: true,
        });
        mockedProgress.mockResolvedValue({
            chapterIndex: 500,
            chapterTitle: "第五百话",
            pageIndex: 0,
            offsetInPage: 0,
            updatedAt: 1,
        });
        mockedCrawl.mockResolvedValue({
            comic: COMIC,
            chapters: [chapter(1), chapter(2), chapter(3)],
        });
        renderDetail();

        await waitFor(() =>
            expect(mockedSetFollow).toHaveBeenCalledWith("webtoons", "webtoons-1", {
                checkedAt: expect.any(Number),
                baseline: { index: 3, title: "第 3 话" },
                newChapterIndexes: [],
                needsRebuild: false,
            }),
        );
    });
});
