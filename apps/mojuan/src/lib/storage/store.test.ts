import { describe, it, expect, beforeEach, vi } from "vitest";

// 存储层底层：跨域共用的键规则，以及桌面/移动端的平台切换。
// 桌面侧的实现（store 插件 + Store 单例）由各域测试覆盖（jsdom 的 UA 不含移动平台，
// 各域走的就是桌面分支）；这里补移动端分支——IS_MOBILE 在模块加载时求值，
// 所以先改 UA 再重新导入。

vi.mock("@tauri-apps/plugin-fs", async () => (await import("./test-doubles")).fsPlugin);

import { resetDoubles } from "./test-doubles";

beforeEach(() => {
    resetDoubles();
});

describe("平台切换（IS_MOBILE）", () => {
    it("移动端 UA：getStore 走 fs 版，写入直接写文件", async () => {
        vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
            "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36",
        );
        vi.resetModules();
        const doubles = await import("./test-doubles");
        const { getStore } = await import("./store");
        const store = await getStore("progress.json");
        await store.set("k", { v: 1 });
        expect(doubles.fsPlugin.writeTextFile).toHaveBeenCalledWith(
            "progress.json",
            JSON.stringify({ k: { v: 1 } }),
            expect.anything(),
        );
        vi.restoreAllMocks();
    });
});

describe("comicKey", () => {
    it("合成 (source, comicId) 跨域唯一键", async () => {
        const { comicKey } = await import("./store");
        expect(comicKey("webtoons", "abc")).toBe("webtoons:abc");
    });
});
