import { describe, it, expect, vi, beforeEach } from "vitest";

// 生产入口 runFollowCheckNow 走真实依赖：mock 掉取源与三处存储域，注入替身观察是否读源。
vi.mock("../api", () => ({
    crawl: vi.fn(),
}));
vi.mock("./storage/settings", () => ({
    getSettings: vi.fn(),
    setSettings: vi.fn(),
}));
vi.mock("./storage/follow", () => ({
    getFollowState: vi.fn(),
    setFollowState: vi.fn(),
}));
vi.mock("./storage/progress", () => ({
    getProgress: vi.fn(),
}));
vi.mock("./storage/sources", () => ({
    whenSourcesReady: vi.fn(),
}));

import { runFollowCheck, runFollowCheckNow, type FollowCheckInput } from "./follow-check";
import { crawl } from "../api";
import { getSettings, type Settings } from "./storage/settings";
import { getFollowState, setFollowState } from "./storage/follow";
import { getProgress } from "./storage/progress";
import { whenSourcesReady } from "./storage/sources";
import type { Chapter, Comic } from "../api";
import type { FollowRecord } from "./storage/follow";
import type { ProgressRecord } from "./storage/progress";

const mockedCrawl = vi.mocked(crawl);
const mockedSettings = vi.mocked(getSettings);
const mockedFollowState = vi.mocked(getFollowState);
const mockedSetFollowState = vi.mocked(setFollowState);
const mockedProgress = vi.mocked(getProgress);
const mockedReady = vi.mocked(whenSourcesReady);

function settings(over: Partial<Settings> = {}): Settings {
    return {
        downloadDir: null,
        darkMode: false,
        autoTrim: false,
        followUpdate: true,
        lastSource: null,
        lastCategory: {},
        followCheckedAt: null,
        ...over,
    };
}

// 检查编排：注入取详情 / 读进度 / 读状态的替身，验证请求预算（节流、排序、上限、并发）
// 与失败清单的产出。

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
        lastCheckedAt: null,
        throttleMs: 6 * 60 * 60 * 1000,
        limit: 50,
        concurrency: 2,
        getDetail: vi.fn().mockResolvedValue({ comic: comic("c1"), chapters: [chapter(1)] }),
        loadProgress: vi.fn().mockResolvedValue(null),
        loadState: vi.fn().mockResolvedValue(null),
        ...over,
    };
}

function record(checkedAt: number): FollowRecord {
    return { checkedAt, baseline: { index: 1 }, newChapterIndexes: [], needsRebuild: false };
}

describe("runFollowCheck（逐部检查）", () => {
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

    it("兜底基线跳过外链章节，落在最后一话非外链话上", async () => {
        const input = baseInput({
            getDetail: vi.fn().mockResolvedValue({
                comic: comic("c1"),
                chapters: [chapter(1), chapter(2), chapter(3, { external: true })],
            }),
        });
        const result = await runFollowCheck(input);
        expect(result.updated[0].record.baseline).toEqual({ index: 2, title: "第 2 话" });
        expect(result.updated[0].record.newChapterIndexes).toEqual([]);
    });

    it("章节全是外链时没有可作基线的非外链话：进失败清单，不写状态", async () => {
        const input = baseInput({
            getDetail: vi.fn().mockResolvedValue({
                comic: comic("c1"),
                chapters: [chapter(1, { external: true })],
            }),
        });
        const result = await runFollowCheck(input);
        expect(result.updated).toEqual([]);
        expect(result.failures).toEqual([
            { source: "mangadex", comicId: "c1", title: "作品 c1", reason: "没有可用的章节" },
        ]);
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

describe("runFollowCheck（请求预算）", () => {
    it("距上次检查不足节流窗口：返回空结果，连取详情都不调", async () => {
        const getDetail = vi.fn();
        const input = baseInput({ lastCheckedAt: 4000, now: 5000, throttleMs: 2000, getDetail });
        const result = await runFollowCheck(input);
        expect(result).toEqual({ updated: [], failures: [] });
        expect(getDetail).not.toHaveBeenCalled();
    });

    it("刚好到达节流窗口就检查", async () => {
        const getDetail = vi.fn().mockResolvedValue({ comic: comic("c1"), chapters: [chapter(1)] });
        const input = baseInput({ lastCheckedAt: 3000, now: 5000, throttleMs: 2000, getDetail });
        const result = await runFollowCheck(input);
        expect(getDetail).toHaveBeenCalledTimes(1);
        expect(result.updated).toHaveLength(1);
    });

    it("从未检查过（lastCheckedAt 为 null）不节流", async () => {
        const getDetail = vi.fn().mockResolvedValue({ comic: comic("c1"), chapters: [chapter(1)] });
        const input = baseInput({ lastCheckedAt: null, now: 5000, throttleMs: 2000, getDetail });
        await runFollowCheck(input);
        expect(getDetail).toHaveBeenCalledTimes(1);
    });

    it("按最久未检查优先：从未检查的排最前，其次 checkedAt 升序，同刻按收藏顺序", async () => {
        const records: Record<string, FollowRecord | null> = {
            a: record(300),
            b: null,
            c: record(100),
            d: null,
            e: record(100),
        };
        const checked: string[] = [];
        const input = baseInput({
            favorites: ["a", "b", "c", "d", "e"].map((id) => comic(id)),
            concurrency: 1,
            loadState: vi
                .fn()
                .mockImplementation((_source: string, comicId: string) =>
                    Promise.resolve(records[comicId] ?? null),
                ),
            getDetail: vi.fn().mockImplementation((_source: string, comicId: string) => {
                checked.push(comicId);
                return Promise.resolve({ comic: comic(comicId), chapters: [chapter(1)] });
            }),
        });
        await runFollowCheck(input);
        // b、d 从未检查（按收藏顺序）；c、e 同为 100（按收藏顺序）；最后 a
        expect(checked).toEqual(["b", "d", "c", "e", "a"]);
    });

    it("单次最多检查 limit 部，取最久未检查的", async () => {
        const records: Record<string, FollowRecord | null> = {
            a: record(300),
            b: record(100),
            c: record(200),
            d: record(50),
            e: record(400),
        };
        const checked: string[] = [];
        const input = baseInput({
            favorites: ["a", "b", "c", "d", "e"].map((id) => comic(id)),
            limit: 2,
            loadState: vi
                .fn()
                .mockImplementation((_source: string, comicId: string) =>
                    Promise.resolve(records[comicId] ?? null),
                ),
            getDetail: vi.fn().mockImplementation((_source: string, comicId: string) => {
                checked.push(comicId);
                return Promise.resolve({ comic: comic(comicId), chapters: [chapter(1)] });
            }),
        });
        const result = await runFollowCheck(input);
        // 最久未检查的是 d（50）与 b（100）
        expect(checked.sort()).toEqual(["b", "d"]);
        expect(result.updated.map((u) => u.comicId).sort()).toEqual(["b", "d"]);
    });

    it("并发不超过 concurrency，且确实并行", async () => {
        let inFlight = 0;
        let peak = 0;
        const input = baseInput({
            favorites: ["a", "b", "c", "d", "e"].map((id) => comic(id)),
            concurrency: 2,
            getDetail: vi.fn().mockImplementation(async () => {
                inFlight += 1;
                peak = Math.max(peak, inFlight);
                await new Promise((resolve) => setTimeout(resolve, 1));
                inFlight -= 1;
                return { comic: comic("x"), chapters: [chapter(1)] };
            }),
        });
        await runFollowCheck(input);
        expect(peak).toBe(2);
    });

    it("失败的作品不进 updated（磁盘上上一次的状态保持不变）", async () => {
        const input = baseInput({
            favorites: [comic("ok"), comic("bad")],
            loadState: vi.fn().mockResolvedValue(record(100)),
            getDetail: vi
                .fn()
                .mockImplementation((_source: string, comicId: string) =>
                    comicId === "bad"
                        ? Promise.reject(new Error("fetch(detail): HTTP 500"))
                        : Promise.resolve({ comic: comic(comicId), chapters: [chapter(1)] }),
                ),
        });
        const result = await runFollowCheck(input);
        expect(result.updated.map((u) => u.comicId)).toEqual(["ok"]);
        expect(result.failures.map((f) => f.comicId)).toEqual(["bad"]);
        expect(result.failures[0].reason).toBe("fetch(detail): HTTP 500");
    });

    it("updated 与 failures 都按实际检查顺序排列", async () => {
        const records: Record<string, FollowRecord | null> = {
            a: record(300),
            b: record(200),
            c: record(100),
        };
        const input = baseInput({
            favorites: [comic("a"), comic("b"), comic("c")],
            loadState: vi
                .fn()
                .mockImplementation((_source: string, comicId: string) =>
                    Promise.resolve(records[comicId] ?? null),
                ),
            getDetail: vi
                .fn()
                .mockImplementation((_source: string, comicId: string) =>
                    comicId === "b"
                        ? Promise.reject(new Error("HTTP 500"))
                        : Promise.resolve({ comic: comic(comicId), chapters: [chapter(1)] }),
                ),
        });
        const result = await runFollowCheck(input);
        expect(result.updated.map((u) => u.comicId)).toEqual(["c", "a"]);
        expect(result.failures.map((f) => f.comicId)).toEqual(["b"]);
    });
});

describe("runFollowCheckNow（生产入口：书架追更开关）", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockedSettings.mockResolvedValue(settings());
        mockedCrawl.mockResolvedValue({ comic: comic("c1"), chapters: [chapter(1)] });
        mockedProgress.mockResolvedValue(null);
        mockedFollowState.mockResolvedValue(null);
        mockedSetFollowState.mockResolvedValue(undefined);
        mockedReady.mockResolvedValue(undefined);
    });

    it("书架追更关闭时自动检查直接返回空结果，一次也不读源", async () => {
        mockedSettings.mockResolvedValue(settings({ followUpdate: false }));
        const result = await runFollowCheckNow([comic("c1")]);
        expect(result).toEqual({ updated: [], failures: [] });
        expect(mockedCrawl).not.toHaveBeenCalled();
        expect(mockedSetFollowState).not.toHaveBeenCalled();
    });

    it("手动刷新不受开关限制，开关关闭也照常读源", async () => {
        mockedSettings.mockResolvedValue(settings({ followUpdate: false }));
        const result = await runFollowCheckNow([comic("c1")], { manual: true });
        expect(mockedCrawl).toHaveBeenCalledWith("detail", "mangadex", { comicId: "c1" });
        expect(result.updated.map((u) => u.comicId)).toEqual(["c1"]);
    });

    it("开关开启时自动检查照常读源并写入状态", async () => {
        const result = await runFollowCheckNow([comic("c1")]);
        expect(mockedCrawl).toHaveBeenCalledTimes(1);
        expect(result.updated).toHaveLength(1);
        expect(mockedSetFollowState).toHaveBeenCalledTimes(1);
    });
});
