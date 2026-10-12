import type { VirtualizerAdapter } from "./hooks/use-reader-position";

/** @tanstack/react-virtual 的测量结果里，适配面用到的部分（结构化类型，不引它的类型）。 */
export interface MeasuredVirtualizer {
    measurementsCache: ReadonlyArray<{ start: number; size: number } | undefined>;
    scrollToOffset: (px: number) => void;
}

/**
 * 虚拟器 → 位置模块的适配面。`measurementsCache` 是稀疏数组（重建期有空洞），
 * 页高在这里稠密化（空洞与非数值归 0，累加时不会得 NaN），起点按原值给。
 */
export function virtualizerAdapter(v: MeasuredVirtualizer): VirtualizerAdapter {
    return {
        sizes: () => {
            const cache = v.measurementsCache;
            const sizes: number[] = new Array(cache.length);
            for (let i = 0; i < cache.length; i++) {
                const size = cache[i]?.size;
                sizes[i] = typeof size === "number" && Number.isFinite(size) ? size : 0;
            }
            return sizes;
        },
        entryAt: (index) => {
            const entry = v.measurementsCache[index];
            if (!entry) return null;
            if (!Number.isFinite(entry.start) || !Number.isFinite(entry.size)) return null;
            return { start: entry.start, size: entry.size };
        },
        scrollToOffset: (px) => v.scrollToOffset(px),
    };
}
