//! 补下：按话算出磁盘上还缺哪些页，建出只下这些页的修复任务。
//!
//! 页序的来源：这一话有页清单时用清单里的页序；没有清单的旧下载用调用方给出的页表
//! （源返回的 `images` 结果）。要补的页 = 判定不是 `PageState::Complete` 的页
//! （与完整性检查共用 `page_manifest::page_state_at`）。
//! 每一页都完整时没有任务，调用方据此返回「没有需要补的页」而不入队。

use crate::native::comic_meta;
use crate::native::files::page_rel_path;
use crate::native::page_manifest::{self, PageEntry, PageState};
use crate::native::paths::comic_dir;
use crate::native::queue::DownloadTask;

/// 一话的补下任务：完整页序 + 只下不完整的页。每一页都完整时返回 `None`。
/// `page_table` 是这一话的页表（源给出的 URL 列表），只在没有页清单时用来重建页序。
pub fn task(
    dir: &str,
    source: &str,
    comic_id: &str,
    chapter_index: i64,
    referer: &str,
    page_table: &[String],
) -> Option<DownloadTask> {
    let manifest = page_manifest::read(dir, source, comic_id, chapter_index);
    let pages: Vec<PageEntry> = match &manifest {
        Some(manifest) => manifest
            .pages
            .iter()
            .enumerate()
            .map(|(index, record)| PageEntry {
                index: index as i64,
                url: record.url.clone(),
            })
            .collect(),
        None => PageEntry::from_urls(page_table),
    };
    if pages.is_empty() {
        return None;
    }
    let base = comic_dir(dir, source, comic_id);
    let pending: Vec<usize> = pages
        .iter()
        .enumerate()
        .filter(|(_, entry)| {
            let path = base.join(page_rel_path(chapter_index, entry.index, &entry.url));
            page_manifest::page_state_at(&path, manifest.as_ref(), entry.index as usize)
                != PageState::Complete
        })
        .map(|(position, _)| position)
        .collect();
    if pending.is_empty() {
        return None;
    }
    let meta = comic_meta::read(dir, source, comic_id).unwrap_or_default();
    let chapter_title = meta
        .chapters
        .get(&chapter_index.to_string())
        .cloned()
        .unwrap_or_default();
    Some(
        DownloadTask::new(
            source,
            comic_id,
            &meta.title,
            &meta.cover,
            chapter_index,
            &chapter_title,
            dir,
            referer,
            pages,
        )
        .into_repair(pending),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native::files::chapter_dir;
    use std::fs;
    use std::path::PathBuf;

    const SOURCE: &str = "webtoons";
    const COMIC: &str = "c1";

    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("mojuan-repair-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn urls(pages: usize) -> Vec<String> {
        (0..pages).map(|i| format!("https://x/{i}.jpg")).collect()
    }

    /// 一话目录：按 `sizes` 写页文件（`None` 表示这一页不在磁盘上）。
    fn make_chapter(base: &str, chapter: i64, sizes: &[Option<usize>]) {
        let chapter_dir = chapter_dir(base, SOURCE, COMIC, chapter);
        fs::create_dir_all(&chapter_dir).unwrap();
        for (i, size) in sizes.iter().enumerate() {
            if let Some(n) = size {
                fs::write(chapter_dir.join(format!("{i}.jpg")), vec![0u8; *n]).unwrap();
            }
        }
    }

    /// 有页清单的话：第 0 页的字节数与清单不符（损坏），第 1、3 页不在磁盘上（缺失）；
    /// 任务携带完整的页序，只补这三页。
    #[test]
    fn a_manifest_chapter_repairs_only_the_incomplete_pages() {
        let dir = temp_dir("manifest");
        let base = dir.to_str().unwrap();
        make_chapter(base, 1, &[Some(10), None, Some(30), None]);
        let pages = PageEntry::from_urls(&urls(4));
        assert!(page_manifest::write(
            base,
            SOURCE,
            COMIC,
            1,
            "https://ref/",
            &pages
        ));
        // 清单记下 10 字节之后把第 0 页改长：这一页成了损坏
        fs::write(
            chapter_dir(base, SOURCE, COMIC, 1).join("0.jpg"),
            vec![0u8; 99],
        )
        .unwrap();
        assert!(comic_meta::record_chapter(
            base,
            SOURCE,
            COMIC,
            "标题",
            "https://x/cover.jpg",
            1,
            "第 1 话"
        ));

        let task = task(base, SOURCE, COMIC, 1, "https://ref/", &[]).unwrap();

        assert!(task.repair);
        assert_eq!(task.pages.len(), 4, "任务要携带这一话完整的页序");
        assert_eq!(task.pending, vec![0, 1, 3]);
        assert_eq!(task.referer, "https://ref/");
        assert_eq!(task.comic_title, "标题");
        assert_eq!(task.comic_cover, "https://x/cover.jpg");
        assert_eq!(task.chapter_title, "第 1 话");

        let _ = fs::remove_dir_all(&dir);
    }

    /// 没有页清单的旧下载：用源给出的页表重建页序，缺的与空的都算要补。
    #[test]
    fn a_legacy_chapter_rebuilds_the_page_order_from_the_source_table() {
        let dir = temp_dir("legacy");
        let base = dir.to_str().unwrap();
        // 第 1 页不在磁盘上，第 2 页是空文件
        make_chapter(base, 1, &[Some(10), None, Some(0)]);
        let table = urls(3);

        let task = task(base, SOURCE, COMIC, 1, "", &table).unwrap();

        assert_eq!(
            task.pages.iter().map(|p| p.url.clone()).collect::<Vec<_>>(),
            table
        );
        assert_eq!(task.pending, vec![1, 2]);

        let _ = fs::remove_dir_all(&dir);
    }

    /// 每一页都完整时没有任务（调用方据此不入队）。
    #[test]
    fn a_complete_chapter_has_nothing_to_repair() {
        let dir = temp_dir("complete");
        let base = dir.to_str().unwrap();
        make_chapter(base, 1, &[Some(10), Some(20)]);
        let pages = PageEntry::from_urls(&urls(2));
        assert!(page_manifest::write(base, SOURCE, COMIC, 1, "", &pages));

        assert!(task(base, SOURCE, COMIC, 1, "", &[]).is_none());

        let _ = fs::remove_dir_all(&dir);
    }
}
