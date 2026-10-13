import { describe, it, expect, vi } from "vitest";
import { runFollowCheck, type FollowCheckInput } from "./follow-check";
import type { Chapter, Comic } from "../api";
import type { FollowRecord } from "./storage/follow";
import type { ProgressRecord } from "./storage/progress";

// 检查编排：注入取详情 / 读进度 / 读状态的替身，验证串行检查的产出与失败清单。

function comic(id: string, source = "mangadex", title = `作品 ${id}`): Comic {
    return {
        id,
        source,
        sourceTitle: source,
        title,
        author: "",
        intro: "",
        cover: "",
        status: "serial",
        updateTime: "",
        lastChapter: "",
        tags: [],
        lastReadChapter: 0,
        lastReadTime: 0,
    };
}

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

function baseInput(over: Partial<FollowCheckInput> = {}): FollowCheckInput {
    return {
        favorites: [comic("c1")],
        now: 5000,
        getDetail: vi.fn().mockResolvedValue({ comic: comic("c1"), chapters: [chapter(1)] }),
        loadProgress: vi.fn().mockResolvedValue(null),
        loadState: vi.fn().mockResolvedValue(null),
        ...over,
    };
}

describe("runFollowCheck（逐部串行检查）", () => {
    it("有进度时以进度为基线，基线之后的话进列表", async () => {
        const progress: ProgressRecord = {
            chapterIndex: 1,
            chapterTitle: "第一话",
            pageIndex: 0,
            offsetInPage: 0,
            updatedAt: 0,
        };
        const input = baseInput({
            getDetail: vi
                .fn()
                .mockResolvedValue({ comic: comic("c1"), chapters: [chapter(1), chapter(2), chapter(3)] }),
            loadProgress: vi.fn().mockResolvedValue(progress),
        });
        const result = await runFollowCheck(input);
        expect(result.failures).toEqual([]);
        expect(result.updated).toEqual([
            {
                source: "mangadex",
                comicId: "c1",
                record: {
                    checkedAt: 5000,
                    baseline: { index: 1, title: "第一话" },
                    newChapterIndexes: [2, 3],
                    needsRebuild: false,
                },
            },
        ]);
    });

    it("没有进度也没有记录时，基线取新章节表的最后一话（老收藏不产生积压）", async () => {
        const input = baseInput({
            getDetail: vi
                .fn()
                .mockResolvedValue({ comic: comic("c1"), chapters: [chapter(1), chapter(2), chapter(3)] }),
        });
        const result = await runFollowCheck(input);
        expect(result.updated[0].record.baseline).toEqual({ index: 3, title: "第 3 话" });
        expect(result.updated[0].record.newChapterIndexes).toEqual([]);
    });

    it("已有记录时沿用记录里的基线", async () => {
        const record: FollowRecord = {
            checkedAt: 1,
            baseline: { index: 5, title: "第五话" },
            newChapterIndexes: [],
            needsRebuild: false,
        };
        const input = baseInput({
            getDetail: vi
                .fn()
                .mockResolvedValue({ comic: comic("c1"), chapters: [chapter(5), chapter(6)] }),
            loadState: vi.fn().mockResolvedValue(record),
        });
        const result = await runFollowCheck(input);
        expect(result.updated[0].record.baseline).toEqual({ index: 5, title: "第五话" });
        expect(result.updated[0].record.newChapterIndexes).toEqual([6]);
    });

    it("取详情抛错：该部进失败清单，其余照常检查", async () => {
        const input = baseInput({
            favorites: [comic("c1"), comic("c2")],
            getDetail: vi
                .fn()
                .mockRejectedValueOnce(new Error("fetch(detail): HTTP 500\n@1:2"))
                .mockResolvedValueOnce({ comic: comic("c2"), chapters: [chapter(1)] }),
        });
        const result = await runFollowCheck(input);
        expect(result.updated.map((u) => u.comicId)).toEqual(["c2"]);
        expect(result.failures).toEqual([
            {
                source: "mangadex",
                comicId: "c1",
                title: "作品 c1",
                reason: "fetch(detail): HTTP 500",
            },
        ]);
    });

    it("缺 comic 或章节表为空都算失败，不写入状态", async () => {
        const input = baseInput({
            favorites: [comic("c1"), comic("c2")],
            getDetail: vi
                .fn()
                .mockResolvedValueOnce({ chapters: [chapter(1)] })
                .mockResolvedValueOnce({ comic: comic("c2"), chapters: [] }),
        });
        const result = await runFollowCheck(input);
        expect(result.updated).toEqual([]);
        expect(result.failures.map((f) => f.comicId)).toEqual(["c1", "c2"]);
        expect(result.failures[0].reason).toBe("没有取到作品信息");
        expect(result.failures[1].reason).toBe("没有取到章节");
    });

    it("按收藏顺序逐部检查，updated 顺序与收藏一致", async () => {
        const order: string[] = [];
        const input = baseInput({
            favorites: [comic("a"), comic("b"), comic("c")],
            getDetail: vi.fn().mockImplementation((_source: string, comicId: string) => {
                order.push(comicId);
                return Promise.resolve({ comic: comic(comicId), chapters: [chapter(1)] });
            }),
        });
        const result = await runFollowCheck(input);
        expect(order).toEqual(["a", "b", "c"]);
        expect(result.updated.map((u) => u.comicId)).toEqual(["a", "b", "c"]);
    });
});
