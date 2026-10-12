import type { Comic } from "../../api";
import { comicKey, FILES, getStore } from "./store";

/** 收藏存 Comic 快照，书架展示免回源。 */
export async function getFavorites(): Promise<Comic[]> {
    const store = await getStore(FILES.favorites);
    const entries = await store.entries<Comic>();
    return entries.map(([, comic]) => comic);
}

export async function isFavorite(source: string, comicId: string): Promise<boolean> {
    const store = await getStore(FILES.favorites);
    return store.has(comicKey(source, comicId));
}

/** 切换收藏状态，返回切换后的状态。 */
export async function toggleFavorite(comic: Comic): Promise<boolean> {
    const store = await getStore(FILES.favorites);
    const key = comicKey(comic.source, comic.id);
    if (await store.has(key)) {
        await store.delete(key);
        return false;
    }
    await store.set(key, comic);
    return true;
}
