//! 下载索引：URL → 本地文件路径的映射（wayfinder #31 离线也传 url）。
//!
//! 下载落盘时记录；img_proxy 端点凭 url 先查此索引（命中读下载文件），否则回落到
//! fetch_image 缓存。索引按漫画命名空间分层：`<dir>/<source>/<comicId>/download_index.json`。

use crate::native::paths::comic_dir;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

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

/// 写入的串行锁：两个 worker 同时结束各自的一话时，两次「读—改—写」交错会让后写的
/// 那次把先写的那批条目覆盖掉（索引按 url 存，丢一条就等于那一页没下载过）。
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// 写入一条记录（url → 相对路径）。成功返回 true。
pub fn record_download(dir: &str, source: &str, comic_id: &str, url: &str, rel_path: &str) -> bool {
    record_downloads(
        dir,
        source,
        comic_id,
        &[(url.to_string(), rel_path.to_string())],
    )
}

/// 批量写入（一话下载结束时一次性落盘）。成功返回 true。
pub fn record_downloads(
    dir: &str,
    source: &str,
    comic_id: &str,
    entries: &[(String, String)],
) -> bool {
    let _writing = WRITE_LOCK.lock().unwrap();
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
    idx.get(url)
        .map(|rel| comic_dir(dir, source, comic_id).join(rel))
}

/// 相对文件路径（`chapter_<n>/<file>`，相对这部作品的下载目录）→ 绝对路径。
/// 下载清单（`list_downloaded`）给出的 path 是相对形式，消费方据此定位磁盘文件。
pub fn resolve_downloaded_path(dir: &str, source: &str, comic_id: &str, rel: &str) -> PathBuf {
    comic_dir(dir, source, comic_id).join(rel)
}

/// list_downloaded 返回时把 url 带上（wayfinder #31：离线阅读器用 url 调用 img_proxy）。
/// 每话的页按页号排序（阅读器照这个顺序显示，比较见 `natural_cmp`）。
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
                    // (文件名, url)：文件名留着排序用，url 为空表示旧数据没有索引记录
                    let mut files: Vec<(String, String)> = Vec::new();
                    if let Ok(file_entries) = fs::read_dir(&path) {
                        for file_entry in file_entries.flatten() {
                            let file_path = file_entry.path();
                            if !file_path.is_file() {
                                continue;
                            }
                            let file_name = file_entry.file_name().to_string_lossy().to_string();
                            // 点开头的文件是元数据（页清单 `.pages.json`），不算一页
                            if file_name.starts_with('.') {
                                continue;
                            }
                            // 相对路径：chapter_<n>/<file>
                            let rel = format!("chapter_{}/{}", chapter_index, file_name);
                            // 在索引里找对应 url
                            let url = idx
                                .map
                                .iter()
                                .find_map(|(u, p)| if p == &rel { Some(u.clone()) } else { None })
                                .unwrap_or_else(|| {
                                    // 旧数据无索引：url 字段留空，消费方按 path 取文件
                                    "".to_string()
                                });
                            files.push((file_name, url));
                        }
                    }
                    files.sort_by(|(a, _), (b, _)| natural_cmp(a, b));
                    if !files.is_empty() {
                        let pages: Vec<serde_json::Value> = files
                            .into_iter()
                            .map(|(file_name, url)| {
                                serde_json::json!({
                                    "url": url,
                                    "path": format!("chapter_{}/{}", chapter_index, file_name),
                                })
                            })
                            .collect();
                        map.insert(chapter_index.to_string(), serde_json::Value::Array(pages));
                    }
                }
            }
        }
    }
    serde_json::Value::Object(map).to_string()
}

/// 页序比较：数字段按数值比（`2` 排在 `10` 前面），其余按字节比。
///
/// 下载产生的页文件名是 `{页号}.{扩展名}`（0 基、不补零），纯字符串序会把
/// `10.jpg` 排到 `2.jpg` 前面，25 页的一话因此显示成 1,2,11,12,…,20,3,21,…,25,4,…,10。
/// 用户自己导入的文件夹里名字是任意的（`page-1.jpg` 这类前缀），数字段仍按数值排。
fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (ab, bb) = (a.as_bytes(), b.as_bytes());
    let (mut i, mut j) = (0, 0);
    loop {
        match (ab.get(i), bb.get(j)) {
            (None, None) => return a.cmp(b),
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) => {
                if x.is_ascii_digit() && y.is_ascii_digit() {
                    let (an, next_a) = digit_run(ab, i);
                    let (bn, next_b) = digit_run(bb, j);
                    // 去掉前导零后，长度即数量级，长度相同再按字节比
                    let ord = an.len().cmp(&bn.len()).then_with(|| an.cmp(bn));
                    if ord != Ordering::Equal {
                        return ord;
                    }
                    (i, j) = (next_a, next_b);
                } else {
                    if x != y {
                        return x.cmp(y);
                    }
                    i += 1;
                    j += 1;
                }
            }
        }
    }
}

/// `bytes[i]` 起的连续数字段（去掉前导零）与它的结束位置。
fn digit_run(bytes: &[u8], i: usize) -> (&[u8], usize) {
    let mut end = i;
    while end < bytes.len() && bytes[end].is_ascii_digit() {
        end += 1;
    }
    let mut digits = &bytes[i..end];
    while digits.len() > 1 && digits[0] == b'0' {
        digits = &digits[1..];
    }
    (digits, end)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("mojuan-idx-test-{}-{}", tag, std::process::id()));
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

        assert!(record_download(
            dir.to_str().unwrap(),
            "webtoons",
            "comic-a",
            "https://a/b.jpg",
            rel
        ));
        let found = find_downloaded_file(
            dir.to_str().unwrap(),
            "webtoons",
            "comic-a",
            "https://a/b.jpg",
        );
        assert_eq!(found, Some(abs));
        assert!(find_downloaded_file(
            dir.to_str().unwrap(),
            "webtoons",
            "comic-a",
            "https://missing"
        )
        .is_none());

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
        assert!(record_downloads(
            dir.to_str().unwrap(),
            "mangadex",
            "c1",
            &entries
        ));
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
        record_download(
            dir.to_str().unwrap(),
            "webtoons",
            "c1",
            "https://u/0.jpg",
            rel,
        );

        let json = list_downloaded_with_urls(dir.to_str().unwrap(), "webtoons", "c1");
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["1"][0]["url"], "https://u/0.jpg");
        assert_eq!(v["1"][0]["path"], "chapter_1/0.jpg");

        let _ = fs::remove_dir_all(&dir);
    }

    /// 页文件名是 `{页号}.{扩展名}`（0 基、不补零），按字符串排会把 `10.jpg` 排到
    /// `2.jpg` 前面：25 页的一话显示成 1,2,11,12,…,20,3,21,…,25,4,…,10。
    #[test]
    fn list_downloaded_sorts_pages_by_page_number() {
        let dir = temp_dir("page_order");
        let chapter = dir.join("baozimh").join("comic-a").join("chapter_1");
        fs::create_dir_all(&chapter).unwrap();
        // 按字符串序写入，确保不是靠 read_dir 的偶然顺序过关
        for name in [
            "0.jpg", "1.jpg", "10.jpg", "11.jpg", "2.jpg", "3.jpg", "4.jpg",
        ] {
            fs::write(chapter.join(name), b"x").unwrap();
        }

        let json = list_downloaded_with_urls(dir.to_str().unwrap(), "baozimh", "comic-a");
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        let paths: Vec<&str> = v["1"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["path"].as_str().unwrap())
            .collect();
        assert_eq!(
            paths,
            vec![
                "chapter_1/0.jpg",
                "chapter_1/1.jpg",
                "chapter_1/2.jpg",
                "chapter_1/3.jpg",
                "chapter_1/4.jpg",
                "chapter_1/10.jpg",
                "chapter_1/11.jpg",
            ]
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// 页清单（`.pages.json`）与页混在同一层目录里，页列表不能把它算成一页。
    #[test]
    fn list_downloaded_skips_dot_files() {
        let dir = temp_dir("dot_files");
        let chapter = dir.join("webtoons").join("c1").join("chapter_1");
        fs::create_dir_all(&chapter).unwrap();
        for name in ["0.jpg", "1.jpg", ".pages.json"] {
            fs::write(chapter.join(name), b"x").unwrap();
        }

        let json = list_downloaded_with_urls(dir.to_str().unwrap(), "webtoons", "c1");
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        let paths: Vec<&str> = v["1"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["path"].as_str().unwrap())
            .collect();
        assert_eq!(paths, vec!["chapter_1/0.jpg", "chapter_1/1.jpg"]);

        let _ = fs::remove_dir_all(&dir);
    }

    /// 用户自己导入的文件夹里文件名是任意的，带数字前缀的仍按数值排。
    #[test]
    fn list_downloaded_sorts_user_named_pages_naturally() {
        let dir = temp_dir("page_order_user");
        // 扁平布局（source = local）的作品目录就在下载目录下一层
        let chapter = dir.join("我的漫画").join("chapter_1");
        fs::create_dir_all(&chapter).unwrap();
        for name in ["page-10.jpg", "page-2.jpg", "page-1.jpg"] {
            fs::write(chapter.join(name), b"x").unwrap();
        }

        let json = list_downloaded_with_urls(dir.to_str().unwrap(), "local", "我的漫画");
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        let paths: Vec<&str> = v["1"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["path"].as_str().unwrap())
            .collect();
        assert_eq!(
            paths,
            vec![
                "chapter_1/page-1.jpg",
                "chapter_1/page-2.jpg",
                "chapter_1/page-10.jpg"
            ]
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
