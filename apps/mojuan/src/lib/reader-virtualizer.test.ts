import { describe, expect, it, vi } from "vitest";

// 虚拟器适配面：把稀疏的 measurementsCache 变成位置模块要的形状。

import { virtualizerAdapter, type MeasuredVirtualizer } from "./reader-virtualizer";

function fake(measurements: MeasuredVirtualizer["measurementsCache"]) {
    const scrollToOffset = vi.fn();
    return { adapter: virtualizerAdapter({ measurementsCache: measurements, scrollToOffset }), scrollToOffset };
}

describe("virtualizerAdapter", () => {
    it("页高按原值给，稀疏的空洞归 0（累加时不会得 NaN）", () => {
        const { adapter } = fake([{ start: 0, size: 100 }, undefined, { start: 300, size: 250 }]);
        expect(adapter.sizes()).toEqual([100, 0, 250]);
    });

    it("非数值的高度同样归 0", () => {
        const { adapter } = fake([
            { start: 0, size: Number.NaN },
            { start: 100, size: Number.POSITIVE_INFINITY },
        ]);
        expect(adapter.sizes()).toEqual([0, 0]);
    });

    it("entryAt 给起点与高度；空洞或量不到数值时返回 null", () => {
        const { adapter } = fake([
            { start: 0, size: 100 },
            undefined,
            { start: 300, size: Number.NaN },
        ]);
        expect(adapter.entryAt(0)).toEqual({ start: 0, size: 100 });
        expect(adapter.entryAt(1)).toBeNull();
        expect(adapter.entryAt(2)).toBeNull();
        expect(adapter.entryAt(9)).toBeNull();
    });

    it("scrollToOffset 透传", () => {
        const { adapter, scrollToOffset } = fake([{ start: 0, size: 100 }]);
        adapter.scrollToOffset(-200);
        expect(scrollToOffset).toHaveBeenCalledWith(-200);
    });
});
