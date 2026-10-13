import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Library from "./Library";
import { ToastProvider } from "../components/toast";
import type { Comic, LocalComic } from "../api";

// S1 seam：书架页。mock 存储域与 api 层，验证三种列表的删除接线，
// 以及滑动行的内容外壳「拖过之后落下的点击不算点击」。

vi.mock("../api", () => ({
    scanLocal: vi.fn(),
    listDownloaded: vi.fn(),
    deleteDownloaded: vi.fn(),
    imgSrc: (url: string) => url,
}));

vi.mock("../lib/storage/favorites", () => ({
    getFavorites: vi.fn(),
    removeFavorite: vi.fn(),
}));

vi.mock("../lib/storage/history", () => ({
    getHistory: vi.fn(),
    removeHistory: vi.fn(),
}));

vi.mock("../lib/storage/settings", () => ({
    getSettings: vi.fn(),
}));

vi.mock("../lib/storage/store", () => ({
    comicKey: (source: string, id: string) => `${source}:${id}`,
}));

vi.mock("../lib/sources", () => ({
    sourceTitle: (id: string) => id,
}));

import { scanLocal, deleteDownloaded } from "../api";
import { getFavorites, removeFavorite } from "../lib/storage/favorites";
import { getHistory, removeHistory } from "../lib/storage/history";
import { getSettings } from "../lib/storage/settings";

const mockedScan = vi.mocked(scanLocal);
const mockedDeleteDownloaded = vi.mocked(deleteDownloaded);
const mockedFavorites = vi.mocked(getFavorites);
const mockedRemoveFavorite = vi.mocked(removeFavorite);
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
    mockedScan.mockResolvedValue([]);
    mockedSettings.mockResolvedValue({
        downloadDir: null,
        darkMode: false,
        autoTrim: false,
        lastSource: null,
        lastCategory: {},
    });
    mockedHistory.mockResolvedValue([
        { comic: comic("a"), chapterIndex: 3, lastReadAt: 2 },
        { comic: comic("b"), chapterIndex: 1, lastReadAt: 1 },
    ]);
});

afterEach(() => {
    cleanup();
});

describe("书架页的删除", () => {
    it("历史列表来自历史域，一行一部作品", async () => {
        renderLibrary();
        await waitFor(() => expect(screen.getByText("作品 a")).toBeTruthy());
        expect(screen.getByText("作品 b")).toBeTruthy();
        expect(screen.getByText("读到第 3 话")).toBeTruthy();
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
            { source: "webtoons", comicId: "c1", chapterCount: 2 },
            { source: "webtoons", comicId: "c2", chapterCount: 1 },
        ];
        mockedSettings.mockResolvedValue({
            downloadDir: "/mock/downloads",
            darkMode: false,
            autoTrim: false,
            lastSource: null,
            lastCategory: {},
        });
        mockedScan.mockResolvedValue(items);
        mockedDeleteDownloaded.mockResolvedValue(undefined);
        renderLibrary();
        await waitFor(() => expect(screen.getByText("作品 a")).toBeTruthy());

        fireEvent.click(screen.getByRole("tab", { name: /下载/ }));
        await waitFor(() => expect(screen.getByText("c1")).toBeTruthy());

        fireEvent.click(screen.getAllByRole("button", { name: "删除", hidden: true })[0]);

        await waitFor(() => expect(screen.queryByText("c1")).toBeNull());
        expect(mockedDeleteDownloaded).toHaveBeenCalledWith("/mock/downloads", "webtoons", "c1");
        expect(screen.getByText("c2")).toBeTruthy();
    });

    it("本地文件 tab 不提供删除（扫的是用户自己挑的文件夹）", async () => {
        renderLibrary();
        await waitFor(() => expect(screen.getByText("作品 a")).toBeTruthy());

        fireEvent.click(screen.getByRole("tab", { name: /本地文件/ }));
        await waitFor(() => expect(screen.getByText("选一个存着漫画的文件夹")).toBeTruthy());

        expect(screen.queryByRole("button", { name: "删除", hidden: true })).toBeNull();
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
