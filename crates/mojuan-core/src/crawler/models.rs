//! 爬虫领域模型：与前端 `apps/mojuan/src/api.ts` 的 Comic/Chapter 结构一一对应。
//! 通过 serde 以 camelCase 序列化为 JSON，经 `crawl` 命令返回给 JS 层。

use serde::Serialize;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Comic {
    pub id: String,
    pub source: String,
    pub source_title: String,
    pub title: String,
    pub author: String,
    pub intro: String,
    pub cover: String,
    /// "finish" | "serial"
    pub status: String,
    pub update_time: String,
    pub last_chapter: String,
    pub tags: Vec<String>,
    pub last_read_chapter: i32,
    pub last_read_time: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Chapter {
    /// 章节号（MangaDex 可能为小数，如 1.5；Webtoons 为整数话数）
    pub index: f64,
    pub title: String,
    pub pages: Vec<String>,
    /// 外链章节（如 MangaDex 上指向 MangaPlus 的章节）：列表与「下一话」一律过滤（grilling #6）
    pub external: bool,
    pub downloaded: bool,
    pub read: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Detail {
    pub comic: Comic,
    pub chapters: Vec<Chapter>,
}
