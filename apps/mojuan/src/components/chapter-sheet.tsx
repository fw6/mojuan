import { useEffect, useRef } from "react";
import { Check, TriangleAlert } from "lucide-react";
import type { Chapter } from "../api";
import type { ChapterDownloadState } from "../lib/downloads";
import { cn } from "../lib/utils";
import { BottomSheet } from "./beui/bottom-sheet";

/**
 * 阅读器的目录面板：一话一行，点一行就从那一话重开。
 *
 * 这是阅读器里的浮层，整块走暗房配色（`tone="reader"`，见 DESIGN.md 的
 * Dark Room Rule）——画布之上的表面只取 `reader` 令牌。
 */
export function ChapterSheet({
    open,
    onOpenChange,
    chapters,
    currentIndex,
    states,
    onSelect,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    chapters: Chapter[];
    /** 正在读的那一话（章节序号，不是列表下标）。 */
    currentIndex: number;
    /** 每话的下载状态；没有记录的话按未下载算。 */
    states: Map<number, ChapterDownloadState>;
    onSelect: (chapterIndex: number) => void;
}) {
    const currentRef = useRef<HTMLButtonElement>(null);
    const downloaded = chapters.filter((ch) => states.get(ch.index) === "downloaded").length;

    // 打开时把当前话滚到视野中间：目录里最先要看到的永远是「我在哪」。
    // 等面板这一帧挂上去再滚（内容随 open 一起进 DOM）。
    useEffect(() => {
        if (!open) return;
        const raf = requestAnimationFrame(() => centerRow(currentRef.current));
        return () => cancelAnimationFrame(raf);
    }, [open]);

    return (
        <BottomSheet
            open={open}
            onOpenChange={onOpenChange}
            tone="reader"
            snapPoints={["auto"]}
            title="目录"
            description={summary(chapters.length, downloaded)}
            className="pb-[env(safe-area-inset-bottom)]"
        >
            <ul className="flex flex-col gap-0.5">
                {chapters.map((ch) => {
                    const current = ch.index === currentIndex;
                    return (
                        <li key={ch.index}>
                            <button
                                type="button"
                                ref={current ? currentRef : undefined}
                                aria-current={current || undefined}
                                onClick={() => onSelect(ch.index)}
                                className={cn(
                                    "flex min-h-11 w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-left text-sm transition-colors",
                                    "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-reader-surface",
                                    current
                                        ? "bg-white/10 text-reader-foreground"
                                        : "text-reader-muted hover:bg-white/5 hover:text-reader-foreground",
                                )}
                            >
                                <span className="min-w-0 flex-1 truncate">{ch.title}</span>
                                <DownloadMark state={states.get(ch.index) ?? "none"} />
                            </button>
                        </li>
                    );
                })}
            </ul>
        </BottomSheet>
    );
}

/** 标题下的一行：共有多少话、下到本地多少话。 */
function summary(total: number, downloaded: number): string {
    if (downloaded === 0) return `共 ${total} 话`;
    if (downloaded === total) return `共 ${total} 话 · 全部已下载`;
    return `共 ${total} 话 · 已下载 ${downloaded} 话`;
}

/** 最近的可滚动祖先：目录行的滚动容器就是面板自己的正文区。 */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
    for (let node = el?.parentElement; node; node = node.parentElement) {
        const overflowY = getComputedStyle(node).overflowY;
        if (overflowY === "auto" || overflowY === "scroll") return node;
    }
    return null;
}

/** 把一行滚到滚动容器的中间。位移取两个 rect 的差：面板进场时自己带着位移，
 *  行与容器的 rect 被一起推，差值不受影响（scrollIntoView 会把那段位移算进去，
 *  滚过头；面板还没铺开、量不到尺寸时差值为 0，什么都不做）。 */
function centerRow(row: HTMLElement | null) {
    const box = scrollParent(row);
    if (!row || !box) return;
    const rowRect = row.getBoundingClientRect();
    const boxRect = box.getBoundingClientRect();
    box.scrollTop += rowRect.top - boxRect.top - (boxRect.height - rowRect.height) / 2;
}

/** 行尾的下载状态。文字取次级文字色，颜色只落在图标上（DESIGN.md 的
 * 「The Color Carries Meaning, Not Text Rule」——语义色在暗房里做文字色对比度不够）。 */
function DownloadMark({ state }: { state: ChapterDownloadState }) {
    if (state === "downloaded") {
        return (
            <span className="shrink-0 text-success" role="img" aria-label="已下载">
                <Check className="size-3.5" />
            </span>
        );
    }
    if (state === "downloading" || state === "queued") {
        return (
            <span className="shrink-0 text-[11px] text-reader-muted">
                {state === "downloading" ? "下载中" : "排队中"}
            </span>
        );
    }
    if (state === "failed") {
        return (
            <span className="shrink-0 text-warning" role="img" aria-label="下载失败">
                <TriangleAlert className="size-3.5" />
            </span>
        );
    }
    return null;
}
