import { crawl, type Chapter, type Comic } from "../api";
import { errorFirstLine } from "./errors";
import { nextFollowRecord } from "./follow";
import { getFollowState, setFollowState, type FollowRecord } from "./storage/follow";
import { getProgress, type ProgressRecord } from "./storage/progress";
import { getSettings } from "./storage/settings";
import { whenSourcesReady } from "./storage/sources";

// 书架追更的检查编排：注入取详情 / 读进度 / 读状态三处 I/O，串行逐部检查。
// 只负责算出结果，不写存储——写入磁盘由调用方按 updated 做（生产里是 runFollowCheckNow）。

export interface FollowCheckInput {
    favorites: Comic[];
    now: number;
    getDetail: (
        source: string,
        comicId: string,
    ) => Promise<{ comic?: unknown; chapters?: Chapter[] }>;
    loadProgress: (source: string, comicId: string) => Promise<ProgressRecord | null>;
    loadState: (source: string, comicId: string) => Promise<FollowRecord | null>;
}

/** 检查成功、待写入磁盘的追更状态。 */
export interface FollowStateUpdate {
    source: string;
    comicId: string;
    record: FollowRecord;
}

/** 检查失败的作品与原因；磁盘上的上一次状态保持不变。 */
export interface FollowCheckFailure {
    source: string;
    comicId: string;
    title: string;
    reason: string;
}

export interface FollowCheckResult {
    updated: FollowStateUpdate[];
    failures: FollowCheckFailure[];
}

/** 基线缺失时（从未打开过、也没有记录）取新章节表的最后一话，避免老收藏出现积压角标。 */
function lastChapterBaseline(chapters: Chapter[]): { index: number; title?: string } {
    const last = chapters[chapters.length - 1];
    return { index: last.index, title: last.title };
}

function failureReason(error: unknown): string {
    return errorFirstLine(error instanceof Error ? error.message : String(error));
}

export async function runFollowCheck(input: FollowCheckInput): Promise<FollowCheckResult> {
    const updated: FollowStateUpdate[] = [];
    const failures: FollowCheckFailure[] = [];

    // 逐部串行：节流、分批与并发留给 #34
    for (const favorite of input.favorites) {
        const { source, id: comicId } = favorite;
        const progress = await input.loadProgress(source, comicId);
        const record = await input.loadState(source, comicId);

        let detail: { comic?: unknown; chapters?: Chapter[] };
        try {
            detail = await input.getDetail(source, comicId);
        } catch (error) {
            failures.push({
                source,
                comicId,
                title: favorite.title,
                reason: failureReason(error),
            });
            continue;
        }

        const chapters = detail.chapters ?? [];
        // 空章节表与源失败无法区分，同样不写状态
        if (!detail.comic) {
            failures.push({
                source,
                comicId,
                title: favorite.title,
                reason: "没有取到作品信息",
            });
            continue;
        }
        if (chapters.length === 0) {
            failures.push({
                source,
                comicId,
                title: favorite.title,
                reason: "没有取到章节",
            });
            continue;
        }

        const baseline = progress
            ? { index: progress.chapterIndex, title: progress.chapterTitle }
            : (record?.baseline ?? lastChapterBaseline(chapters));
        updated.push({
            source,
            comicId,
            record: nextFollowRecord(chapters, baseline, input.now),
        });
    }

    return { updated, failures };
}

/** 生产检查的选项。 */
export interface FollowCheckRunOptions {
    /** 手动刷新：不受节流限制，也不受「书架追更」开关限制。 */
    manual?: boolean;
}

/** 生产用的检查：取详情走 crawl（不读结果缓存，总是拉最新），结果写入追更状态域。 */
export async function runFollowCheckNow(
    favorites: Comic[],
    options?: FollowCheckRunOptions,
): Promise<FollowCheckResult> {
    // 自动检查在「书架追更」关闭时直接返回：不读源、不写状态。手动刷新不走这道门。
    if (!options?.manual && !(await getSettings()).followUpdate) {
        return { updated: [], failures: [] };
    }
    // 源注册表就绪前 crawl 会返回空结果：等同步单例完成，免得首屏进书架全判成失败
    await whenSourcesReady();
    const result = await runFollowCheck({
        favorites,
        now: Date.now(),
        getDetail: (source, comicId) =>
            crawl<{ comic: Comic; chapters: Chapter[] }>("detail", source, { comicId }),
        loadProgress: getProgress,
        loadState: getFollowState,
    });
    for (const update of result.updated) {
        await setFollowState(update.source, update.comicId, update.record);
    }
    return result;
}
