import { crawl, type Chapter, type Comic } from "../api";
import { errorFirstLine } from "./errors";
import { nextFollowRecord } from "./follow";
import { getFollowState, setFollowState, type FollowRecord } from "./storage/follow";
import { getProgress, type ProgressRecord } from "./storage/progress";
import { getSettings, setSettings } from "./storage/settings";
import { whenSourcesReady } from "./storage/sources";
import { comicKey } from "./storage/store";

// 书架追更的检查编排：注入取详情 / 读进度 / 读状态三处 I/O，按请求预算逐部检查。
// 只负责算出结果，不写存储——写入磁盘由调用方按 updated 做（生产里是 runFollowCheckNow）。

/** 自动检查的最小间隔（6 小时）；手动刷新不受它限制。 */
export const FOLLOW_THROTTLE_MS = 6 * 60 * 60 * 1000;
/** 单次检查最多覆盖的收藏数。 */
export const FOLLOW_CHECK_LIMIT = 50;
/** 单次检查同时在飞的取详情请求数。 */
export const FOLLOW_CHECK_CONCURRENCY = 2;

export interface FollowCheckInput {
    favorites: Comic[];
    now: number;
    /** 上次自动检查的时刻；null 表示从未检查。 */
    lastCheckedAt: number | null;
    /** 节流窗口：距上次检查不足这个时长就不检查。 */
    throttleMs: number;
    /** 单次最多检查的收藏数。 */
    limit: number;
    /** 同时在飞的取详情请求上限。 */
    concurrency: number;
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

/** 距上次检查不足节流窗口时为真：这一次不检查（也不该改写上次检查时刻）。 */
export function shouldSkipCheck(
    lastCheckedAt: number | null,
    now: number,
    throttleMs: number,
): boolean {
    return lastCheckedAt !== null && now - lastCheckedAt < throttleMs;
}

/** 基线缺失时（从未打开过、也没有记录）取新章节表的最后一话，避免老收藏出现积压角标。 */
function lastChapterBaseline(chapters: Chapter[]): { index: number; title?: string } {
    const last = chapters[chapters.length - 1];
    return { index: last.index, title: last.title };
}

function failureReason(error: unknown): string {
    return errorFirstLine(error instanceof Error ? error.message : String(error));
}

/** 单部作品的检查：成功给出待写入的状态，失败给出原因。磁盘上已有的状态在这里不动。 */
async function checkOne(
    input: FollowCheckInput,
    favorite: Comic,
    record: FollowRecord | null,
): Promise<{ update?: FollowStateUpdate; failure?: FollowCheckFailure }> {
    const { source, id: comicId } = favorite;
    const progress = await input.loadProgress(source, comicId);

    let detail: { comic?: unknown; chapters?: Chapter[] };
    try {
        detail = await input.getDetail(source, comicId);
    } catch (error) {
        return { failure: { source, comicId, title: favorite.title, reason: failureReason(error) } };
    }

    const chapters = detail.chapters ?? [];
    // 空章节表与源失败无法区分，同样不写状态
    if (!detail.comic) {
        return { failure: { source, comicId, title: favorite.title, reason: "没有取到作品信息" } };
    }
    if (chapters.length === 0) {
        return { failure: { source, comicId, title: favorite.title, reason: "没有取到章节" } };
    }

    const baseline = progress
        ? { index: progress.chapterIndex, title: progress.chapterTitle }
        : (record?.baseline ?? lastChapterBaseline(chapters));
    return {
        update: { source, comicId, record: nextFollowRecord(chapters, baseline, input.now) },
    };
}

export async function runFollowCheck(input: FollowCheckInput): Promise<FollowCheckResult> {
    if (shouldSkipCheck(input.lastCheckedAt, input.now, input.throttleMs)) {
        return { updated: [], failures: [] };
    }

    // 读回每部的上一次状态：排序要按最近检查时刻，逐部检查时也要用它的基线
    const records = new Map<string, FollowRecord | null>();
    for (const favorite of input.favorites) {
        const key = comicKey(favorite.source, favorite.id);
        records.set(key, await input.loadState(favorite.source, favorite.id));
    }

    // 最久未检查优先：从未检查过的排最前，其次按 checkedAt 升序，同刻按收藏顺序。
    // 每次检查都会把成功那批的 checkedAt 推到 now，所以超过 limit 的收藏会在下一次轮到时排到前面。
    const ranked = input.favorites.map((favorite, index) => ({
        favorite,
        index,
        checkedAt: records.get(comicKey(favorite.source, favorite.id))?.checkedAt ?? null,
    }));
    ranked.sort((a, b) => {
        if (a.checkedAt === b.checkedAt) return a.index - b.index;
        if (a.checkedAt === null) return -1;
        if (b.checkedAt === null) return 1;
        return a.checkedAt - b.checkedAt;
    });
    const selected = ranked.slice(0, input.limit);

    // 结果按实际检查的顺序落位：并发下产出顺序不固定，靠下标对齐收藏顺序
    const updated: (FollowStateUpdate | null)[] = new Array(selected.length).fill(null);
    const failures: (FollowCheckFailure | null)[] = new Array(selected.length).fill(null);

    let cursor = 0;
    const workers = Array.from(
        { length: Math.max(1, Math.min(input.concurrency, selected.length)) },
        async () => {
            while (cursor < selected.length) {
                const position = cursor++;
                const { favorite } = selected[position];
                const record = records.get(comicKey(favorite.source, favorite.id)) ?? null;
                const outcome = await checkOne(input, favorite, record);
                if (outcome.update) updated[position] = outcome.update;
                else failures[position] = outcome.failure!;
            }
        },
    );
    await Promise.all(workers);

    return {
        updated: updated.filter((update): update is FollowStateUpdate => update !== null),
        failures: failures.filter((failure): failure is FollowCheckFailure => failure !== null),
    };
}

export interface FollowCheckRunOptions {
    /** 手动刷新：不受节流限制，也不受「书架追更」开关限制。 */
    manual?: boolean;
}

/** 生产用的检查：取详情走 crawl（不读结果缓存，总是拉最新），结果写入追更状态域。
 * 自动路径受「书架追更」开关与 6 小时节流约束，跑完把上次检查时刻推到现在；手动路径都不受限。 */
export async function runFollowCheckNow(
    favorites: Comic[],
    options?: FollowCheckRunOptions,
): Promise<FollowCheckResult> {
    const manual = options?.manual ?? false;
    // 自动检查受「书架追更」开关与上次检查时刻两道门约束；手动刷新两道门都不走
    const settings = manual ? null : await getSettings();
    if (settings && !settings.followUpdate) {
        return { updated: [], failures: [] };
    }
    // 源注册表就绪前 crawl 会返回空结果：等同步单例完成，免得首屏进书架全判成失败
    await whenSourcesReady();
    const now = Date.now();
    const lastCheckedAt = manual ? null : (settings?.followCheckedAt ?? null);

    const result = await runFollowCheck({
        favorites,
        now,
        lastCheckedAt,
        throttleMs: FOLLOW_THROTTLE_MS,
        limit: FOLLOW_CHECK_LIMIT,
        concurrency: FOLLOW_CHECK_CONCURRENCY,
        getDetail: (source, comicId) =>
            crawl<{ comic: Comic; chapters: Chapter[] }>("detail", source, { comicId }),
        loadProgress: getProgress,
        loadState: getFollowState,
    });
    for (const update of result.updated) {
        await setFollowState(update.source, update.comicId, update.record);
    }
    // 被节流跳过的那一次不改写时刻：否则窗口会一直往后滑，永远不再检查
    if (!manual && !shouldSkipCheck(lastCheckedAt, now, FOLLOW_THROTTLE_MS)) {
        await setSettings({ followCheckedAt: now });
    }
    return result;
}
