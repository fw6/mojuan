//! 下载目录里的作品元数据（`<dir>/<source>/<comicId>/comic.json`）。
//!
//! 入队下载时写入作品标题、封面与各话标题；书架「下载」与「本地文件」列表据此显示
//! 封面与真实话名，不必回源抓取，断网也照常显示。
//! 与 `download_index.json` 同处一部作品的目录下，随整目录一起被删除。

use crate::native::paths::comic_dir;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

/// 一部作品的元数据。缺文件的目录（旧下载、用户自己的文件夹）读不到，按无元数据处理。
#[derive(Serialize, Deserialize, Default, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ComicMeta {
    pub source: String,
    pub comic_id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub cover: String,
    /// 话序号（与 `chapter_<n>` 目录名同一形式的十进制字符串）→ 章节标题
    #[serde(default)]
    pub chapters: HashMap<String, String>,
}

fn meta_path(dir: &str, source: &str, comic_id: &str) -> PathBuf {
    comic_dir(dir, source, comic_id).join("comic.json")
}

/// 读一部作品的元数据（文件缺失或损坏按无元数据处理）。
pub fn read(dir: &str, source: &str, comic_id: &str) -> Option<ComicMeta> {
    let raw = std::fs::read_to_string(meta_path(dir, source, comic_id)).ok()?;
    serde_json::from_str(&raw).ok()
}

/// 记下一话：作品标题与封面取最新值，章节表并入这一话。成功返回 true。
/// 下载队列入队时调用——下载是应用管理的数据，元数据与章节一起留在下载目录里。
pub fn record_chapter(
    dir: &str,
    source: &str,
    comic_id: &str,
    title: &str,
    cover: &str,
    chapter_index: i64,
    chapter_title: &str,
) -> bool {
    let path = meta_path(dir, source, comic_id);
    let mut meta = read(dir, source, comic_id).unwrap_or_default();
    meta.source = source.to_string();
    meta.comic_id = comic_id.to_string();
    if !title.is_empty() {
        meta.title = title.to_string();
    }
    if !cover.is_empty() {
        meta.cover = cover.to_string();
    }
    if !chapter_title.is_empty() {
        meta.chapters
            .insert(chapter_index.to_string(), chapter_title.to_string());
    }
    let Some(parent) = path.parent() else {
        return false;
    };
    if std::fs::create_dir_all(parent).is_err() {
        return false;
    }
    serde_json::to_string_pretty(&meta)
        .ok()
        .and_then(|s| std::fs::write(&path, s).ok())
        .is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mojuan-meta-test-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn record_merges_chapters_and_keeps_the_latest_title_and_cover() {
        let dir = temp_dir("merge");
        let d = dir.to_str().unwrap();
        assert!(record_chapter(d, "webtoons", "c1", "标题", "https://x/a.jpg", 1, "第 1 话"));
        assert!(record_chapter(d, "webtoons", "c1", "新标题", "https://x/b.jpg", 2, "第 2 话"));

        let meta = read(d, "webtoons", "c1").unwrap();
        assert_eq!(meta.title, "新标题");
        assert_eq!(meta.cover, "https://x/b.jpg");
        assert_eq!(meta.chapters.get("1").map(String::as_str), Some("第 1 话"));
        assert_eq!(meta.chapters.get("2").map(String::as_str), Some("第 2 话"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_metadata_reads_as_none() {
        let dir = temp_dir("missing");
        assert!(read(dir.to_str().unwrap(), "webtoons", "nope").is_none());
    }

    #[test]
    fn broken_file_reads_as_none() {
        let dir = temp_dir("broken");
        let d = dir.to_str().unwrap();
        assert!(record_chapter(d, "webtoons", "c1", "标题", "", 1, "第 1 话"));
        let path = meta_path(d, "webtoons", "c1");
        std::fs::write(&path, "not json").unwrap();
        assert!(read(d, "webtoons", "c1").is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
