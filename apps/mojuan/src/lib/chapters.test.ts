import { describe, it, expect } from "vitest";
import { filterExternalChapters } from "./chapters";
import type { Chapter } from "../api";

const chapter = (index: number, external: boolean): Chapter => ({
    index,
    title: `第 ${index} 话`,
    pages: external ? [] : ["a.jpg"],
    external,
    downloaded: false,
    read: false,
});

describe("filterExternalChapters（external 标记 = 外链章节，一律过滤）", () => {
    it("过滤 external 章节，保留正常章节", () => {
        const input = [chapter(1, false), chapter(2, true), chapter(3, false)];
        expect(filterExternalChapters(input).map((c) => c.index)).toEqual([1, 3]);
    });

    it("空输入返回空", () => {
        expect(filterExternalChapters([])).toEqual([]);
    });

    it("全为外链时返回空（Detail 显示空态）", () => {
        expect(filterExternalChapters([chapter(1, true), chapter(2, true)])).toEqual([]);
    });

    it("全部正常时原样返回（不重排）", () => {
        const input = [chapter(2, false), chapter(1, false)];
        expect(filterExternalChapters(input).map((c) => c.index)).toEqual([2, 1]);
    });
});
