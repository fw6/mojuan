import type { Chapter } from "../api";

/**
 * 外链章节过滤（grilling #6：external 标记，如 MangaDex externalUrl → MangaPlus）。
 * 过滤后不出现在章节列表，也不进入「下一话」。
 * 注意：detail op 不填充 pages（页面 URL 只在 images op 拉取），因此不能按 pages 判空过滤。
 */
export function filterExternalChapters(chapters: Chapter[]): Chapter[] {
    return chapters.filter((ch) => !ch.external);
}

/**
 * 章节的展示名：源给的标题优先。
 * 话序号只是源内部的 id（漫画柜是七八位数字，kxmanhua 是 `/detail/` 后面那串），
 * 拿它当名字显示会看到一长串数字，所以只在标题缺失时回落到「第 N 话」。
 */
export function chapterLabel(title: string | undefined, index: number): string {
    return title || `第 ${index} 话`;
}
