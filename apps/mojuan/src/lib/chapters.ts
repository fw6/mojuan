import type { Chapter } from "../api";

/**
 * 外链章节过滤（grilling #6：external 标记，如 MangaDex externalUrl → MangaPlus）。
 * 过滤后不出现在章节列表，也不进入「下一话」。
 * 注意：detail op 不填充 pages（页面 URL 只在 images op 拉取），因此不能按 pages 判空过滤。
 */
export function filterExternalChapters(chapters: Chapter[]): Chapter[] {
    return chapters.filter((ch) => !ch.external);
}
