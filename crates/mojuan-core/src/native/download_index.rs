//! 下载索引：URL → 本地文件路径的映射（wayfinder #31 离线也传 url）。
//!
//! 下载落盘时记录；img_proxy 端点凭 url 先查此索引（命中读下载文件），否则回落到
//! fetch_image 缓存。索引按漫画命名空间分层：`<dir>/<source>/<comicId>/download_index.json`。

use crate::native::paths::comic_dir;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

/// 单个漫画的下载索引（内存 JSON，单次下载/读取即全量加载/写盘）。
#[derive(Serialize, Deserialize, Default, Debug, Clone)]
pub struct DownloadIndex {
    /// url → 相对文件路径（相对于 comic_dir，如 `chapter_1/0.jpg`）
    pub map: HashMap<String, String>,
}

impl DownloadIndex {
    pub fn load(dir: &Path) -> Self {
        fs::read_to_string(dir)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, dir: &Path) -> bool {
        serde_json::to_string_pretty(self)
            .ok()
            .and_then(|s| fs::write(dir, s).ok())
            .is_some()
    }

    pub fn get(&self, url: &str) -> Option<&String> {
        self.map.get(url)
    }

    pub fn insert(&mut self, url: String, rel_path: String) {
        self.map.insert(url, rel_path);
    }
}

/// 索引文件路径。
fn index_path(dir: &str, source: &str, comic_id: &str) -> PathBuf {
    comic_dir(dir, source, comic_id).join("download_index.json")
}

/// 写入一条记录（url → 相对路径）。成功返回 true。
pub fn record_download(dir: &str, source: &str, comic_id: &str, url: &str, rel_path: &str) -> bool {
    let idx_path = index_path(dir, source, comic_id);
    let mut idx = DownloadIndex::load(&idx_path);
    idx.insert(url.to_string(), rel_path.to_string());
    idx.save(&idx_path)
}

/// 批量写入（章下载结束时一次性落盘）。成功返回 true。
pub fn record_downloads(dir: &str, source: &str, comic_id: &str, entries: &[(String, String)]) -> bool {
    let idx_path = index_path(dir, source, comic_id);
    let mut idx = DownloadIndex::load(&idx_path);
    for (url, rel_path) in entries {
        idx.insert(url.clone(), rel_path.clone());
    }
    idx.save(&idx_path)
}

/// 查找 url 对应的本地文件绝对路径（命中返回 Some(path)，未命中 None）。
pub fn find_downloaded_file(dir: &str, source: &str, comic_id: &str, url: &str) -> Option<PathBuf> {
    let idx_path = index_path(dir, source, comic_id);
    let idx = DownloadIndex::load(&idx_path);
    idx.get(url).map(|rel| comic_dir(dir, source, comic_id).join(rel))
}

/// 相对文件路径（`chapter_<n>/<file>`，相对这部作品的下载目录）→ 绝对路径。
/// 下载清单（`list_downloaded`）给出的 path 是相对形式，消费方据此定位磁盘文件。
pub fn resolve_downloaded_path(dir: &str, source: &str, comic_id: &str, rel: &str) -> PathBuf {
    comic_dir(dir, source, comic_id).join(rel)
}

/// list_downloaded 返回时把 url 带上（wayfinder #31：离线阅读器用 url 调用 img_proxy）。
/// 返回 JSON: `{chapterIndex: [{"url": "...", "path": "..."}]}`。
pub fn list_downloaded_with_urls(dir: &str, source: &str, comic_id: &str) -> String {
    let comic_path = comic_dir(dir, source, comic_id);
    let idx_path = index_path(dir, source, comic_id);
    let idx = DownloadIndex::load(&idx_path);

    let mut map = serde_json::Map::new();
    if let Ok(entries) = fs::read_dir(&comic_path) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            // 只处理 chapter_* 目录
            if let Some(idx_str) = name.strip_prefix("chapter_") {
                if let Ok(chapter_index) = idx_str.parse::<i64>() {
                    let mut files = Vec::new();
                    if let Ok(file_entries) = fs::read_dir(&path) {
                        for file_entry in file_entries.flatten() {
                            let file_path = file_entry.path();
                            if !file_path.is_file() {
                                continue;
                            }
                            let file_name = file_entry.file_name().to_string_lossy().to_string();
                            // 相对路径：chapter_<n>/<file>
                            let rel = format!("chapter_{}/{}", chapter_index, file_name);
                            // 在索引里找对应 url
                            let url = idx.map.iter().find_map(|(u, p)| {
                                if p == &rel { Some(u.clone()) } else { None }
                            }).unwrap_or_else(|| {
                                // 旧数据无索引：url 字段留空，消费方按 path 取文件
                                "".to_string()
                            });
                            files.push(serde_json::json!({ "url": url, "path": rel }));
                        }
                    }
                    files.sort_by(|a, b| a["path"].as_str().unwrap_or("").cmp(b["path"].as_str().unwrap_or("")));
                    if !files.is_empty() {
                        map.insert(chapter_index.to_string(), serde_json::Value::Array(files));
                    }
                }
            }
        }
    }
    serde_json::Value::Object(map).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mojuan-idx-test-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn record_and_find_single() {
        let dir = temp_dir("single");
        fs::create_dir_all(dir.join("webtoons").join("comic-a").join("chapter_1")).unwrap();
        let rel = "chapter_1/0.jpg";
        let abs = dir.join("webtoons").join("comic-a").join(rel);
        fs::write(&abs, b"x").unwrap();

        assert!(record_download(dir.to_str().unwrap(), "webtoons", "comic-a", "https://a/b.jpg", rel));
        let found = find_downloaded_file(dir.to_str().unwrap(), "webtoons", "comic-a", "https://a/b.jpg");
        assert_eq!(found, Some(abs));
        assert!(find_downloaded_file(dir.to_str().unwrap(), "webtoons", "comic-a", "https://missing").is_none());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn record_batch() {
        let dir = temp_dir("batch");
        fs::create_dir_all(dir.join("mangadex").join("c1").join("chapter_2")).unwrap();
        let entries = vec![
            ("https://a/1.jpg".to_string(), "chapter_2/1.jpg".to_string()),
            ("https://a/2.jpg".to_string(), "chapter_2/2.jpg".to_string()),
        ];
        for (_, rel) in &entries {
            fs::write(dir.join("mangadex").join("c1").join(rel), b"x").unwrap();
        }
        assert!(record_downloads(dir.to_str().unwrap(), "mangadex", "c1", &entries));
        assert_eq!(
            find_downloaded_file(dir.to_str().unwrap(), "mangadex", "c1", "https://a/1.jpg"),
            Some(dir.join("mangadex").join("c1").join("chapter_2/1.jpg"))
        );
        assert_eq!(
            find_downloaded_file(dir.to_str().unwrap(), "mangadex", "c1", "https://a/2.jpg"),
            Some(dir.join("mangadex").join("c1").join("chapter_2/2.jpg"))
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_downloaded_with_urls_includes_url() {
        let dir = temp_dir("list");
        fs::create_dir_all(dir.join("webtoons").join("c1").join("chapter_1")).unwrap();
        let rel = "chapter_1/0.jpg";
        fs::write(dir.join("webtoons").join("c1").join(rel), b"x").unwrap();
        record_download(dir.to_str().unwrap(), "webtoons", "c1", "https://u/0.jpg", rel);

        let json = list_downloaded_with_urls(dir.to_str().unwrap(), "webtoons", "c1");
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["1"][0]["url"], "https://u/0.jpg");
        assert_eq!(v["1"][0]["path"], "chapter_1/0.jpg");

        let _ = fs::remove_dir_all(&dir);
    }
}