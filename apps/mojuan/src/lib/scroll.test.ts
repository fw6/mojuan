import { describe, it, expect } from "vitest";
import { nearBottomByPx, pageIndexAt, offsetWithinPage } from "./scroll";

describe("nearBottomByPx（距底部不足提前量时预取下一话）", () => {
    it("距底部超过提前量返回 false", () => {
        // 4000 - (100 + 800) = 3100 > 1600
        expect(nearBottomByPx(100, 800, 4000, 1600)).toBe(false);
    });

    it("距底部不足提前量返回 true", () => {
        // 4000 - (2400 + 800) = 800 <= 1600
        expect(nearBottomByPx(2400, 800, 4000, 1600)).toBe(true);
    });

    it("刚好等于提前量返回 true", () => {
        // 4000 - (1600 + 800) = 1600
        expect(nearBottomByPx(1600, 800, 4000, 1600)).toBe(true);
    });

    it("内容未溢出视口视为在底部", () => {
        expect(nearBottomByPx(0, 800, 600, 1600)).toBe(true);
        expect(nearBottomByPx(0, 800, 800, 1600)).toBe(true);
    });
});

describe("pageIndexAt（视口中心所在页）", () => {
    it("heights 为空返回 0", () => {
        expect(pageIndexAt(500, [])).toBe(0);
    });

    it("按累计高度定位页面", () => {
        const heights = [100, 100, 100];
        expect(pageIndexAt(0, heights)).toBe(0);
        expect(pageIndexAt(99, heights)).toBe(0);
        expect(pageIndexAt(100, heights)).toBe(1); // 边界归属下一页
        expect(pageIndexAt(250, heights)).toBe(2);
    });

    it("超出总高取最后一页", () => {
        expect(pageIndexAt(9999, [100, 100])).toBe(1);
    });
});

describe("offsetWithinPage（视口中心在页内的位置 0..1）", () => {
    const heights = [100, 100, 100, 100];

    it("按该页的起点与高度算比例", () => {
        // 第 2 页起于 200、高 100；中心 250 → 页内 50/100
        expect(offsetWithinPage(250, heights, 2)).toBe(0.5);
        expect(offsetWithinPage(200, heights, 2)).toBe(0);
        expect(offsetWithinPage(299, heights, 2)).toBeCloseTo(0.99);
    });

    it("越出该页范围钳制到 0/1", () => {
        expect(offsetWithinPage(0, heights, 2)).toBe(0);
        expect(offsetWithinPage(9999, heights, 2)).toBe(1);
    });

    it("页高为 0 返回 0（未测出高度）", () => {
        expect(offsetWithinPage(50, [0, 0], 0)).toBe(0);
        expect(offsetWithinPage(50, [], 0)).toBe(0);
    });
});
