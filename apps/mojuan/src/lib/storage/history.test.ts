import { describe, it, expect, beforeEach, vi } from "vitest";

// S3 seam：历史域。mock 插件层，验证最近阅读排序与重读上移。

vi.mock("@tauri-apps/plugin-store", async () => (await import("./test-doubles")).storePlugin);

import { getHistory, removeHistory, touchHistory } from "./history";
import { resetDoubles, testComic } from "./test-doubles";

beforeEach(() => {
    resetDoubles();
});

describe("历史 history", () => {
    it("touch 记录漫画+章节+话名，按最近阅读倒序", async () => {
        await touchHistory(testComic("a"), 1, "第 1 话");
        await touchHistory(testComic("b"), 2, "第 2 话");
        const list = await getHistory();
        expect(list.map((r) => r.comic.id)).toEqual(["b", "a"]);
        expect(list[0].chapterTitle).toBe("第 2 话");
    });

    it("重读同一漫画移到最前并更新章节", async () => {
        await touchHistory(testComic("a"), 1, "第 1 话");
        await touchHistory(testComic("b"), 2, "第 2 话");
        await touchHistory(testComic("a"), 5, "第 5 话");
        const list = await getHistory();
        expect(list.map((r) => r.comic.id)).toEqual(["a", "b"]);
        expect(list[0].chapterIndex).toBe(5);
        expect(list[0].chapterTitle).toBe("第 5 话");
    });

    it("remove 删掉一条，再读同一部会重新记下", async () => {
        await touchHistory(testComic("a"), 1, "第 1 话");
        await touchHistory(testComic("b"), 2, "第 2 话");
        await removeHistory("mangadex", "a");
        expect((await getHistory()).map((r) => r.comic.id)).toEqual(["b"]);

        await touchHistory(testComic("a"), 3, "第 3 话");
        const list = await getHistory();
        expect(list.map((r) => r.comic.id)).toEqual(["a", "b"]);
        expect(list[0].chapterIndex).toBe(3);
    });
});
