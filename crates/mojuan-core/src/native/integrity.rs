//! 完整性检查：按作品比对磁盘上的页与「这一话应该有什么」的记录。
//!
//! 有页清单的按清单比对（缺 = 文件不在；损坏 = 字节数与清单不符或文件为空），
//! 没有清单的旧下载按下载索引比对（缺 = 索引里的页文件不在；损坏 = 文件为空），
//! 并如实标明这一话的完整性没有被核对。判定与修复入队共用 `page_manifest::page_state_at`。
//!
//! 只读本地文件，不发网络请求。

use crate::native::download_index;
use crate::native::files::{chapter_index_from_dir_name, page_rel_path};
use crate::native::page_manifest::{self, PageState};
use crate::native::paths::comic_dir;
use serde::Serialize;
use std::fs;

/// 一话的检查结果。
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChapterReport {
    /// 话序号（`chapter_<n>` 目录名里的 n）。
    pub chapter_index: i64,
    /// 这一话的期望页数（有页清单取清单页数，没有取下载索引里属于这一话的条目数）。
    pub pages: usize,
    /// 缺失的页序号（0 基，与下载命名一致），升序。
    pub missing: Vec<i64>,
    /// 损坏的页序号，升序。
    pub broken: Vec<i64>,
    /// 这一话有没有页清单（没有时完整性没有被核对）。
    pub manifest: bool,
}

/// 一部作品的检查结果。
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IntegrityReport {
    pub chapters: Vec<ChapterReport>,
    pub missing_pages: usize,
    pub broken_files: usize,
    /// 没有页清单、因此完整性未被核对的话数。
    pub unchecked: usize,
}

/// 检查一部已下载作品：逐话给出页数、缺失页、损坏页与有没有页清单（JSON 字符串）。
/// 只读本地文件，不发网络请求。
pub fn check(dir: &str, source: &str, comic_id: &str) -> String {
    let report = report(dir, source, comic_id);
    // 报告只含数字、布尔与字符串，序列化不会失败；失败即不变量被破坏，就地崩溃，
    // 不允许回落到空报告——那等于谎报「没有任何缺失」。
    serde_json::to_value(&report)
        .expect("完整性报告序列化失败")
        .to_string()
}

/// 逐话检查并汇总。
fn report(dir: &str, source: &str, comic_id: &str) -> IntegrityReport {
    let chapters: Vec<ChapterReport> = chapter_indices(dir, source, comic_id)
        .into_iter()
        .map(|chapter_index| check_chapter(dir, source, comic_id, chapter_index))
        .collect();
    IntegrityReport {
        missing_pages: chapters.iter().map(|c| c.missing.len()).sum(),
        broken_files: chapters.iter().map(|c| c.broken.len()).sum(),
        unchecked: chapters.iter().filter(|c| !c.manifest).count(),
        chapters,
    }
}

/// 作品目录下的全部话序号（`chapter_<n>` 目录），升序。
fn chapter_indices(dir: &str, source: &str, comic_id: &str) -> Vec<i64> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(comic_dir(dir, source, comic_id)) else {
        return out;
    };
    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(index) = chapter_index_from_dir_name(&name) {
            out.push(index);
        }
    }
    out.sort_unstable();
    out
}

/// 检查一话：有页清单按清单比对，没有的旧下载按下载索引比对。
fn check_chapter(dir: &str, source: &str, comic_id: &str, chapter_index: i64) -> ChapterReport {
    let mut missing = Vec::new();
    let mut broken = Vec::new();
    let manifest = page_manifest::read(dir, source, comic_id, chapter_index);
    let pages = match &manifest {
        // 期望页数 = 清单里的页数；页序与页清单一一对应，页号就是下标
        Some(manifest) => manifest.pages.len(),
        // 旧下载：期望页数 = 索引里属于这一话的条目数
        None => download_index::chapter_pages(dir, source, comic_id, chapter_index).len(),
    };
    for (page_index, path) in page_files(dir, source, comic_id, chapter_index, manifest.as_ref()) {
        match page_manifest::page_state_at(&path, manifest.as_ref(), page_index as usize) {
            PageState::Complete => {}
            PageState::Missing => missing.push(page_index),
            PageState::Broken => broken.push(page_index),
        }
    }
    ChapterReport {
        chapter_index,
        pages,
        missing,
        broken,
        manifest: manifest.is_some(),
    }
}

/// 这一话要检查的页：`(页序号, 绝对路径)`，按页序号升序。
/// 有页清单时页序与页清单一致（清单就是「这一话应该有什么」），没有时取下载索引里的条目。
fn page_files(
    dir: &str,
    source: &str,
    comic_id: &str,
    chapter_index: i64,
    manifest: Option<&page_manifest::PageManifest>,
) -> Vec<(i64, std::path::PathBuf)> {
    match manifest {
        Some(manifest) => manifest
            .pages
            .iter()
            .enumerate()
            .map(|(i, record)| {
                let page_index = i as i64;
                let path = comic_dir(dir, source, comic_id).join(page_rel_path(
                    chapter_index,
                    page_index,
                    &record.url,
                ));
                (page_index, path)
            })
            .collect(),
        None => download_index::chapter_pages(dir, source, comic_id, chapter_index),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native::download_index;
    use crate::native::files::{chapter_dir, page_rel_path};
    use crate::native::page_manifest::{self, PageEntry};
    use crate::native::paths::comic_dir;
    use serde_json::Value;
    use std::fs;
    use std::path::PathBuf;

    const SOURCE: &str = "webtoons";
    const COMIC: &str = "c1";

    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("mojuan-integrity-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn urls(pages: usize) -> Vec<String> {
        (0..pages).map(|i| format!("https://x/{i}.jpg")).collect()
    }

    /// 一页的绝对路径（与下载落盘同一份命名规则）。
    fn page_file(base: &str, chapter: i64, page: i64, url: &str) -> PathBuf {
        comic_dir(base, SOURCE, COMIC).join(page_rel_path(chapter, page, url))
    }

    /// 造一话：按 `sizes` 写页文件（`None` 不写）；`manifest` 为真时按磁盘现状写页清单。
    fn make_chapter(base: &str, chapter: i64, sizes: &[Option<usize>], manifest: bool) {
        let urls = urls(sizes.len());
        fs::create_dir_all(chapter_dir(base, SOURCE, COMIC, chapter)).unwrap();
        for (i, size) in sizes.iter().enumerate() {
            if let Some(n) = size {
                fs::write(page_file(base, chapter, i as i64, &urls[i]), vec![0u8; *n]).unwrap();
            }
        }
        if manifest {
            let entries: Vec<PageEntry> = urls
                .iter()
                .enumerate()
                .map(|(i, url)| PageEntry {
                    index: i as i64,
                    url: url.clone(),
                })
                .collect();
            assert!(page_manifest::write(
                base,
                SOURCE,
                COMIC,
                chapter,
                "https://ref/",
                &entries
            ));
        }
    }

    /// 一话按下载索引落盘（没有页清单）：索引记着这几页，文件按 `sizes` 写。
    fn make_indexed_chapter(base: &str, chapter: i64, sizes: &[Option<usize>]) {
        let urls = urls(sizes.len());
        fs::create_dir_all(chapter_dir(base, SOURCE, COMIC, chapter)).unwrap();
        let entries: Vec<(String, String)> = urls
            .iter()
            .enumerate()
            .map(|(i, url)| (url.clone(), page_rel_path(chapter, i as i64, url)))
            .collect();
        for (i, size) in sizes.iter().enumerate() {
            if let Some(n) = size {
                fs::write(page_file(base, chapter, i as i64, &urls[i]), vec![0u8; *n]).unwrap();
            }
        }
        assert!(download_index::record_downloads(
            base, SOURCE, COMIC, &entries
        ));
    }

    fn report(base: &str) -> Value {
        serde_json::from_str(&check(base, SOURCE, COMIC)).unwrap()
    }

    /// 有页清单：删掉一个页文件报缺失，把一页写成不同长度报损坏。
    #[test]
    fn a_manifest_chapter_reports_missing_and_broken_pages() {
        let dir = temp_dir("manifest");
        let base = dir.to_str().unwrap();
        make_chapter(base, 1, &[Some(10), Some(20), Some(30), Some(40)], true);
        // 第 1 页的字节数与清单不符（清单记 20），第 3 页整个删掉
        fs::write(page_file(base, 1, 1, &urls(4)[1]), vec![0u8; 99]).unwrap();
        fs::remove_file(page_file(base, 1, 3, &urls(4)[3])).unwrap();

        let r = report(base);
        assert_eq!(r["chapters"].as_array().unwrap().len(), 1);
        let chapter = &r["chapters"][0];
        assert_eq!(chapter["chapterIndex"], 1);
        assert_eq!(chapter["pages"], 4);
        assert_eq!(chapter["missing"], serde_json::json!([3]));
        assert_eq!(chapter["broken"], serde_json::json!([1]));
        assert_eq!(chapter["manifest"], true);
        assert_eq!(r["missingPages"], 1);
        assert_eq!(r["brokenFiles"], 1);
        assert_eq!(r["unchecked"], 0);

        let _ = fs::remove_dir_all(&dir);
    }

    /// 没有页清单：按下载索引比对，页都在磁盘上就不报缺失，并标明完整性未核对。
    #[test]
    fn a_chapter_without_a_manifest_is_compared_against_the_download_index() {
        let dir = temp_dir("no-manifest");
        let base = dir.to_str().unwrap();
        make_indexed_chapter(base, 2, &[Some(10), Some(20), Some(30)]);

        let r = report(base);
        let chapter = &r["chapters"][0];
        assert_eq!(chapter["chapterIndex"], 2);
        assert_eq!(chapter["pages"], 3);
        assert_eq!(chapter["missing"], serde_json::json!([]));
        assert_eq!(chapter["broken"], serde_json::json!([]));
        assert_eq!(chapter["manifest"], false);
        assert_eq!(r["missingPages"], 0);
        assert_eq!(r["brokenFiles"], 0);
        assert_eq!(r["unchecked"], 1);

        let _ = fs::remove_dir_all(&dir);
    }

    /// 没有页清单时：索引里的页文件不在算缺失，空文件算损坏。
    #[test]
    fn a_chapter_without_a_manifest_reports_a_deleted_and_an_empty_page() {
        let dir = temp_dir("no-manifest-bad");
        let base = dir.to_str().unwrap();
        make_indexed_chapter(base, 2, &[Some(10), Some(20), Some(30)]);
        fs::remove_file(page_file(base, 2, 0, &urls(3)[0])).unwrap();
        fs::write(page_file(base, 2, 2, &urls(3)[2]), b"").unwrap();

        let r = report(base);
        let chapter = &r["chapters"][0];
        assert_eq!(chapter["pages"], 3);
        assert_eq!(chapter["missing"], serde_json::json!([0]));
        assert_eq!(chapter["broken"], serde_json::json!([2]));
        assert_eq!(chapter["manifest"], false);
        assert_eq!(r["unchecked"], 1);

        let _ = fs::remove_dir_all(&dir);
    }

    /// 逐话汇总：话按序号升序，三项合计与未核对话数都对。
    #[test]
    fn the_report_sums_pages_over_the_chapters() {
        let dir = temp_dir("sum");
        let base = dir.to_str().unwrap();
        // 第 1 话有清单、缺两页；第 3 话没有清单、缺一页；第 5 话完整
        make_chapter(base, 1, &[Some(10), None, None], true);
        make_indexed_chapter(base, 3, &[Some(10), None]);
        make_chapter(base, 5, &[Some(10), Some(20)], true);

        let r = report(base);
        let indices: Vec<i64> = r["chapters"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["chapterIndex"].as_i64().unwrap())
            .collect();
        assert_eq!(indices, vec![1, 3, 5]);
        assert_eq!(r["missingPages"], 3);
        assert_eq!(r["brokenFiles"], 0);
        assert_eq!(r["unchecked"], 1);
        assert_eq!(r["chapters"][2]["missing"], serde_json::json!([]));
        assert_eq!(r["chapters"][2]["manifest"], true);

        let _ = fs::remove_dir_all(&dir);
    }

    /// 点开头的元数据文件不算页；没有 `chapter_*` 前缀的目录不算一话。
    #[test]
    fn dot_files_and_non_chapter_dirs_are_ignored() {
        let dir = temp_dir("dot");
        let base = dir.to_str().unwrap();
        make_chapter(base, 1, &[Some(10), Some(20)], true);
        fs::create_dir_all(comic_dir(base, SOURCE, COMIC).join("misc")).unwrap();
        fs::write(
            comic_dir(base, SOURCE, COMIC).join("misc").join("x.bin"),
            vec![0u8; 50],
        )
        .unwrap();

        let r = report(base);
        assert_eq!(r["chapters"].as_array().unwrap().len(), 1);
        // 清单里的两页都在磁盘上，`.pages.json` 自己不算一页
        assert_eq!(r["chapters"][0]["pages"], 2);
        assert_eq!(r["missingPages"], 0);

        let _ = fs::remove_dir_all(&dir);
    }

    /// 作品目录不存在：空报告，不报错。
    #[test]
    fn a_missing_comic_directory_gives_an_empty_report() {
        let dir = temp_dir("absent");
        let r = report(dir.to_str().unwrap());
        assert_eq!(r["chapters"], serde_json::json!([]));
        assert_eq!(r["missingPages"], 0);
        assert_eq!(r["unchecked"], 0);

        let _ = fs::remove_dir_all(&dir);
    }
}
