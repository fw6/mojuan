import { describe, it, expect, beforeEach, vi } from "vitest";

// S3 seam：历史域。mock 插件层，验证最近阅读排序与重读上移。

vi.mock("@tauri-apps/plugin-store", async () => (await import("./test-doubles")).storePlugin);

import { getHistory, touchHistory } from "./history";
import { resetDoubles, testComic } from "./test-doubles";

beforeEach(() => {
    resetDoubles();
});

describe("历史 history", () => {
    it("touch 记录漫画+章节，按最近阅读倒序", async () => {
        await touchHistory(testComic("a"), 1);
        await touchHistory(testComic("b"), 2);
        const list = await getHistory();
        expect(list.map((r) => r.comic.id)).toEqual(["b", "a"]);
    });

    it("重读同一漫画移到最前并更新章节", async () => {
        await touchHistory(testComic("a"), 1);
        await touchHistory(testComic("b"), 2);
        await touchHistory(testComic("a"), 5);
        const list = await getHistory();
        expect(list.map((r) => r.comic.id)).toEqual(["a", "b"]);
        expect(list[0].chapterIndex).toBe(5);
    });
});
