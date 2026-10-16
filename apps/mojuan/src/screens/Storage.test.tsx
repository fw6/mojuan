import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import StoragePage from "./Storage";
import type { Settings } from "../lib/storage/settings";

// S1 seam：存储页。mock api 层与存储域，验证顶部三项占用、两个清空按钮与上限下拉；
// 下面的下载管理由后续工单填上，这里只测顶部这块。

vi.mock("../api", () => ({
    storageUsage: vi.fn(),
    clearImageCache: vi.fn(),
    clearResultCache: vi.fn(),
    setImageCacheLimit: vi.fn(),
}));

vi.mock("../lib/storage/settings", () => ({
    getSettings: vi.fn(),
    setSettings: vi.fn(),
}));

import { storageUsage, clearResultCache, setImageCacheLimit } from "../api";
import { getSettings, setSettings } from "../lib/storage/settings";

const mockedUsage = vi.mocked(storageUsage);
const mockedClearResult = vi.mocked(clearResultCache);
const mockedSetLimit = vi.mocked(setImageCacheLimit);
const mockedGetSettings = vi.mocked(getSettings);
const mockedSetSettings = vi.mocked(setSettings);

const GB = 1024 * 1024 * 1024;

function settings(): Settings {
    return {
        downloadDir: "/mock/Downloads/mojuan",
        darkMode: false,
        autoTrim: false,
        followUpdate: true,
        lastSource: null,
        lastCategory: {},
        followCheckedAt: null,
        imageCacheLimit: GB,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockedGetSettings.mockResolvedValue(settings());
    mockedSetSettings.mockResolvedValue(undefined);
    mockedUsage.mockResolvedValue({
        image: { bytes: GB, count: 5 },
        result: { bytes: 2 * 1024 * 1024, count: 12 },
        download: { bytes: 3 * GB, count: 4 },
    });
    mockedClearResult.mockResolvedValue(undefined);
    mockedSetLimit.mockResolvedValue(undefined);
});

afterEach(() => {
    cleanup();
});

describe("存储页顶部", () => {
    it("显示三项占用与两个清空按钮", async () => {
        render(
            <MemoryRouter>
                <StoragePage />
            </MemoryRouter>,
        );
        expect(await screen.findByText("图片缓存")).toBeTruthy();
        expect(screen.getByText("结果缓存")).toBeTruthy();
        expect(screen.getByText("下载")).toBeTruthy();
        expect(await screen.findByText("1.0 GB")).toBeTruthy();
        expect(screen.getByRole("button", { name: "清空图片缓存" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "清空结果缓存" })).toBeTruthy();
        expect(mockedUsage).toHaveBeenCalledWith("/mock/Downloads/mojuan");
    });

    it("清空结果缓存会调用命令并重新取数", async () => {
        render(
            <MemoryRouter>
                <StoragePage />
            </MemoryRouter>,
        );
        const button = await screen.findByRole("button", { name: "清空结果缓存" });
        mockedUsage.mockClear();
        fireEvent.click(button);
        await waitFor(() => expect(mockedClearResult).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(mockedUsage).toHaveBeenCalledTimes(1));
    });

    it("改上限写进设置并推给 Rust 命令", async () => {
        render(
            <MemoryRouter>
                <StoragePage />
            </MemoryRouter>,
        );
        const select = await screen.findByLabelText("图片缓存上限");
        fireEvent.change(select, { target: { value: String(2 * GB) } });
        await waitFor(() =>
            expect(mockedSetSettings).toHaveBeenCalledWith({ imageCacheLimit: 2 * GB }),
        );
        expect(mockedSetLimit).toHaveBeenCalledWith(2 * GB);
    });
});
