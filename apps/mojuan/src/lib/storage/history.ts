import type { Comic } from "../../api";
import { comicKey, FILES, getStore } from "./store";

export interface HistoryRecord {
    comic: Comic;
    chapterIndex: number;
    lastReadAt: number;
}

// lastReadAt 严格递增：同毫秒内多次 touch 也能稳定排序（避免 Date.now() 相等）。
let lastTs = 0;
function nextTimestamp(): number {
    const now = Date.now();
    lastTs = Math.max(now, lastTs + 1);
    return lastTs;
}

/** 最近阅读，按 lastReadAt 倒序。 */
export async function getHistory(): Promise<HistoryRecord[]> {
    const store = await getStore(FILES.history);
    const entries = await store.entries<HistoryRecord>();
    return entries
        .map(([, record]) => record)
        .sort((a, b) => b.lastReadAt - a.lastReadAt);
}

export async function touchHistory(comic: Comic, chapterIndex: number): Promise<void> {
    const store = await getStore(FILES.history);
    await store.set(comicKey(comic.source, comic.id), {
        comic,
        chapterIndex,
        lastReadAt: nextTimestamp(),
    });
}
