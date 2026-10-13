import { comicKey, FILES, getStore } from "./store";

/** 追更基线：判定未读的起点。有进度记录时随进度走，没有进度时是收藏那一刻的最后一话。 */
export interface FollowBaseline {
    index: number;
    title?: string;
}

/** 一部收藏作品的追更状态（不进 WebDAV 备份，可由收藏与进度重新算出）。 */
export interface FollowRecord {
    /** 最近一次成功检查的时刻（unix 毫秒）。 */
    checkedAt: number;
    /** 追更基线：判定未读的起点。有进度记录时随进度走，没有进度时是收藏那一刻的最后一话。 */
    baseline: FollowBaseline;
    /** 上次成功检查时，基线之后的非外链话序号（升序）。未读数由它与当前进度就地算出。 */
    newChapterIndexes: number[];
    /** 基线在当前章节表里定位不到（源改版）：角标暂不显示，等详情页重建。 */
    needsRebuild: boolean;
}

export async function getFollowState(
    source: string,
    comicId: string,
): Promise<FollowRecord | null> {
    const store = await getStore(FILES.follow);
    return (await store.get<FollowRecord>(comicKey(source, comicId))) ?? null;
}

/** 一次读出全部追更状态（书架要在一趟读里拿到每一条）。键为 comicKey。 */
export async function getFollowStates(): Promise<Record<string, FollowRecord>> {
    const store = await getStore(FILES.follow);
    return Object.fromEntries(await store.entries<FollowRecord>());
}

export async function setFollowState(
    source: string,
    comicId: string,
    record: FollowRecord,
): Promise<void> {
    const store = await getStore(FILES.follow);
    await store.set(comicKey(source, comicId), record);
}

/** 取消收藏时一并删掉：先取消再重新收藏不会捡回旧的基线。 */
export async function removeFollowState(source: string, comicId: string): Promise<void> {
    const store = await getStore(FILES.follow);
    await store.delete(comicKey(source, comicId));
}
