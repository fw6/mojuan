import { describe, it, expect } from "vitest";
import { chapterDownloadStates, donePercent, groupDownloads } from "./downloads";
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
    comicCover: "https://x/cover.jpg",
    chapterIndex,
    chapterTitle: `第 ${chapterIndex} 话`,
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

    it("组带上作品标题与封面（下载页卡片显示用）", () => {
        const groups = groupDownloads([task("mangadex", "c1", 1, "queued", 0, 10, "作品甲")]);
        expect(groups[0].title).toBe("作品甲");
        expect(groups[0].cover).toBe("https://x/cover.jpg");
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

describe("chapterDownloadStates（目录里的下载状态）", () => {
    const chapters = [1, 2, 3, 4, 5, 6].map((index) => ({ index }));

    it("队列里在途的话压过磁盘：正在下的那几话不显示成已下载", () => {
        const states = chapterDownloadStates(
            chapters,
            { "1": [{ url: "", path: "chapter_1/0.jpg" }], "2": [{ url: "", path: "chapter_2/0.jpg" }] },
            { 1: "downloading", 2: "queued" },
        );
        expect(states.get(1)).toBe("downloading");
        expect(states.get(2)).toBe("queued");
    });

    it("队列里在途的话按状态标出，没有的落回 none", () => {
        const states = chapterDownloadStates(chapters, {}, {
            2: "downloading",
            3: "queued",
            4: "failed",
            5: "cancelled",
            6: "done",
        });
        expect(states.get(2)).toBe("downloading");
        expect(states.get(3)).toBe("queued");
        expect(states.get(4)).toBe("failed");
        // 取消是读者自己的动作，完成的话磁盘清单里本来就有：都不标
        expect(states.has(5)).toBe(false);
        expect(states.has(6)).toBe(false);
    });

    it("下载目录里的旧话（话序号是字符串键）也认", () => {
        const states = chapterDownloadStates([{ index: 12 }], { "12": {} }, {});
        expect(states.get(12)).toBe("downloaded");
    });

    it("没有任何下载时状态表是空的", () => {
        expect(chapterDownloadStates(chapters, {}, {}).size).toBe(0);
    });
});
