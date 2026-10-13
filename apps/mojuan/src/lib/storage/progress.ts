import { comicKey, FILES, getStore } from "./store";

/** 阅读位置：话内第几张图 + 图内位置。用页码而不是整话比例，是因为比例乘的是
 * 「实测 + 估算」混合的整话总高，两次会话的混合构成不同会落到相邻的页上；
 * 页码在两次会话里指向同一张图（恢复与虚拟器渲染读的是同一份 measurementsCache）。 */
export interface ProgressRecord {
    chapterIndex: number;
    /** 该话的标题，随位置一起记下：详情页的「继续阅读」不必等章节表取到就能显示话名
     * （话序号只是源内部的 id）。改版前记下的记录没有这个字段。 */
    chapterTitle?: string;
    /** 话内图片下标（过滤后的章节页序，0 起）。 */
    pageIndex: number;
    /** 页内位置 0..1：长条漫一页好几屏，只记页码会跳很远。 */
    offsetInPage: number;
    updatedAt: number;
}

export async function getProgress(
    source: string,
    comicId: string,
): Promise<ProgressRecord | null> {
    const store = await getStore(FILES.progress);
    return (await store.get<ProgressRecord>(comicKey(source, comicId))) ?? null;
}

export async function setProgress(
    source: string,
    comicId: string,
    record: ProgressRecord,
): Promise<void> {
    const store = await getStore(FILES.progress);
    await store.set(comicKey(source, comicId), record);
}

/** 一次读出全部进度（书架要在一趟读里算出每一条的未读数）。键为 comicKey。 */
export async function getProgressAll(): Promise<Record<string, ProgressRecord>> {
    const store = await getStore(FILES.progress);
    return Object.fromEntries(await store.entries<ProgressRecord>());
}
