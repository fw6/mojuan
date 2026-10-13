import { describe, it, expect, vi, beforeEach } from "vitest";

// 生产检查的节流与手动路径：mock 存储域与 crawl，验证自动路径读/写上次检查时刻、
// 手动路径不受节流限制且不改写时刻。

vi.mock("../api", () => ({ crawl: vi.fn() }));
vi.mock("./storage/settings", () => ({ getSettings: vi.fn(), setSettings: vi.fn() }));
vi.mock("./storage/follow", () => ({ getFollowState: vi.fn(), setFollowState: vi.fn() }));
vi.mock("./storage/progress", () => ({ getProgress: vi.fn() }));
vi.mock("./storage/sources", () => ({ whenSourcesReady: vi.fn() }));

import { runFollowCheckNow, FOLLOW_THROTTLE_MS } from "./follow-check";
import { crawl, type Chapter, type Comic } from "../api";
import { getSettings, setSettings, type Settings } from "./storage/settings";
import { getFollowState, setFollowState } from "./storage/follow";
import { getProgress } from "./storage/progress";
import { whenSourcesReady } from "./storage/sources";

const mockedCrawl = vi.mocked(crawl);
const mockedGetSettings = vi.mocked(getSettings);
const mockedSetSettings = vi.mocked(setSettings);
const mockedGetFollowState = vi.mocked(getFollowState);
const mockedSetFollowState = vi.mocked(setFollowState);
const mockedGetProgress = vi.mocked(getProgress);
const mockedWhenSourcesReady = vi.mocked(whenSourcesReady);

function comic(id: string): Comic {
    return {
        id,
        source: "mangadex",
        sourceTitle: "mangadex",
        title: `作品 ${id}`,
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

function chapter(index: number): Chapter {
    return {
        index,
        title: `第 ${index} 话`,
        pages: [],
        external: false,
        downloaded: false,
        read: false,
    };
}

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

beforeEach(() => {
    vi.clearAllMocks();
    mockedWhenSourcesReady.mockResolvedValue(undefined);
    mockedGetSettings.mockResolvedValue(settings());
    mockedSetSettings.mockResolvedValue(undefined);
    mockedGetFollowState.mockResolvedValue(null);
    mockedSetFollowState.mockResolvedValue(undefined);
    mockedGetProgress.mockResolvedValue(null);
    mockedCrawl.mockResolvedValue({
        comic: comic("c1"),
        chapters: [chapter(1), chapter(2)],
    } as never);
});

describe("runFollowCheckNow（自动路径的节流）", () => {
    it("距上次检查不足 6 小时：不检查，也不改写上次检查时刻", async () => {
        mockedGetSettings.mockResolvedValue(
            settings({ followCheckedAt: Date.now() - 60 * 60 * 1000 }),
        );
        const result = await runFollowCheckNow([comic("c1")]);
        expect(result).toEqual({ updated: [], failures: [] });
        expect(mockedCrawl).not.toHaveBeenCalled();
        expect(mockedSetSettings).not.toHaveBeenCalled();
    });

    it("距上次检查超过 6 小时：检查一次并推进上次检查时刻", async () => {
        mockedGetSettings.mockResolvedValue(
            settings({ followCheckedAt: Date.now() - FOLLOW_THROTTLE_MS - 1000 }),
        );
        const result = await runFollowCheckNow([comic("c1")]);
        expect(mockedCrawl).toHaveBeenCalledTimes(1);
        expect(result.updated).toHaveLength(1);
        expect(mockedSetFollowState).toHaveBeenCalledTimes(1);
        expect(mockedSetSettings).toHaveBeenCalledWith({ followCheckedAt: expect.any(Number) });
    });

    it("从未检查过（followCheckedAt 为 null）：检查一次并写入时刻", async () => {
        const result = await runFollowCheckNow([comic("c1")]);
        expect(mockedCrawl).toHaveBeenCalledTimes(1);
        expect(result.updated).toHaveLength(1);
        expect(mockedSetSettings).toHaveBeenCalledWith({ followCheckedAt: expect.any(Number) });
    });

    it("手动刷新不受节流限制，且不改写上次检查时刻", async () => {
        mockedGetSettings.mockResolvedValue(
            settings({ followCheckedAt: Date.now() - 60 * 1000 }),
        );
        const result = await runFollowCheckNow([comic("c1")], { manual: true });
        expect(mockedCrawl).toHaveBeenCalledTimes(1);
        expect(result.updated).toHaveLength(1);
        expect(mockedSetSettings).not.toHaveBeenCalled();
    });
});
