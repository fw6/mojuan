import { describe, it, expect, beforeEach, vi } from "vitest";

// S3 seam：WebDAV 备份域（wayfinder #24/#25）。mock 插件层，验证聚合、版本校验与整体覆盖。

vi.mock("@tauri-apps/plugin-store", async () => (await import("./test-doubles")).storePlugin);

import { BACKUP_VERSION, exportBackupJson, importBackupData, parseBackupJson } from "./backup";
import { getFavorites, toggleFavorite } from "./favorites";
import { getHistory, touchHistory } from "./history";
import { getProgress, setProgress } from "./progress";
import { comicKey } from "./store";
import { resetDoubles, testComic } from "./test-doubles";

beforeEach(() => {
    resetDoubles();
});

describe("WebDAV 备份/恢复（wayfinder #24/#25）", () => {
    it("exportBackupJson 聚合三域为 {version, exportedAt, favorites, history, progress}", async () => {
        await toggleFavorite(testComic("a", "mangadex"));
        await touchHistory(testComic("b", "webtoons"), 2);
        await setProgress("mangadex", "a", {
            chapterIndex: 3,
            pageIndex: 4,
            offsetInPage: 0.5,
            updatedAt: 1000,
        });
        const json = await exportBackupJson();
        const data = parseBackupJson(json);
        expect(data.version).toBe(BACKUP_VERSION);
        expect(typeof data.exportedAt).toBe("number");
        expect(data.favorites[comicKey("mangadex", "a")].title).toBe("作品 a");
        expect(data.history[comicKey("webtoons", "b")].chapterIndex).toBe(2);
        expect(data.progress[comicKey("mangadex", "a")]).toMatchObject({
            pageIndex: 4,
            offsetInPage: 0.5,
        });
    });

    it("parseBackupJson 接受当前版本、拒绝其他版本", () => {
        const good = JSON.stringify({
            version: BACKUP_VERSION,
            exportedAt: 1,
            favorites: {},
            history: {},
            progress: {},
        });
        expect(parseBackupJson(good).version).toBe(BACKUP_VERSION);
        const bad = good.replace(`"version":${BACKUP_VERSION}`, '"version":999');
        expect(() => parseBackupJson(bad)).toThrow(/不受支持/);
    });

    it("importBackupData 整体覆盖本地三域（快照语义）", async () => {
        await toggleFavorite(testComic("old", "mangadex"));
        await importBackupData({
            version: BACKUP_VERSION,
            exportedAt: 1,
            favorites: { [comicKey("mangadex", "new")]: testComic("new", "mangadex") },
            history: {
                [comicKey("webtoons", "h")]: {
                    comic: testComic("h", "webtoons"),
                    chapterIndex: 5,
                    lastReadAt: 2000,
                },
            },
            progress: {
                [comicKey("mangadex", "new")]: {
                    chapterIndex: 7,
                    pageIndex: 3,
                    offsetInPage: 0.9,
                    updatedAt: 3000,
                },
            },
        });
        const favs = await getFavorites();
        expect(favs.map((c) => c.id)).toEqual(["new"]);
        const his = await getHistory();
        expect(his.map((r) => r.comic.id)).toEqual(["h"]);
        await expect(getProgress("mangadex", "new")).resolves.toMatchObject({
            chapterIndex: 7,
        });
        await expect(getProgress("mangadex", "old")).resolves.toBeNull();
    });
});
