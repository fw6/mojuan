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
 * 未读数：基线之后仍未被读到的非外链话数。没有记录、待重建、或未读数为 0 时返回 0。
 * 有进度记录时按进度就地算（读完最新一话当场归零；跳读留下的空档不计入）。
 */
export function unreadCount(
    record: FollowRecord | null,
    progress: ProgressRecord | null,
): number {
    if (!record || record.needsRebuild) return 0;
    if (!progress) return record.newChapterIndexes.length;
    return record.newChapterIndexes.filter((index) => index > progress.chapterIndex).length;
}
