import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Downloads from "./Downloads";
import type { DownloadTaskView } from "../api";

// S6 seam：下载页的组卡片。卡片主体进作品详情，右侧箭头管展开。

vi.mock("../api", () => ({
    subscribeDownloads: vi.fn().mockResolvedValue(undefined),
    unsubscribeDownloads: vi.fn().mockResolvedValue(undefined),
    getDownloads: vi.fn().mockResolvedValue([]),
    cancelDownload: vi.fn(),
    retryDownload: vi.fn(),
    clearDownloads: vi.fn(),
    imgSrc: (url: string) => url,
    DOWNLOADS_CHANGED_EVENT: "download://changed",
}));

vi.mock("@tauri-apps/api/core", () => ({
    Channel: class {
        onmessage: unknown = null;
    },
}));

vi.mock("@tauri-apps/api/event", () => ({
    listen: vi.fn().mockResolvedValue(() => {}),
}));

import { getDownloads } from "../api";

const mockedDownloads = vi.mocked(getDownloads);

function task(chapterIndex: number): DownloadTaskView {
    return {
        taskId: `webtoons:c1:${chapterIndex}`,
        status: "done",
        done: 3,
        total: 3,
        source: "webtoons",
        comicId: "c1",
        comicTitle: "作品甲",
        comicCover: "",
        chapterIndex,
        chapterTitle: `第 ${chapterIndex} 话`,
    };
}

function renderDownloads() {
    return render(
        <MemoryRouter initialEntries={["/downloads"]}>
            <Routes>
                <Route path="/downloads" element={<Downloads />} />
                <Route path="/comic/:source/:comicId" element={<div>作品详情</div>} />
            </Routes>
        </MemoryRouter>,
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    mockedDownloads.mockResolvedValue([task(1)]);
});

afterEach(() => {
    cleanup();
});

describe("下载页的组卡片", () => {
    it("点作品标题进作品详情", async () => {
        renderDownloads();
        await waitFor(() => expect(screen.getByText("作品甲")).toBeTruthy());

        fireEvent.click(screen.getByText("作品甲").closest("a")!);

        await waitFor(() => expect(screen.getByText("作品详情")).toBeTruthy());
    });

    it("点右侧箭头展开章节，不跳转", async () => {
        renderDownloads();
        await waitFor(() => expect(screen.getByText("作品甲")).toBeTruthy());

        fireEvent.click(screen.getByRole("button", { name: "展开章节" }));

        expect(await screen.findByText("第 1 话")).toBeTruthy();
        expect(screen.queryByText("作品详情")).toBeNull();
    });
});
