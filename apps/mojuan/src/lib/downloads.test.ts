import { describe, it, expect } from "vitest";
import { donePercent, groupDownloads } from "./downloads";
import type { DownloadStatus, DownloadTaskView } from "../api";

const task = (
    source: string,
    comicId: string,
    chapterIndex: number,
    status: DownloadStatus,
    done = 0,
    total = 10,
    comicTitle = "标题",
): DownloadTaskView => ({
    taskId: `${source}/${comicId}/${chapterIndex}`,
    source,
    comicId,
    comicTitle,
    chapterIndex,
    status,
    done,
    total,
});

describe("groupDownloads（下载任务按漫画分组）", () => {
    it("同一作品的话归一组，组内按话数升序", () => {
        const groups = groupDownloads([
            task("mangadex", "c1", 3, "queued"),
            task("mangadex", "c1", 1, "done", 10, 10),
            task("mangadex", "c1", 2, "downloading", 4, 10),
        ]);
        expect(groups).toHaveLength(1);
        expect(groups[0].chapters.map((c) => c.chapterIndex)).toEqual([1, 2, 3]);
    });

    it("同名作品来自不同源时各自成组，组序沿用队列顺序", () => {
        const groups = groupDownloads([
            task("hentara", "x", 1, "queued", 0, 10, "同名"),
            task("dongman", "x", 1, "queued", 0, 10, "同名"),
            task("hentara", "x", 2, "queued", 0, 10, "同名"),
        ]);
        expect(groups.map((g) => g.key)).toEqual(["hentara:x", "dongman:x"]);
        expect(groups[0].chapters).toHaveLength(2);
        expect(groups[1].chapters).toHaveLength(1);
    });

    it("分状态计数，待下载 = 排队中 + 下载中", () => {
        const groups = groupDownloads([
            task("mangadex", "c1", 1, "done", 10, 10),
            task("mangadex", "c1", 2, "downloading", 4, 10),
            task("mangadex", "c1", 3, "queued"),
            task("mangadex", "c1", 4, "queued"),
            task("mangadex", "c1", 5, "failed", 3, 10),
            task("mangadex", "c1", 6, "cancelled", 0, 10),
        ]);
        const g = groups[0];
        expect([g.done, g.downloading, g.queued, g.failed, g.cancelled]).toEqual([
            1, 1, 2, 1, 1,
        ]);
        expect(g.pending).toBe(3);
    });

    it("组状态：下载中优先，其次排队，再按失败/取消/全部完成", () => {
        const status = (...statuses: DownloadStatus[]) =>
            groupDownloads(
                statuses.map((s, i) => task("mangadex", "c1", i + 1, s)),
            )[0].status;
        expect(status("downloading", "queued", "failed")).toBe("downloading");
        expect(status("queued", "failed")).toBe("queued");
        expect(status("failed", "cancelled")).toBe("failed");
        expect(status("cancelled", "done", "done")).toBe("cancelled");
        expect(status("done", "done")).toBe("done");
    });

    it("空队列返回空数组", () => {
        expect(groupDownloads([])).toEqual([]);
    });
});

describe("donePercent（进度百分比）", () => {
    it("按比例取整并夹在 0..100", () => {
        expect(donePercent(0, 44)).toBe(0);
        expect(donePercent(6, 44)).toBe(14);
        expect(donePercent(44, 44)).toBe(100);
        expect(donePercent(0, 0)).toBe(0);
    });
});
