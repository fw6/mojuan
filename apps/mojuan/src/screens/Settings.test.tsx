import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import SettingsPage from "./Settings";
import { ToastProvider } from "../components/toast";
import type { Settings } from "../lib/storage/settings";

// S1 seam：设置页。mock 存储域、api 层与 Tauri 插件，验证「书架追更」开关的
// 默认状态、可访问名与写回设置。其余区块（源管理/备份/更新）只求渲染通过。

vi.mock("../api", () => ({
    mojuanVersion: vi.fn(),
    sourceErrors: vi.fn(),
    imgSrc: (url: string) => url,
    setImgProxyDownloadDir: vi.fn(),
    webdavGet: vi.fn(),
    webdavPut: vi.fn(),
    otaCheck: vi.fn(),
    otaDownload: vi.fn(),
    otaInstall: vi.fn(),
    otaCanInstall: vi.fn(),
    otaOpenInstallSettings: vi.fn(),
}));

vi.mock("../lib/storage/settings", () => ({
    getSettings: vi.fn(),
    setSettings: vi.fn(),
}));

vi.mock("../lib/storage/sources", () => ({
    getSources: vi.fn(),
    getOrder: vi.fn(),
    putSource: vi.fn(),
    putRuntime: vi.fn(),
    removeSource: vi.fn(),
    resyncSources: vi.fn(),
}));

vi.mock("../lib/storage/backup", () => ({
    exportBackupJson: vi.fn(),
    importBackupData: vi.fn(),
    parseBackupJson: vi.fn(),
}));

vi.mock("../lib/sources", () => ({
    SOURCES: [],
    sourceTitle: (id: string) => id,
}));

vi.mock("../lib/theme", () => ({
    useTheme: () => ({
        isDark: false,
        setDark: vi.fn(),
        toggle: vi.fn(),
        ready: true,
        resolvedTheme: "light",
        setTheme: vi.fn(),
    }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
    open: vi.fn(),
    confirm: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-updater", () => ({
    check: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-process", () => ({
    relaunch: vi.fn(),
}));

import { mojuanVersion, sourceErrors } from "../api";
import { getSettings, setSettings } from "../lib/storage/settings";
import { getSources, getOrder } from "../lib/storage/sources";

const mockedVersion = vi.mocked(mojuanVersion);
const mockedErrors = vi.mocked(sourceErrors);
const mockedGetSettings = vi.mocked(getSettings);
const mockedSetSettings = vi.mocked(setSettings);
const mockedSources = vi.mocked(getSources);
const mockedOrder = vi.mocked(getOrder);

function settings(over: Partial<Settings> = {}): Settings {
    return {
        downloadDir: "/mock/Downloads/mojuan",
        darkMode: false,
        autoTrim: false,
        followUpdate: true,
        lastSource: null,
        lastCategory: {},
        ...over,
    };
}

function renderSettings() {
    return render(
        <MemoryRouter>
            <ToastProvider>
                <SettingsPage />
            </ToastProvider>
        </MemoryRouter>,
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    mockedVersion.mockResolvedValue("test");
    mockedErrors.mockResolvedValue({});
    mockedGetSettings.mockResolvedValue(settings());
    mockedSetSettings.mockResolvedValue(undefined);
    mockedSources.mockResolvedValue({});
    mockedOrder.mockResolvedValue([]);
});

afterEach(() => {
    cleanup();
});

describe("设置页的「书架追更」开关", () => {
    it("默认开启，可访问名是书架追更", async () => {
        renderSettings();
        const sw = await screen.findByRole("switch", { name: "书架追更" });
        expect(sw.getAttribute("aria-checked")).toBe("true");
    });

    it("已保存为关闭时开关呈关闭", async () => {
        mockedGetSettings.mockResolvedValue(settings({ followUpdate: false }));
        renderSettings();
        const sw = await screen.findByRole("switch", { name: "书架追更" });
        expect(sw.getAttribute("aria-checked")).toBe("false");
    });

    it("关掉开关把新状态写回设置", async () => {
        renderSettings();
        const sw = await screen.findByRole("switch", { name: "书架追更" });
        fireEvent.click(sw);
        await waitFor(() =>
            expect(mockedSetSettings).toHaveBeenCalledWith({ followUpdate: false }),
        );
    });
});
