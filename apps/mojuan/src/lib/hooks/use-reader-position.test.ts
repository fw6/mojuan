import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { RefObject } from "react";

// vitest 不开 globals（vite.config.ts：#10 seam 测试显式 import）→ RTL 不会自动
// cleanup，DOM 会跨用例泄漏。手动在 afterEach 清理。

// S4 seam：阅读位置的记录与恢复。滚动容器与虚拟器都由外部注入，所以不必给 jsdom
// 桩几何（Reader.test.tsx 那套几何桩覆盖的是接线）。

vi.mock("../storage/progress", () => ({
    getProgress: vi.fn().mockResolvedValue(null),
    setProgress: vi.fn().mockResolvedValue(undefined),
}));

import { getProgress, setProgress } from "../storage/progress";
import {
    useReaderPosition,
    type ReaderPositionDeps,
    type VirtualizerAdapter,
} from "./use-reader-position";

const mockedGet = vi.mocked(getProgress);
const mockedSet = vi.mocked(setProgress);

const COMIC = { source: "webtoons", id: "webtoons-1" };
/** 话序号从 126 递减（与源返回的顺序一致）。 */
const CHAPTERS = [{ index: 126 }, { index: 125 }];
/** 已加载页：前三页属于第 0 话（index 126），后两页属于第 1 话（index 125）。 */
const PAGES = [
    { chapterIdx: 0 },
    { chapterIdx: 0 },
    { chapterIdx: 0 },
    { chapterIdx: 1 },
    { chapterIdx: 1 },
];
const SIZES = [100, 200, 300, 400, 500];

/** 假虚拟器：起点按累计和算；`measured` 为 false 时模拟「内容还没铺开、量不到」。 */
function fakeVirtualizer(sizes: number[]) {
    const state = { measured: true };
    const starts = sizes.map((_, i) => sizes.slice(0, i).reduce((a, b) => a + b, 0));
    const adapter: VirtualizerAdapter = {
        sizes: () => sizes,
        entryAt: (index) => {
            if (!state.measured || index >= sizes.length) return null;
            return { start: starts[index], size: sizes[index] };
        },
        scrollToOffset: vi.fn(),
    };
    return { adapter, state };
}

function setup(over: Partial<ReaderPositionDeps> = {}) {
    const container = {
        current: { scrollTop: 0, clientHeight: 800 },
    } as unknown as RefObject<HTMLElement | null>;
    const { adapter, state } = fakeVirtualizer(SIZES);
    const props: ReaderPositionDeps = {
        container,
        virtualizer: adapter,
        pages: PAGES,
        chapters: CHAPTERS,
        comic: COMIC,
        chapterIndex: 126,
        ...over,
    };
    const view = renderHook((p: ReaderPositionDeps) => useReaderPosition(p), {
        initialProps: props,
    });
    return { ...view, container, adapter, state, props };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockedGet.mockResolvedValue(null);
});

afterEach(() => {
    cleanup();
});

describe("useReaderPosition（记录）", () => {
    it("按视口中心算出（话序号, 话内页码, 页内位置）并写进度", () => {
        const { result, container } = setup();
        container.current!.scrollTop = 150; // 中心 550：落在第 3 页（300..600）里
        expect(result.current.record()).toEqual({
            chapterIndex: 126,
            pageIndex: 2,
            offsetInPage: (550 - 300) / 300,
        });
        expect(mockedSet).toHaveBeenCalledWith(
            "webtoons",
            "webtoons-1",
            expect.objectContaining({
                chapterIndex: 126,
                pageIndex: 2,
                offsetInPage: (550 - 300) / 300,
            }),
        );
    });

    it("页码是话内下标：落在第二话的页上时从该话首页算起", () => {
        const { result, container } = setup();
        container.current!.scrollTop = 1000; // 中心 1400：第 5 页（1000..1500）
        expect(result.current.record()).toEqual({
            chapterIndex: 125,
            pageIndex: 1,
            offsetInPage: (1400 - 1000) / 500,
        });
    });

    it("页面还没铺开（量不到高度）时返回 null，不写进度", () => {
        const { result } = setup({ virtualizer: fakeVirtualizer([]).adapter });
        expect(result.current.record()).toBeNull();
        expect(mockedSet).not.toHaveBeenCalled();
    });
});

describe("useReaderPosition（恢复）", () => {
    it("把记录点放回视口中心", async () => {
        mockedGet.mockResolvedValue({
            chapterIndex: 126,
            pageIndex: 1,
            offsetInPage: 0.5,
            updatedAt: 1,
        });
        const { adapter } = setup();
        // 点 = 第 2 页起点 100 + 0.5 × 页高 200 = 200；中心对齐 → 减半屏 400
        await waitFor(() => expect(adapter.scrollToOffset).toHaveBeenCalledWith(-200));
    });

    it("记录属于另一话时按该话首页换算起点", async () => {
        mockedGet.mockResolvedValue({
            chapterIndex: 125,
            pageIndex: 0,
            offsetInPage: 0,
            updatedAt: 1,
        });
        const { adapter } = setup({ chapterIndex: 125 });
        // 第 1 话首页是第 4 页，起点 100+200+300 = 600
        await waitFor(() => expect(adapter.scrollToOffset).toHaveBeenCalledWith(200));
    });

    it("内容还没铺开时按帧重试，量到后只滚一次", async () => {
        mockedGet.mockResolvedValue({
            chapterIndex: 126,
            pageIndex: 0,
            offsetInPage: 0,
            updatedAt: 1,
        });
        const { adapter, state } = setup();
        state.measured = false;
        await new Promise((r) => setTimeout(r, 80));
        expect(adapter.scrollToOffset).not.toHaveBeenCalled();
        state.measured = true;
        await waitFor(() => expect(adapter.scrollToOffset).toHaveBeenCalledTimes(1));
    });

    it("记录属于别的话（路由停在另一话）时不套用", async () => {
        mockedGet.mockResolvedValue({
            chapterIndex: 125,
            pageIndex: 0,
            offsetInPage: 0,
            updatedAt: 1,
        });
        const { adapter } = setup({ chapterIndex: 126 });
        await new Promise((r) => setTimeout(r, 80));
        expect(adapter.scrollToOffset).not.toHaveBeenCalled();
    });

    it("跨话连读追加页后不再恢复", async () => {
        mockedGet.mockResolvedValue({
            chapterIndex: 126,
            pageIndex: 0,
            offsetInPage: 0,
            updatedAt: 1,
        });
        const { adapter, props, rerender } = setup();
        await waitFor(() => expect(adapter.scrollToOffset).toHaveBeenCalledTimes(1));
        rerender({ ...props, pages: [...PAGES, { chapterIdx: 1 }] });
        await new Promise((r) => setTimeout(r, 80));
        expect(adapter.scrollToOffset).toHaveBeenCalledTimes(1);
    });
});
