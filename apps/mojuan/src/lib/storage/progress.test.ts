import { describe, it, expect, beforeEach, vi } from "vitest";

// S3 seam：进度域。mock 插件层，验证键隔离与覆盖写入。

vi.mock("@tauri-apps/plugin-store", async () => (await import("./test-doubles")).storePlugin);

import { getProgress, setProgress } from "./progress";
import { resetDoubles } from "./test-doubles";

beforeEach(() => {
    resetDoubles();
});

describe("进度 progress", () => {
    it("setProgress 后 getProgress 可读回，键按 source:comicId 隔离", async () => {
        await setProgress("mangadex", "c1", {
            chapterIndex: 3,
            pageIndex: 4,
            offsetInPage: 0.5,
            updatedAt: 1000,
        });
        await expect(getProgress("mangadex", "c1")).resolves.toEqual({
            chapterIndex: 3,
            pageIndex: 4,
            offsetInPage: 0.5,
            updatedAt: 1000,
        });
        await expect(getProgress("mangadex", "c2")).resolves.toBeNull();
        await expect(getProgress("webtoons", "c1")).resolves.toBeNull();
    });

    it("重读覆盖旧进度", async () => {
        await setProgress("mangadex", "c1", {
            chapterIndex: 1,
            pageIndex: 0,
            offsetInPage: 0.2,
            updatedAt: 100,
        });
        await setProgress("mangadex", "c1", {
            chapterIndex: 2,
            pageIndex: 7,
            offsetInPage: 0.8,
            updatedAt: 200,
        });
        await expect(getProgress("mangadex", "c1")).resolves.toMatchObject({
            chapterIndex: 2,
            pageIndex: 7,
            offsetInPage: 0.8,
        });
    });
});
