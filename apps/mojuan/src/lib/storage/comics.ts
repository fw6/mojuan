import type { Comic } from "../../api";
import { comicKey, FILES, getStore } from "./store";
import type { HistoryRecord } from "./history";

/**
 * 书架里记着的作品信息（收藏优先，其次历史）。详情页首屏先用它渲染，再拉最新覆盖：
 * 收藏与历史存的就是完整 Comic 快照，进详情不必等抓取。两个域都没有这部作品时返回 null。
 * 本模块不持有自己的存储，只跨域读（与 `backup.ts` 同一性质）。
 */
export async function getKnownComic(
    source: string,
    comicId: string,
): Promise<Comic | null> {
    const key = comicKey(source, comicId);
    const favorites = await getStore(FILES.favorites);
    const saved = await favorites.get<Comic>(key);
    if (saved) return saved;
    const history = await getStore(FILES.history);
    const record = await history.get<HistoryRecord>(key);
    return record?.comic ?? null;
}
