import { describe, it, expect } from "vitest";
import { locateBaseline, nextFollowRecord, rebuildFollowRecord, unreadCount } from "./follow";
import type { Chapter } from "../api";
import type { FollowRecord } from "./storage/follow";
import type { ProgressRecord } from "./storage/progress";

// 纯逻辑：未读数判定与追更状态的算出。不 mock、不碰存储与网络（照 downloads.test.ts）。

function chapter(index: number, opts: Partial<Chapter> = {}): Chapter {
    return {
        index,
        title: `第 ${index} 话`,
        pages: [],
        external: false,
        downloaded: false,
        read: false,
        ...opts,
    };
}

function progress(chapterIndex: number, chapterTitle?: string): ProgressRecord {
    return { chapterIndex, chapterTitle, pageIndex: 0, offsetInPage: 0, updatedAt: 0 };
}

function record(partial: Partial<FollowRecord>): FollowRecord {
    return {
        checkedAt: 0,
        baseline: { index: 0 },
        newChapterIndexes: [],
        needsRebuild: false,
        ...partial,
    };
}

describe("locateBaseline（在章节表里定位基线）", () => {
    it("按 chapterIndex 命中，返回该话的序号", () => {
        const chapters = [chapter(1), chapter(2), chapter(3)];
        expect(locateBaseline(chapters, { index: 2 })).toBe(2);
    });

    it("chapterIndex 不在表里时按 chapterTitle 命中", () => {
        const chapters = [chapter(10, { title: "第一话" }), chapter(20, { title: "第二话" })];
        expect(locateBaseline(chapters, { index: 99, title: "第二话" })).toBe(20);
    });

    it("chapterIndex 与 chapterTitle 都定位不到返回 null", () => {
        const chapters = [chapter(1), chapter(2)];
        expect(locateBaseline(chapters, { index: 99, title: "不存在" })).toBeNull();
    });

    it("chapterIndex 命中优先于 chapterTitle", () => {
        const chapters = [chapter(1, { title: "甲" }), chapter(2, { title: "乙" })];
        // 序号 2 命中时不再看标题（标题指向的 1 不算）
        expect(locateBaseline(chapters, { index: 2, title: "甲" })).toBe(2);
    });
});

describe("nextFollowRecord（由章节表与基线算出追更状态）", () => {
    it("基线之后的话序号升序返回，基线本身不算未读", () => {
        const chapters = [chapter(1), chapter(2), chapter(3)];
        const out = nextFollowRecord(chapters, { index: 1 }, 123);
        expect(out).toEqual({
            checkedAt: 123,
            baseline: { index: 1 },
            newChapterIndexes: [2, 3],
            needsRebuild: false,
        });
    });

    it("外链章节不计入", () => {
        const chapters = [
            chapter(1),
            chapter(2, { external: true }),
            chapter(3),
        ];
        expect(nextFollowRecord(chapters, { index: 1 }, 0).newChapterIndexes).toEqual([3]);
    });

    it("基线定位不到时标为待重建，话序号列表为空", () => {
        const out = nextFollowRecord([chapter(1), chapter(2)], { index: 99 }, 0);
        expect(out.needsRebuild).toBe(true);
        expect(out.newChapterIndexes).toEqual([]);
    });

    it("基线按 chapterTitle 定位时以新表里的序号为起点", () => {
        const chapters = [chapter(10, { title: "甲" }), chapter(20, { title: "乙" })];
        const out = nextFollowRecord(chapters, { index: 1, title: "甲" }, 0);
        expect(out.newChapterIndexes).toEqual([20]);
        expect(out.needsRebuild).toBe(false);
    });
});

describe("unreadCount（未读数判定）", () => {
    it("没有记录时返回 0", () => {
        expect(unreadCount(null, null)).toBe(0);
    });

    it("待重建时返回 0", () => {
        expect(unreadCount(record({ needsRebuild: true, newChapterIndexes: [1, 2, 3] }), null)).toBe(
            0,
        );
    });

    it("没有进度记录时就是基线之后的话数", () => {
        expect(unreadCount(record({ newChapterIndexes: [2, 3, 4] }), null)).toBe(3);
    });

    it("有进度记录时只数进度之后的话（读完最新一话当场归零）", () => {
        const rec = record({ newChapterIndexes: [2, 3, 4] });
        expect(unreadCount(rec, progress(3))).toBe(1);
        expect(unreadCount(rec, progress(4))).toBe(0);
    });

    it("跳读留下的空档不计入（从第 1 话跳到第 100 话）", () => {
        const indexes = Array.from({ length: 99 }, (_, i) => i + 2);
        const rec = record({ newChapterIndexes: indexes });
        expect(unreadCount(rec, progress(100))).toBe(0);
        expect(unreadCount(rec, progress(50))).toBe(50);
    });
});

describe("rebuildFollowRecord（详情页重建基线）", () => {
    it("进度在新章节表里定位得到时，基线落到该话并带上它的话名", () => {
        const chapters = [
            chapter(10, { title: "甲" }),
            chapter(20, { title: "乙" }),
            chapter(30, { title: "丙" }),
        ];
        const out = rebuildFollowRecord(chapters, progress(20, "乙"), record({ needsRebuild: true }), 777);
        expect(out).toEqual({
            checkedAt: 777,
            baseline: { index: 20, title: "乙" },
            newChapterIndexes: [30],
            needsRebuild: false,
        });
    });

    it("chapterIndex 落不到时按进度里的 chapterTitle 落到新表那一话", () => {
        const chapters = [
            chapter(101, { title: "第一话" }),
            chapter(102, { title: "第二话" }),
            chapter(103, { title: "第三话" }),
        ];
        const out = rebuildFollowRecord(chapters, progress(7, "第二话"), record({ needsRebuild: true }), 0);
        expect(out.baseline).toEqual({ index: 102, title: "第二话" });
        expect(out.newChapterIndexes).toEqual([103]);
        expect(out.needsRebuild).toBe(false);
    });

    it("进度都落不到时基线落到最后一话，读者视为已追平（不显示积压）", () => {
        const chapters = [chapter(101), chapter(102), chapter(103)];
        const prog = progress(7, "不存在的话");
        const out = rebuildFollowRecord(chapters, prog, record({ needsRebuild: true }), 0);
        expect(out.baseline).toEqual({ index: 103, title: "第 103 话" });
        expect(out.newChapterIndexes).toEqual([]);
        expect(out.needsRebuild).toBe(false);
        expect(unreadCount(out, prog)).toBe(0);
    });

    it("没有进度记录时用记录里原有的基线重建", () => {
        const chapters = [chapter(1, { title: "甲" }), chapter(2, { title: "乙" })];
        const stale = record({ needsRebuild: true, baseline: { index: 9, title: "乙" } });
        const out = rebuildFollowRecord(chapters, null, stale, 5);
        expect(out.baseline).toEqual({ index: 2, title: "乙" });
        expect(out.needsRebuild).toBe(false);
    });

    it("落到最后一话时跳过外链章节", () => {
        const chapters = [chapter(1), chapter(2, { external: true })];
        const out = rebuildFollowRecord(chapters, progress(99, "不存在"), record({ needsRebuild: true }), 0);
        expect(out.baseline).toEqual({ index: 1, title: "第 1 话" });
    });

    it("新章节表里没有可作基线的非外链话时保持待重建", () => {
        const chapters = [chapter(2, { external: true })];
        const stale = record({ needsRebuild: true, baseline: { index: 99 } });
        expect(rebuildFollowRecord(chapters, null, stale, 0)).toBe(stale);
    });
});

describe("基线失配的积压回落（源改版）", () => {
    it("旧序号远高于重新编排的新表：重建前不显示角标，重建后也不出现积压", () => {
        // 旧进度记的是第 500 话；源改版后新表只有 4 话，序号重新编排
        const chapters = [chapter(1), chapter(2), chapter(3), chapter(4)];
        const prog = progress(500, "第五百话");
        const stale = record({ needsRebuild: true, baseline: { index: 500, title: "第五百话" } });
        expect(unreadCount(stale, prog)).toBe(0);

        const rebuilt = rebuildFollowRecord(chapters, prog, stale, 0);
        expect(rebuilt.needsRebuild).toBe(false);
        expect(rebuilt.baseline).toEqual({ index: 4, title: "第 4 话" });
        expect(unreadCount(rebuilt, prog)).toBe(0);
    });
});
