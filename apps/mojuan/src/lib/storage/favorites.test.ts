import { describe, it, expect, beforeEach, vi } from "vitest";

// S3 seam：收藏域。mock 插件层，验证切换与跨源隔离。

vi.mock("@tauri-apps/plugin-store", async () => (await import("./test-doubles")).storePlugin);

import { getFavorites, isFavorite, removeFavorite, toggleFavorite } from "./favorites";
import { resetDoubles, testComic } from "./test-doubles";

beforeEach(() => {
    resetDoubles();
});

describe("收藏 favorites", () => {
    it("toggle 添加再移除，返回切换后状态", async () => {
        await expect(toggleFavorite(testComic("a"))).resolves.toBe(true);
        await expect(isFavorite("mangadex", "a")).resolves.toBe(true);
        await expect(getFavorites()).resolves.toHaveLength(1);
        await expect(toggleFavorite(testComic("a"))).resolves.toBe(false);
        await expect(isFavorite("mangadex", "a")).resolves.toBe(false);
        await expect(getFavorites()).resolves.toHaveLength(0);
    });

    it("remove 只删掉指定那一条，其余不动", async () => {
        await toggleFavorite(testComic("a"));
        await toggleFavorite(testComic("b"));
        await removeFavorite("mangadex", "a");
        const left = await getFavorites();
        expect(left.map((c) => c.id)).toEqual(["b"]);
    });

    it("不同源同 id 互不冲突", async () => {
        await toggleFavorite(testComic("a", "mangadex"));
        await toggleFavorite(testComic("a", "webtoons"));
        await expect(getFavorites()).resolves.toHaveLength(2);
        await removeFavorite("mangadex", "a");
        const left = await getFavorites();
        expect(left.map((c) => c.source)).toEqual(["webtoons"]);
    });
});
