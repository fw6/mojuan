import { describe, it, expect, beforeEach, vi } from "vitest";

// 移动端存储层（wayfinder #31）：mock plugin-fs 四个函数，内存文件系统。

vi.mock("@tauri-apps/plugin-fs", async () => (await import("./test-doubles")).fsPlugin);

import { getStore } from "./fs";
import { fsFiles, fsPlugin, resetDoubles } from "./test-doubles";

beforeEach(() => {
    resetDoubles();
});

describe("storage/fs（移动端存储层，wayfinder #31）", () => {
    it("set/get/has/entries：首启空对象，写入后读回", async () => {
        const s = getStore("progress.json");
        await expect(s.get("a")).resolves.toBeUndefined();
        await s.set("k", { v: 1 });
        await expect(s.get("k")).resolves.toEqual({ v: 1 });
        await expect(s.has("k")).resolves.toBe(true);
        await expect(s.entries()).resolves.toEqual([["k", { v: 1 }]]);
        // 写盘调用：recursive mkdir 建 bootstrap 子目录（顺带建 appDataDir，fs scope 只放行子路径）+ writeTextFile 写入文件
        expect(fsPlugin.mkdir).toHaveBeenCalledWith(
            "mojuan",
            expect.objectContaining({ recursive: true }),
        );
        expect(fsPlugin.writeTextFile).toHaveBeenCalledWith(
            "progress.json",
            JSON.stringify({ k: { v: 1 } }),
            expect.anything(),
        );
    });

    it("delete/clear 后 get 为空；delete 不存在的 key 返回 false", async () => {
        const s = getStore("favorites.json");
        await s.set("a", 1);
        await expect(s.delete("missing")).resolves.toBe(false);
        await expect(s.delete("a")).resolves.toBe(true);
        await expect(s.has("a")).resolves.toBe(false);
        await s.clear();
        await expect(s.entries()).resolves.toEqual([]);
    });

    it("损坏的 JSON 回退空对象，不抛错", async () => {
        fsFiles.set("broken.json", "{not json");
        const s = getStore("broken.json");
        await expect(s.entries()).resolves.toEqual([]);
    });

    it("save 是兼容占位（fs 已即时写入磁盘）", async () => {
        const s = getStore("settings.json");
        await expect(s.save()).resolves.toBeUndefined();
    });
});
