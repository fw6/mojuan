import { describe, it, expect, beforeEach, vi } from "vitest";

// S3 seam：设置域。mock 插件层，验证默认值、部分合并与浏览位置写入。

vi.mock("@tauri-apps/plugin-store", async () => (await import("./test-doubles")).storePlugin);
vi.mock("@tauri-apps/api/path", async () => (await import("./test-doubles")).pathPlugin);

import { resetDoubles } from "./test-doubles";
import { getSettings, rememberDiscovery, setSettings } from "./settings";

beforeEach(() => {
    resetDoubles();
});

describe("设置 settings", () => {
    it("未设置时返回默认值（下载目录 = ~/Downloads/mojuan）", async () => {
        await expect(getSettings()).resolves.toEqual({
            downloadDir: "/mock/Downloads/mojuan",
            darkMode: false,
            autoTrim: false,
            lastSource: null,
            lastCategory: {},
        });
    });

    it("部分更新与已有设置合并，不互相覆盖", async () => {
        await setSettings({ darkMode: true });
        await setSettings({ autoTrim: true });
        await expect(getSettings()).resolves.toEqual({
            downloadDir: "/mock/Downloads/mojuan",
            darkMode: true,
            autoTrim: true,
            lastSource: null,
            lastCategory: {},
        });
    });

    it("rememberDiscovery 记住浏览位置，不影响其他设置", async () => {
        await setSettings({ darkMode: true });
        await rememberDiscovery("webtoons");
        await rememberDiscovery("webtoons", "恋爱");
        await rememberDiscovery("mangadex", "动作");
        const s = await getSettings();
        expect(s.lastSource).toBe("mangadex");
        expect(s.lastCategory).toEqual({ webtoons: "恋爱", mangadex: "动作" });
        expect(s.darkMode).toBe(true);
    });
});
