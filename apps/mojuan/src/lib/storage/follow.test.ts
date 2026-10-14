import { describe, it, expect, beforeEach, vi } from "vitest";

// S3 seam：追更状态域。mock 插件层，验证读写、按 comicKey 隔离与缺记录时的默认值。

vi.mock("@tauri-apps/plugin-store", async () => (await import("./test-doubles")).storePlugin);

import {
    getFollowState,
    getFollowStates,
    removeFollowState,
    setFollowState,
    type FollowRecord,
} from "./follow";
import { resetDoubles } from "./test-doubles";

beforeEach(() => {
    resetDoubles();
});

function record(index: number, newChapterIndexes: number[] = []): FollowRecord {
    return {
        checkedAt: 1000,
        baseline: { index, title: `第 ${index} 话` },
        newChapterIndexes,
        needsRebuild: false,
    };
}

describe("追更状态 follow", () => {
    it("setFollowState 后 getFollowState 可读回，按 comicKey 隔离", async () => {
        await setFollowState("mangadex", "c1", record(5, [6, 7]));
        await expect(getFollowState("mangadex", "c1")).resolves.toEqual(record(5, [6, 7]));
        await expect(getFollowState("mangadex", "c2")).resolves.toBeNull();
        await expect(getFollowState("webtoons", "c1")).resolves.toBeNull();
    });

    it("getFollowStates 一次读出全部，键为 comicKey", async () => {
        await setFollowState("mangadex", "c1", record(5));
        await setFollowState("webtoons", "c2", record(9, [10]));
        await expect(getFollowStates()).resolves.toEqual({
            "mangadex:c1": record(5),
            "webtoons:c2": record(9, [10]),
        });
    });

    it("removeFollowState 只删指定那一条，其余不动", async () => {
        await setFollowState("mangadex", "c1", record(1));
        await setFollowState("mangadex", "c2", record(2));
        await removeFollowState("mangadex", "c1");
        await expect(getFollowState("mangadex", "c1")).resolves.toBeNull();
        await expect(getFollowState("mangadex", "c2")).resolves.toEqual(record(2));
    });
});
