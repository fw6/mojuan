import type { Chapter } from "../api";
import { filterExternalChapters } from "./chapters";
import type { FollowBaseline, FollowRecord } from "./storage/follow";
import type { ProgressRecord } from "./storage/progress";

// 书架追更的纯逻辑：基线定位、未读数判定、追更状态的算出。不碰存储与网络。

/**
 * 在章节表里定位基线：先按 chapterIndex，再按 chapterTitle；都定位不到返回 null。
 * 返回的是该话在当前表里的 chapterIndex（源可能换过话序号）。
 */
export function locateBaseline(chapters: Chapter[], baseline: FollowBaseline): number | null {
    const byIndex = chapters.find((c) => c.index === baseline.index);
    if (byIndex) return byIndex.index;
    if (baseline.title) {
        const byTitle = chapters.find((c) => c.title === baseline.title);
        if (byTitle) return byTitle.index;
    }
    return null;
}

/**
 * 由章节表与基线算出新的追更状态。基线定位不到时标为待重建（角标暂不显示，等详情页重建）。
 * 基线之后的话只取非外链的，序号升序。
 */
export function nextFollowRecord(
    chapters: Chapter[],
    baseline: FollowBaseline,
    checkedAt: number,
): FollowRecord {
    const resolved = locateBaseline(chapters, baseline);
    if (resolved === null) {
        return { checkedAt, baseline, newChapterIndexes: [], needsRebuild: true };
    }
    const newChapterIndexes = filterExternalChapters(chapters)
        .filter((c) => c.index > resolved)
        .map((c) => c.index)
        .sort((a, b) => a - b);
    return { checkedAt, baseline, newChapterIndexes, needsRebuild: false };
}

/**
 * 没有进度记录时的追更基线：章节表最后一话（外链章节不算，与未读数的口径一致）。
 * 章节表里没有可作基线的非外链话时返回 null。
 */
export function lastChapterBaseline(chapters: Chapter[]): FollowBaseline | null {
    const table = filterExternalChapters(chapters);
    const last = table[table.length - 1];
    return last ? { index: last.index, title: last.title } : null;
}

/**
 * 重建后的基线：位置在新表里落得到就用那一话（带上它的话名），落不到就用最后一话。
 * 新表里没有可作基线的非外链话时返回 null。
 */
function rebuildBaseline(chapters: Chapter[], position: FollowBaseline): FollowBaseline | null {
    const resolved = locateBaseline(chapters, position);
    if (resolved !== null) {
        const hit = chapters.find((c) => c.index === resolved)!;
        return { index: hit.index, title: hit.title };
    }
    return lastChapterBaseline(chapters);
}

/**
 * 重建基线：把读者当前的位置重新落到新章节表上；都落不到就落到最后一话（视为已追平）。
 * 有进度记录时用进度里的位置，没有时用记录里原有的基线；新基线之后的未读数一并算出。
 * 新章节表里没有可作基线的非外链话时返回原记录（保持待重建）。
 */
export function rebuildFollowRecord(
    chapters: Chapter[],
    progress: ProgressRecord | null,
    record: FollowRecord,
    now: number,
): FollowRecord {
    const position: FollowBaseline = progress
        ? { index: progress.chapterIndex, title: progress.chapterTitle }
        : record.baseline;
    const baseline = rebuildBaseline(chapters, position);
    if (!baseline) return record;
    return nextFollowRecord(chapters, baseline, now);
}

/**
 * 未读的话序号（升序）：基线之后、且读者当前进度之前还没读到的非外链话。
 * 没有记录或待重建时为空；没有进度记录时就是记录里的全部序号；有进度记录时只保留
 * 序号大于进度 chapterIndex 的（读完最新一话当场归零，跳读留下的空档不计入）。
 */
export function unreadIndexes(
    record: FollowRecord | null,
    progress: ProgressRecord | null,
): number[] {
    if (!record || record.needsRebuild) return [];
    if (!progress) return [...record.newChapterIndexes];
    return record.newChapterIndexes.filter((index) => index > progress.chapterIndex);
}

/**
 * 未读数：基线之后仍未被读到的非外链话数。就是未读序号的个数。
 */
export function unreadCount(
    record: FollowRecord | null,
    progress: ProgressRecord | null,
): number {
    return unreadIndexes(record, progress).length;
}
