//! 页清单：一话目录里的 `.pages.json`，记录这一话完整的页序（页序号与 URL 一一对应）、
//! 每页写到磁盘的字节数（没下到的记 null）与取图用的 Referer。
//!
//! 页清单是「这一话应该有什么」的记录：完整性检查与补下都以它为准；旧下载没有这份文件。
//! 文件名以点开头，话目录的页列表与页数统计把它当元数据，不列出来。
//!
//! 「这一页在磁盘上是什么状态」的判定只有一处（`page_state`），完整性检查与修复入队共用：
//! 页文件存在且非空；并且当页清单里有这一页的记录时，字节数要与记录一致。页清单不存在
//! （旧下载）时，判定退化为「文件存在且非空」。

use crate::native::files::{chapter_dir, page_rel_path};
use crate::native::paths::comic_dir;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// 页清单的文件名（点开头：与页混在同一层目录里，页列表与页数统计据此排除）。
pub const FILE_NAME: &str = ".pages.json";

/// 页序里的一项：页序号（0 基，与 `page_rel_path` 的页号一致）与页 URL。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PageEntry {
    pub index: i64,
    pub url: String,
}

impl PageEntry {
    /// 从一串 URL 构造 0 基连续的页序（页序号 = 下标）。
    pub fn from_urls(urls: &[String]) -> Vec<PageEntry> {
        urls.iter()
            .enumerate()
            .map(|(i, url)| PageEntry {
                index: i as i64,
                url: url.clone(),
            })
            .collect()
    }
}

/// 页清单：`{"referer": "...", "pages": [{"url": "...", "bytes": 184320}, ...]}`。
/// `pages` 的下标就是页序号。
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct PageManifest {
    #[serde(default)]
    pub referer: String,
    #[serde(default)]
    pub pages: Vec<PageRecord>,
}

/// 页清单里的一页：URL 与写到磁盘的字节数（页不在磁盘上时为 null）。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PageRecord {
    pub url: String,
    pub bytes: Option<u64>,
}

/// 页清单文件路径（`<dir>/<source>/<comicId>/chapter_<n>/.pages.json`）。
fn manifest_path(dir: &str, source: &str, comic_id: &str, chapter_index: i64) -> PathBuf {
    chapter_dir(dir, source, comic_id, chapter_index).join(FILE_NAME)
}

/// 一页在作品目录下的绝对路径。
fn page_path(
    dir: &str,
    source: &str,
    comic_id: &str,
    chapter_index: i64,
    page_index: i64,
    url: &str,
) -> PathBuf {
    comic_dir(dir, source, comic_id).join(page_rel_path(chapter_index, page_index, url))
}

/// 读一话的页清单；文件不存在或解析失败返回 None。
pub fn read(dir: &str, source: &str, comic_id: &str, chapter_index: i64) -> Option<PageManifest> {
    fs::read_to_string(manifest_path(dir, source, comic_id, chapter_index))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
}

/// 写一话的页清单：`entries` 是这一话完整的页序，每页的字节数按磁盘上的文件大小填
/// （页不在磁盘上或为空文件记 null）。返回是否写入成功。
pub fn write(
    dir: &str,
    source: &str,
    comic_id: &str,
    chapter_index: i64,
    referer: &str,
    entries: &[PageEntry],
) -> bool {
    let manifest = PageManifest {
        referer: referer.to_string(),
        pages: entries
            .iter()
            .map(|entry| PageRecord {
                url: entry.url.clone(),
                bytes: disk_size(dir, source, comic_id, chapter_index, entry),
            })
            .collect(),
    };
    let path = manifest_path(dir, source, comic_id, chapter_index);
    let Some(parent) = path.parent() else {
        return false;
    };
    if fs::create_dir_all(parent).is_err() {
        return false;
    }
    serde_json::to_string(&manifest)
        .ok()
        .and_then(|s| fs::write(&path, s).ok())
        .is_some()
}

/// 一页在磁盘上的状态。
///
/// `Missing` 与 `Broken` 分开是为了让完整性检查报出「缺」与「损坏」的差别，
/// 修复入队只看「是不是 `Complete`」。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PageState {
    /// 文件存在、非空，且字节数与页清单一致（无页清单时只要求存在且非空）。
    Complete,
    /// 页文件不在。
    Missing,
    /// 文件在但为空，或字节数与页清单的记录不符。
    Broken,
}

/// 这一页在磁盘上是否完整（`page_state` 的布尔形式）。
pub fn page_complete(
    dir: &str,
    source: &str,
    comic_id: &str,
    chapter_index: i64,
    page_index: i64,
    url: &str,
) -> bool {
    page_state(dir, source, comic_id, chapter_index, page_index, url) == PageState::Complete
}

/// 这一页在磁盘上的状态。
///
/// 语义：页文件存在且非空；并且当页清单里有这一页的记录时，字节数要与记录一致。
/// 页清单不存在（旧下载）时，判定退化为「文件存在且非空」。
pub fn page_state(
    dir: &str,
    source: &str,
    comic_id: &str,
    chapter_index: i64,
    page_index: i64,
    url: &str,
) -> PageState {
    let path = page_path(dir, source, comic_id, chapter_index, page_index, url);
    let manifest = read(dir, source, comic_id, chapter_index);
    page_state_at(&path, manifest.as_ref(), page_index as usize)
}

/// 判定一页的状态，页清单由调用方给出（`None` 表示这一话没有清单，按「存在且非空」判）。
/// 路径由调用方按 `files::page_rel_path` 拼好——逐页检查的话不必每页都重读一次清单。
pub fn page_state_at(path: &Path, manifest: Option<&PageManifest>, page_index: usize) -> PageState {
    let Ok(meta) = fs::metadata(path) else {
        return PageState::Missing;
    };
    if !meta.is_file() {
        return PageState::Missing;
    }
    if meta.len() == 0 {
        return PageState::Broken;
    }
    match manifest.and_then(|m| m.pages.get(page_index)) {
        Some(record) if record.bytes != Some(meta.len()) => PageState::Broken,
        _ => PageState::Complete,
    }
}

/// 磁盘上这一页的字节数（文件不存在或为空返回 None）。
fn disk_size(
    dir: &str,
    source: &str,
    comic_id: &str,
    chapter_index: i64,
    entry: &PageEntry,
) -> Option<u64> {
    let path = page_path(
        dir,
        source,
        comic_id,
        chapter_index,
        entry.index,
        &entry.url,
    );
    non_empty_file_size(&path)
}

/// 文件存在且非空时返回它的字节数。
fn non_empty_file_size(path: &Path) -> Option<u64> {
    let meta = fs::metadata(path).ok()?;
    if meta.is_file() && meta.len() > 0 {
        Some(meta.len())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("mojuan-manifest-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn entries(urls: &[&str]) -> Vec<PageEntry> {
        urls.iter()
            .enumerate()
            .map(|(i, url)| PageEntry {
                index: i as i64,
                url: url.to_string(),
            })
            .collect()
    }

    #[test]
    fn write_records_the_page_order_and_disk_sizes() {
        let dir = temp_dir("write");
        let base = dir.to_str().unwrap();
        let chapter = chapter_dir(base, "webtoons", "c1", 1);
        fs::create_dir_all(&chapter).unwrap();
        let pages = entries(&["https://x/0.jpg", "https://x/1.jpg", "https://x/2.jpg"]);
        // 第 0、2 页在磁盘上，第 1 页没下到
        fs::write(chapter.join("0.jpg"), vec![0u8; 100]).unwrap();
        fs::write(chapter.join("2.jpg"), vec![0u8; 40]).unwrap();

        assert!(write(base, "webtoons", "c1", 1, "https://ref/", &pages));

        let m = read(base, "webtoons", "c1", 1).unwrap();
        assert_eq!(m.referer, "https://ref/");
        assert_eq!(m.pages.len(), 3);
        assert_eq!(
            m.pages[0],
            PageRecord {
                url: "https://x/0.jpg".to_string(),
                bytes: Some(100)
            }
        );
        assert_eq!(
            m.pages[1],
            PageRecord {
                url: "https://x/1.jpg".to_string(),
                bytes: None
            }
        );
        assert_eq!(
            m.pages[2],
            PageRecord {
                url: "https://x/2.jpg".to_string(),
                bytes: Some(40)
            }
        );

        // 文件格式钉住：点开头的文件、referer 与每页的 url/bytes
        let raw: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(chapter.join(FILE_NAME)).unwrap()).unwrap();
        assert_eq!(raw["referer"], "https://ref/");
        assert_eq!(raw["pages"][0]["url"], "https://x/0.jpg");
        assert_eq!(raw["pages"][0]["bytes"], 100);
        assert!(raw["pages"][1]["bytes"].is_null());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_returns_none_without_a_manifest() {
        let dir = temp_dir("none");
        fs::create_dir_all(chapter_dir(dir.to_str().unwrap(), "webtoons", "c1", 1)).unwrap();
        assert!(read(dir.to_str().unwrap(), "webtoons", "c1", 1).is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn page_complete_needs_a_non_empty_file_when_there_is_no_manifest() {
        let dir = temp_dir("complete-no-manifest");
        let base = dir.to_str().unwrap();
        let chapter = chapter_dir(base, "webtoons", "c1", 1);
        fs::create_dir_all(&chapter).unwrap();

        // 文件不在 → 不完整
        assert!(!page_complete(
            base,
            "webtoons",
            "c1",
            1,
            0,
            "https://x/0.jpg"
        ));
        // 空文件 → 不完整
        fs::write(chapter.join("0.jpg"), b"").unwrap();
        assert!(!page_complete(
            base,
            "webtoons",
            "c1",
            1,
            0,
            "https://x/0.jpg"
        ));
        // 存在且非空 → 完整
        fs::write(chapter.join("0.jpg"), b"abc").unwrap();
        assert!(page_complete(
            base,
            "webtoons",
            "c1",
            1,
            0,
            "https://x/0.jpg"
        ));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn page_complete_checks_bytes_against_the_manifest() {
        let dir = temp_dir("complete-manifest");
        let base = dir.to_str().unwrap();
        let chapter = chapter_dir(base, "webtoons", "c1", 1);
        fs::create_dir_all(&chapter).unwrap();
        let pages = entries(&["https://x/0.jpg", "https://x/1.jpg"]);
        fs::write(chapter.join("0.jpg"), b"abc").unwrap(); // 3 字节
        fs::write(chapter.join("1.jpg"), b"zz").unwrap();
        write(base, "webtoons", "c1", 1, "", &pages);

        // 字节数与清单一致 → 完整
        assert!(page_complete(
            base,
            "webtoons",
            "c1",
            1,
            0,
            "https://x/0.jpg"
        ));
        // 字节数与清单不符 → 不完整
        fs::write(chapter.join("0.jpg"), b"abcd").unwrap();
        assert!(!page_complete(
            base,
            "webtoons",
            "c1",
            1,
            0,
            "https://x/0.jpg"
        ));
        // 文件不在 → 不完整
        fs::remove_file(chapter.join("1.jpg")).unwrap();
        assert!(!page_complete(
            base,
            "webtoons",
            "c1",
            1,
            1,
            "https://x/1.jpg"
        ));
        // 清单记 null（没下到）但文件又出现 → 字节数不一致，判为不完整
        fs::write(chapter.join("1.jpg"), b"zz").unwrap();
        let mut m = read(base, "webtoons", "c1", 1).unwrap();
        m.pages[1].bytes = None;
        fs::write(
            manifest_path(base, "webtoons", "c1", 1),
            serde_json::to_string(&m).unwrap(),
        )
        .unwrap();
        assert!(!page_complete(
            base,
            "webtoons",
            "c1",
            1,
            1,
            "https://x/1.jpg"
        ));

        let _ = fs::remove_dir_all(&dir);
    }

    /// 缺失与损坏要分得开：文件不在是缺失，空文件与字节数不符是损坏。
    #[test]
    fn page_state_separates_missing_from_broken() {
        let dir = temp_dir("state");
        let base = dir.to_str().unwrap();
        let chapter = chapter_dir(base, "webtoons", "c1", 1);
        fs::create_dir_all(&chapter).unwrap();
        let pages = entries(&["https://x/0.jpg", "https://x/1.jpg", "https://x/2.jpg"]);
        fs::write(chapter.join("0.jpg"), b"abc").unwrap();
        write(base, "webtoons", "c1", 1, "", &pages);

        // 文件不在 → 缺失
        assert_eq!(
            page_state(base, "webtoons", "c1", 1, 1, "https://x/1.jpg"),
            PageState::Missing
        );
        // 空文件 → 损坏
        fs::write(chapter.join("2.jpg"), b"").unwrap();
        assert_eq!(
            page_state(base, "webtoons", "c1", 1, 2, "https://x/2.jpg"),
            PageState::Broken
        );
        // 字节数与清单不符 → 损坏
        fs::write(chapter.join("0.jpg"), b"abcd").unwrap();
        assert_eq!(
            page_state(base, "webtoons", "c1", 1, 0, "https://x/0.jpg"),
            PageState::Broken
        );
        // 与清单一致 → 完整
        fs::write(chapter.join("0.jpg"), b"abc").unwrap();
        assert_eq!(
            page_state(base, "webtoons", "c1", 1, 0, "https://x/0.jpg"),
            PageState::Complete
        );

        // 没有页清单时只看存在与空：非空即完整，空文件算损坏
        fs::remove_file(chapter.join(FILE_NAME)).unwrap();
        assert_eq!(
            page_state(base, "webtoons", "c1", 1, 0, "https://x/0.jpg"),
            PageState::Complete
        );
        fs::write(chapter.join("1.jpg"), b"").unwrap();
        assert_eq!(
            page_state(base, "webtoons", "c1", 1, 1, "https://x/1.jpg"),
            PageState::Broken
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
