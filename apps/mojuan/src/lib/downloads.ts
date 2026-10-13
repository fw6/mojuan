import type { DownloadStatus, DownloadTaskView } from "../api";

/** 一部作品的下载任务汇总（下载页按漫画分组）。 */
export interface DownloadGroup {
    /** `source:comicId`——同一源里的同 id 作品归一组 */
    key: string;
    source: string;
    comicId: string;
    title: string;
    /** 作品封面（入队时记下的地址）；没有时为空串，卡片回落到无图形态 */
    cover: string;
    /** 组内任务，按话数升序 */
    chapters: DownloadTaskView[];
    done: number;
    queued: number;
    downloading: number;
    failed: number;
    cancelled: number;
    /** 待下载 = 排队中 + 下载中（尚未抓到本地的话数） */
    pending: number;
    /** 组整体状态（组头徽章） */
    status: DownloadStatus;
}

/** 组整体状态：进行中优先，其次排队，再按失败/取消/全部完成。 */
function groupStatus(group: DownloadGroup): DownloadStatus {
    if (group.downloading > 0) return "downloading";
    if (group.queued > 0) return "queued";
    if (group.failed > 0) return "failed";
    if (group.cancelled > 0) return "cancelled";
    return "done";
}

/**
 * 下载任务按漫画分组：组序沿用队列顺序（先入队的作品在前），组内按话数升序。
 * 分组键是（source, comicId），同名作品来自不同源时各自成组。
 */
export function groupDownloads(tasks: DownloadTaskView[]): DownloadGroup[] {
    const map = new Map<string, DownloadGroup>();
    for (const task of tasks) {
        const key = `${task.source}:${task.comicId}`;
        let group = map.get(key);
        if (!group) {
            group = {
                key,
                source: task.source,
                comicId: task.comicId,
                title: task.comicTitle,
                cover: task.comicCover,
                chapters: [],
                done: 0,
                queued: 0,
                downloading: 0,
                failed: 0,
                cancelled: 0,
                pending: 0,
                status: "queued",
            };
            map.set(key, group);
        }
        group.chapters.push(task);
        group[task.status] += 1;
    }
    const groups = [...map.values()];
    for (const group of groups) {
        group.chapters.sort((a, b) => a.chapterIndex - b.chapterIndex);
        group.pending = group.queued + group.downloading;
        group.status = groupStatus(group);
    }
    return groups;
}

/** 章节/组进度的百分比（页数为 0 时按 0 算）。 */
export function donePercent(done: number, total: number): number {
    if (total <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

/** 阅读器目录里一行话的下载状态。 */
export type ChapterDownloadState =
    | "none"
    | "downloaded"
    | "downloading"
    | "queued"
    | "failed";

/**
 * 每话的下载状态。队列里在途的话优先：一话的目录一有文件就被 `list_downloaded`
 * 算作「已下载」（磁盘扫描按目录算），照磁盘标的话，正在下的那几话会显示成下完了。
 * 磁盘是「能不能离线读」的判据，所以队列里的已完成、已取消都不显示——取消是读者
 * 自己的动作，已完成的话磁盘清单里本来就有。
 */
export function chapterDownloadStates(
    chapters: readonly { index: number }[],
    downloaded: Record<string, unknown>,
    tasks: Record<number, DownloadStatus>,
): Map<number, ChapterDownloadState> {
    const states = new Map<number, ChapterDownloadState>();
    for (const ch of chapters) {
        const status = tasks[ch.index];
        if (status === "downloading" || status === "queued" || status === "failed") {
            states.set(ch.index, status);
        } else if (downloaded[String(ch.index)]) {
            states.set(ch.index, "downloaded");
        }
    }
    return states;
}
