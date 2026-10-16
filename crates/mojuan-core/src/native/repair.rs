//! 补下：按话算出磁盘上还缺哪些页，建出只下这些页的修复任务。
//!
//! 页序的来源：这一话有页清单时用清单里的页序；没有清单的旧下载回源取一次这一话的页表
//! （`images` op）重建页序。要补的页 = 判定不是 `PageState::Complete` 的页
//! （与完整性检查共用 `page_manifest::page_state_at`）。
//! 每一页都完整时返回 `Ok(None)`（调用方据此返回「没有需要补的页」而不入队）；
//! 这一话没有页清单、源也给不出页表时返回 `Err(原因)`。

use crate::crawler;
use crate::native::comic_meta;
use crate::native::files::page_rel_path;
use crate::native::page_manifest::{self, PageEntry, PageState};
use crate::native::paths::comic_dir;
use crate::native::queue::{DownloadProgress, DownloadTask};

/// 补下一话的结果（宿主的命令层据此转成 JSON）。
#[derive(Debug, Clone)]
pub enum RepairOutcome {
    /// 正常入队：本次要补的页数与入队后的进度。
    Queued {
        pages: usize,
        progress: DownloadProgress,
    },
    /// 同一话已在下载队列里（重复补下）。
    AlreadyQueued {
        pages: usize,
        progress: DownloadProgress,
    },
    /// 每一页都完整，没有要补的页。
    NothingToRepair,
    /// 这一话没有页清单，源也没有给出页表（带原因）。
    NoPageTable { reason: String },
}

/// 算出这一话要补的页并建出修复任务。每一页都完整时返回 `Ok(None)`；
/// 这一话没有页清单、源也给不出页表时返回 `Err(原因)`。
pub fn task(
    dir: &str,
    source: &str,
    comic_id: &str,
    chapter_index: i64,
    referer: &str,
    cache_dir: &str,
) -> Result<Option<DownloadTask>, String> {
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
        None => PageEntry::from_urls(&source_page_table(
            source,
            comic_id,
            chapter_index,
            cache_dir,
        )?),
    };
    if pages.is_empty() {
        return Ok(None);
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
        return Ok(None);
    }
    let meta = comic_meta::read(dir, source, comic_id).unwrap_or_default();
    let chapter_title = meta
        .chapters
        .get(&chapter_index.to_string())
        .cloned()
        .unwrap_or_default();
    Ok(Some(
        DownloadTask::with_pages(
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
    ))
}

/// 回源取这一话的页表（`images` op）：源给出的页 URL 数组。
/// 取数失败、结果解析不了、源确实没给出页表，三种情况如实返回原因，不合并成一句
/// 「源没有这一话」——那会把取数失败谎报成源的问题。
fn source_page_table(
    source: &str,
    comic_id: &str,
    chapter_index: i64,
    cache_dir: &str,
) -> Result<Vec<String>, String> {
    let payload = serde_json::json!({
        "comicId": comic_id,
        "chapterIndex": chapter_index,
    })
    .to_string();
    // 只认这一次取数记下的错误：源注册表里的错误行会留到下一次成功为止，
    // 不按时间筛的话会把上一次别的 op 的失败当成这次取页表的原因。
    let started = crate::util::now_ms();
    let (raw, ok) = crawler::crawl_checked("images", source, &payload, cache_dir);
    if !ok {
        let detail = crawler::registry::last_error(source)
            .filter(|(_, at)| *at >= started)
            .map(|(message, _)| message);
        return Err(match detail {
            Some(message) => format!("回源取第 {} 话页表失败：{message}", chapter_index + 1),
            None => format!("回源取第 {} 话页表失败", chapter_index + 1),
        });
    }
    parse_page_table(&raw, chapter_index)
}

/// 解析源给出的页表：必须是页 URL 的字符串数组；空表当作「源没有给出页表」。
fn parse_page_table(raw: &str, chapter_index: i64) -> Result<Vec<String>, String> {
    let urls: Vec<String> = serde_json::from_str(raw)
        .map_err(|e| format!("源给出的第 {} 话页表无法解析：{e}", chapter_index + 1))?;
    if urls.is_empty() {
        return Err(format!(
            "没有页清单，源也没有给出第 {} 话的页表",
            chapter_index + 1
        ));
    }
    Ok(urls)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crawler::registry::{sync, SyncPayload, SyncSource};
    use crate::native::files::chapter_dir;
    use std::fs;
    use std::path::PathBuf;

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
        let dir = chapter_dir(base, "demo", COMIC, chapter);
        fs::create_dir_all(&dir).unwrap();
        for (i, size) in sizes.iter().enumerate() {
            if let Some(n) = size {
                fs::write(dir.join(format!("{i}.jpg")), vec![0u8; *n]).unwrap();
            }
        }
    }

    /// 装一份演示源文档。
    fn install_source_doc(document: &str) {
        sync(SyncPayload {
            runtime: None,
            sources: vec![SyncSource {
                id: "demo".to_string(),
                document: document.to_string(),
            }],
        });
    }

    /// 装一个演示源：它的 `images` op 由内嵌脚本直接给出结果，不发网络请求。
    fn install_source(script: &str) {
        install_source_doc(&format!(
            r#"{{"schema":1,"id":"demo","title":"演示","ops":{{"images":{{"script":"{script}"}}}}}}"#
        ));
    }

    /// 装一个 `images` 返回给定页表的演示源。
    fn install_source_with_pages(pages: &[String]) {
        let list = pages
            .iter()
            .map(|url| format!("'{url}'"))
            .collect::<Vec<_>>()
            .join(",");
        install_source(&format!("function () {{ return [{list}] }}"));
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
            "demo",
            COMIC,
            1,
            "https://ref/",
            &pages
        ));
        // 清单记下 10 字节之后把第 0 页改长：这一页成了损坏
        fs::write(
            chapter_dir(base, "demo", COMIC, 1).join("0.jpg"),
            vec![0u8; 99],
        )
        .unwrap();
        assert!(comic_meta::record_chapter(
            base,
            "demo",
            COMIC,
            "标题",
            "https://x/cover.jpg",
            1,
            "第 1 话"
        ));

        let task = task(base, "demo", COMIC, 1, "https://ref/", "")
            .unwrap()
            .unwrap();

        assert!(task.repair);
        assert_eq!(task.pages.len(), 4, "任务要携带这一话完整的页序");
        assert_eq!(task.pending, vec![0, 1, 3]);
        assert_eq!(task.referer, "https://ref/");
        assert_eq!(task.comic_title, "标题");
        assert_eq!(task.comic_cover, "https://x/cover.jpg");
        assert_eq!(task.chapter_title, "第 1 话");

        let _ = fs::remove_dir_all(&dir);
    }

    /// 没有页清单的旧下载：回源取一次页表重建页序，缺的与空的都算要补。
    #[test]
    fn a_legacy_chapter_rebuilds_the_page_order_from_the_source_table() {
        let _guard = crate::crawler::registry::test_lock();
        let dir = temp_dir("legacy");
        let base = dir.to_str().unwrap();
        // 第 1 页不在磁盘上，第 2 页是空文件
        make_chapter(base, 1, &[Some(10), None, Some(0)]);
        let table = urls(3);
        install_source_with_pages(&table);

        let task = task(base, "demo", COMIC, 1, "", "").unwrap().unwrap();

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
        assert!(page_manifest::write(base, "demo", COMIC, 1, "", &pages));

        assert!(task(base, "demo", COMIC, 1, "", "").unwrap().is_none());

        let _ = fs::remove_dir_all(&dir);
    }

    /// 源确实没有给出页表：如实报「没有页清单，源也没有给出这一话的页表」。
    #[test]
    fn a_source_without_a_page_table_reports_the_reason() {
        let _guard = crate::crawler::registry::test_lock();
        let dir = temp_dir("empty-table");
        let base = dir.to_str().unwrap();
        make_chapter(base, 1, &[Some(10)]);
        install_source("function () { return [] }");

        let err = task(base, "demo", COMIC, 1, "", "").unwrap_err();

        assert!(err.contains("没有页清单"), "{err}");
        assert!(err.contains("第 2 话"), "{err}");

        let _ = fs::remove_dir_all(&dir);
    }

    /// 源返回的页表不是 URL 数组：如实带出解析错误，不谎报成「源没有这一话」。
    #[test]
    fn an_unparsable_page_table_reports_the_parse_error() {
        let _guard = crate::crawler::registry::test_lock();
        let dir = temp_dir("bad-table");
        let base = dir.to_str().unwrap();
        make_chapter(base, 1, &[Some(10)]);
        install_source("function () { return [1,2] }");

        let err = task(base, "demo", COMIC, 1, "", "").unwrap_err();

        assert!(err.contains("无法解析"), "{err}");

        let _ = fs::remove_dir_all(&dir);
    }

    /// 回源取数失败（源没装）：如实报取数失败，不谎报成「源没有这一话」。
    #[test]
    fn a_failed_crawl_is_reported_as_a_fetch_failure() {
        let _guard = crate::crawler::registry::test_lock();
        let dir = temp_dir("crawl-fail");
        let base = dir.to_str().unwrap();
        make_chapter(base, 1, &[Some(10)]);

        let err = task(base, "not-installed", COMIC, 1, "", "").unwrap_err();

        assert!(err.contains("回源取第 2 话页表失败"), "{err}");

        let _ = fs::remove_dir_all(&dir);
    }

    /// 回源抓取报错：把源这一次记下的原因一起带出来（不是笼统的「源没有这一话」）。
    #[test]
    fn a_failed_fetch_carries_the_source_error() {
        let _guard = crate::crawler::registry::test_lock();
        let dir = temp_dir("fetch-fail");
        let base = dir.to_str().unwrap();
        make_chapter(base, 1, &[Some(10)]);
        // images 请求一个连不上的地址：抓取失败，源记下原因
        install_source_doc(
            r#"{"schema":1,"id":"demo","title":"演示","ops":{"images":{"request":[{"name":"page","url":"http://127.0.0.1:1/x"}],"items":"img.p","url":{"attr":"src"}}}}"#,
        );

        let err = task(base, "demo", COMIC, 1, "", "").unwrap_err();

        assert!(err.contains("回源取第 2 话页表失败："), "{err}");

        let _ = fs::remove_dir_all(&dir);
    }
}
