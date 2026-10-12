import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { offsetWithinPage, pageIndexAt } from "../scroll";
import { getProgress, setProgress } from "../storage/progress";

/** 恢复时最多重试的帧数：内容还没铺开、页面还没量到高度时，下一帧再试。 */
const RESTORE_MAX_FRAMES = 30;

/** 记录下来的阅读位置（进度记录里的位置部分）。 */
export interface ReaderPosition {
    /** 话序号（章节列表里的 index）。 */
    chapterIndex: number;
    /** 话内页码（已加载页里的下标，相对该话第一页）。 */
    pageIndex: number;
    /** 页内位置 0..1：长条漫一页好几屏，只记页码会跳很远。 */
    offsetInPage: number;
}

/** 虚拟器的适配面：高度与定位都从这里取，模块本身不认识虚拟器。 */
export interface VirtualizerAdapter {
    /** 已测页高（与 pages 平行；未测或异常的项为 0）。 */
    sizes: () => number[];
    /** 某页的起点与高度（像素）；还没量到返回 null。 */
    entryAt: (index: number) => { start: number; size: number } | null;
    /** 把内容里的某一处滚到视口顶部。 */
    scrollToOffset: (px: number) => void;
}

export interface ReaderPositionDeps {
    /** 滚动容器（读 scrollTop 与 clientHeight）。 */
    container: React.RefObject<HTMLElement | null>;
    virtualizer: VirtualizerAdapter;
    /** 已加载的页，顺序即渲染顺序。 */
    pages: readonly { chapterIdx: number }[];
    /** 过滤后的章节列表（页里存的是它的下标）。 */
    chapters: readonly { index: number }[];
    /** 当前作品（进度键）。 */
    comic: { source: string; id: string } | null;
    /** 路由里的话序号：记录属于别的话（从章节列表点进另一话）时不套用。 */
    chapterIndex: number;
}

/** 该话第一页在已加载页里的下标（跨话连读时一个话可能从中间开始）。 */
function firstPageOf(pages: readonly { chapterIdx: number }[], chapterIdx: number) {
    return pages.findIndex((p) => p.chapterIdx === chapterIdx);
}

/**
 * 阅读位置的记录与恢复：视口中心 ⇄（话序号, 话内页码, 页内位置）。
 * 记录只写进度；历史属于另一个存储域，由调用点按自己的规则处理。
 */
export function useReaderPosition({
    container,
    virtualizer,
    pages,
    chapters,
    comic,
    chapterIndex,
}: ReaderPositionDeps): { record: () => ReaderPosition | null } {
    // 提交之后再写：渲染期写 ref，遇到被丢弃或还没提交的那次渲染，读它的滚动回调
    // 会拿到这棵树没有的值（与 useRowCursor 同一条约定）。
    const latest = useRef({ pages, chapters, comic, chapterIndex });
    useLayoutEffect(() => {
        latest.current = { pages, chapters, comic, chapterIndex };
    });
    // 恢复每个实例只做一次：跨话连读追加页也会让 pages 变长，那时不该把读者拽回旧位置
    const restored = useRef(false);

    /** 视口中心换算成位置；页面还没铺开（量不到高度）时返回 null。 */
    const positionAtCenter = useCallback((): ReaderPosition | null => {
        const el = container.current;
        const { pages, chapters } = latest.current;
        if (!el || pages.length === 0) return null;
        const sizes = virtualizer.sizes();
        if (sizes.length === 0) return null;
        const center = el.scrollTop + el.clientHeight / 2;
        const pageIdx = Math.min(pageIndexAt(center, sizes), pages.length - 1);
        const chapterIdx = pages[pageIdx].chapterIdx;
        const chapter = chapters[chapterIdx];
        if (!chapter) return null;
        return {
            chapterIndex: chapter.index,
            pageIndex: pageIdx - firstPageOf(pages, chapterIdx),
            offsetInPage: offsetWithinPage(center, sizes, pageIdx),
        };
    }, [container, virtualizer]);

    /** 记录当前位置（写进度）。页面还没铺开时返回 null，什么也不写。 */
    const record = useCallback((): ReaderPosition | null => {
        const { comic } = latest.current;
        const at = positionAtCenter();
        if (!comic || !at) return null;
        void setProgress(comic.source, comic.id, { ...at, updatedAt: Date.now() });
        return at;
    }, [positionAtCenter]);

    // 页面列表就绪后按记录恢复一次
    useEffect(() => {
        if (restored.current || pages.length === 0) return;
        const { comic } = latest.current;
        if (!comic) return;
        let cancelled = false;
        let raf = 0;
        let frames = 0;
        void (async () => {
            const prog = await getProgress(comic.source, comic.id);
            if (cancelled) return;
            restored.current = true;
            // 记录属于别的话（从章节列表点进另一话）时不套用
            if (!prog || prog.chapterIndex !== latest.current.chapterIndex) return;
            const { pages: current, chapters } = latest.current;
            const chapterIdx = chapters.findIndex((ch) => ch.index === prog.chapterIndex);
            if (chapterIdx < 0) return;
            const from = firstPageOf(current, chapterIdx);
            /** 记录点在内容里的像素位置；还没量到时返回 null（下一帧再试）。 */
            const point = (): number | null => {
                const entry = virtualizer.entryAt(from + prog.pageIndex);
                if (entry === null) return null;
                return entry.start + prog.offsetInPage * entry.size;
            };
            const place = () => {
                const at = point();
                if (at === null) {
                    if (++frames < RESTORE_MAX_FRAMES) raf = requestAnimationFrame(place);
                    return;
                }
                // 记录的是视口中心看到的那一处，恢复也把它放回视口中心
                const half = (container.current?.clientHeight ?? 0) / 2;
                virtualizer.scrollToOffset(at - half);
            };
            place();
        })();
        return () => {
            cancelled = true;
            cancelAnimationFrame(raf);
        };
    }, [pages.length, container, virtualizer]);

    return { record };
}
