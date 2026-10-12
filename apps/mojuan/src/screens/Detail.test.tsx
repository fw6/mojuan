import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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

vi.mock("../lib/storage/progress", () => ({
    getProgress: vi.fn().mockResolvedValue(null),
}));

vi.mock("../lib/storage/settings", () => ({
    getSettings: vi.fn().mockResolvedValue({ downloadDir: null }),
}));

vi.mock("../lib/storage/sources", () => ({
    whenSourcesReady: vi.fn().mockResolvedValue(undefined),
    persistSourceCache: vi.fn().mockResolvedValue(undefined),
}));

import { crawl, crawlCached } from "../api";
import { ToastProvider } from "../components/toast";

const mockedCrawl = vi.mocked(crawl);
const mockedCached = vi.mocked(crawlCached);

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
});
