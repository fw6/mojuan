//! mojuan-core：Tauri 桌面端共享的漫画核心逻辑。
//!
//! 承载爬虫引擎（`crawler`）、WebDAV/下载/本地文件 IO（`native`）与热链图片代理缓存（`cache`）。
//! 原 uniffi/JNI/Swift 绑定已随 Lynx 迁移整体移除（AGENTS.md：不做兼容层），
//! 宿主端由 `apps/mojuan/src-tauri` 的命令层以 &str API 调用。

pub mod cache;
pub mod crawler;
pub mod js;
pub mod native;
mod util;

/// 仓库里源文档所在目录（内置文档与回归数据）。
///
/// 打包进应用的是文档内容（`include_str!`），这个路径只给仓库内的工具与测试用：渲染通道
/// 探针、live 冒烟与源文档测试都从这里取，路径只写一处。
pub const SOURCE_DOC_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/src/js/sources");

/// 核心版本字符串。
pub fn mojuan_version() -> String {
    "mojuan-core-rust".to_string()
}

/// 爬虫引擎统一入口：返回 JSON 字符串（失败返回空 JSON）。
/// 源由已装源注册表（`crawler::registry`）按 sourceId 查出，其文档交给源运行时解释。
/// `cache_dir`：结果缓存目录（空串禁用）；列表/详情类 op 的成功结果写入内存 LRU + 磁盘。
pub fn crawl(op: &str, source: &str, payload: &str, cache_dir: &str) -> String {
    crawler::crawl(op, source, payload, cache_dir)
}

/// 读取抓取结果缓存（不触发网络）：命中返回 `{"data": <结果>, "fetchedAt": <unix_ms>}`，
/// 未命中返回 `null`。前端 stale-while-revalidate 的 stale 一侧（先渲染缓存再拉最新）。
pub fn cached_result(op: &str, source: &str, payload: &str, cache_dir: &str) -> String {
    crawler::cached_result(op, source, payload, cache_dir)
}

/// 源调试台的一次运行：文档原文、op、payload 与会话隐藏值快照进，运行记录 JSON 出。
/// 走真实的网络与渲染通道，但不写结果缓存、不碰任何已装源。
pub fn crawl_debug(document: &str, op: &str, payload: &str, hidden: &str) -> String {
    crawler::crawl_debug(document, op, payload, hidden)
}

/// 源文档的 JSON Schema（编辑器补全与源仓库提交时校验用；由 Rust 结构体生成，见 ADR-0002）。
pub fn source_schema() -> String {
    crawler::doc::SourceDoc::schema_json()
}

/// WebDAV PUT 备份：返回 JSON `{"success","status"}`。
pub fn webdav_put(
    base: &str,
    user: &str,
    password: &str,
    file_name: &str,
    content: &str,
) -> String {
    native::webdav::webdav_put(base, user, password, file_name, content)
}

/// WebDAV GET 读取备份：返回 JSON `{"ok","content","status","error"}`。
pub fn webdav_get(base: &str, user: &str, password: &str, file_name: &str) -> String {
    native::webdav::webdav_get(base, user, password, file_name)
}

/// 已下载章节文件列表：返回 JSON `{chapterIndex: [paths]}`（source = "local" 走扁平布局）。
pub fn list_downloaded(dir: &str, source: &str, comic_id: &str) -> String {
    native::files::list_downloaded(dir, source, comic_id)
}

/// 扫描本地已下载漫画：返回 JSON `[{source, comicId, chapterCount, title, cover}]`
/// （兼容命名空间与扁平布局；标题与封面取自下载目录里的作品元数据）。
pub fn scan_local(dir: &str) -> String {
    native::files::scan_local(dir)
}

/// 一部已下载作品的元数据（标题、封面、各话标题）；没有这份元数据返回 `null`。
pub fn read_comic_meta(dir: &str, source: &str, comic_id: &str) -> String {
    native::files::read_comic_meta(dir, source, comic_id)
}

/// 删除某漫画的下载（整目录，含下载索引与全部章节）。目录本就不存在返回 `Ok(false)`。
pub fn delete_downloaded(dir: &str, source: &str, comic_id: &str) -> Result<bool, String> {
    native::files::delete_downloaded(dir, source, comic_id)
}

/// 存储占用：图片缓存、结果缓存与下载三项的字节数与条数（下载那项是作品数）。
/// `cache_dir` 是应用缓存目录，`download_dir` 是用户配置的下载目录；返回 JSON 字符串。
pub fn storage_usage(cache_dir: &str, download_dir: &str) -> String {
    let (image_bytes, image_count) = cache::usage(cache_dir);
    let (result_bytes, result_count) = crawler::result_cache::usage(cache_dir);
    let (download_bytes, download_comics) = native::files::download_usage(download_dir);
    serde_json::json!({
        "image": { "bytes": image_bytes, "count": image_count },
        "result": { "bytes": result_bytes, "count": result_count },
        "download": { "bytes": download_bytes, "count": download_comics },
    })
    .to_string()
}

/// 按作品列出下载占用：返回 JSON `[{source, comicId, title, cover, chapters, pages, bytes}]`
/// （字节数是整部作品目录的递归字节数）。只读本地文件。
pub fn download_comics(dir: &str) -> String {
    native::files::download_comics(dir)
}

/// 完整性检查：返回 JSON
/// `{chapters: [{chapterIndex, pages, missing, broken, manifest}], missingPages, brokenFiles, unchecked}`。
/// 有页清单的按清单比对，没有页清单的旧下载按下载索引比对（并计入 `unchecked`）。
/// 页号是 0 基（与下载命名一致）。只读本地文件，不发网络请求。
pub fn check_download(dir: &str, source: &str, comic_id: &str) -> String {
    native::integrity::check(dir, source, comic_id)
}

/// 这一话有没有页清单（补下据此决定要不要回源取页表）。只读本地文件。
pub fn has_page_manifest(dir: &str, source: &str, comic_id: &str, chapter_index: i64) -> bool {
    native::page_manifest::read(dir, source, comic_id, chapter_index).is_some()
}

/// 补下一话：算出这一话要补的页并建出修复任务。没有要补的页（每一页都完整）返回 `None`，
/// 调用方据此返回「没有需要补的页」而不入队。
/// 有页清单的用清单里的页序；没有的用 `page_table`（源给出的页表）重建页序。
pub fn repair_task(
    dir: &str,
    source: &str,
    comic_id: &str,
    chapter_index: i64,
    referer: &str,
    page_table: &[String],
) -> Option<DownloadTask> {
    native::repair::task(dir, source, comic_id, chapter_index, referer, page_table)
}

/// 清空图片缓存：删掉磁盘上的条目并清空内存表（不碰下载目录）。
pub fn clear_image_cache(cache_dir: &str) {
    cache::clear(cache_dir);
}

/// 清空结果缓存：删掉磁盘上的条目并清空内存表（不碰下载目录）。
pub fn clear_result_cache(cache_dir: &str) {
    crawler::result_cache::clear(cache_dir);
}

/// 设置图片缓存上限（字节；0 表示不限制）并就地整理到上限以内。
pub fn set_image_cache_limit(cache_dir: &str, bytes: u64) {
    cache::set_limit(cache_dir, bytes);
}

// 下载运行时（wayfinder #20/#22）：队列状态机、并发、重试、取消与进度推送同处 core；
// 宿主只接页面下载（core 已内置）与进度出口（构造时传入的回调）。
pub use native::download::{DownloadRuntime, PageDownloader, ProgressSink, DEFAULT_WORKERS};
pub use native::page_manifest::PageEntry;
pub use native::queue::{DownloadProgress, DownloadTask, DownloadTaskView, EnqueueResult};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_is_correct() {
        assert_eq!(mojuan_version(), "mojuan-core-rust");
    }

    /// 占用统计给出三项；清空两个缓存不动下载目录（收藏、历史与进度在存储域，本就不受影响）。
    #[test]
    fn clearing_caches_leaves_downloads_alone() {
        let _guard = util::test_lock();
        let root = std::env::temp_dir().join(format!("mojuan-storage-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let cache_dir = root.join("cache");
        let download_dir = root.join("downloads");
        // 缓存目录里各摆一份图片条目与结果条目
        std::fs::create_dir_all(cache_dir.join("imgs")).unwrap();
        std::fs::write(cache_dir.join("imgs").join("a.img"), b"img").unwrap();
        std::fs::create_dir_all(cache_dir.join("results")).unwrap();
        std::fs::write(cache_dir.join("results").join("a.json"), b"{}").unwrap();
        // 下载目录里摆一部作品
        let chapter = download_dir.join("webtoons").join("c1").join("chapter_1");
        std::fs::create_dir_all(&chapter).unwrap();
        std::fs::write(chapter.join("0.jpg"), b"page").unwrap();

        let (cache, downloads) = (cache_dir.to_str().unwrap(), download_dir.to_str().unwrap());
        let before: serde_json::Value =
            serde_json::from_str(&storage_usage(cache, downloads)).unwrap();
        assert_eq!(before["image"]["count"], 1);
        assert_eq!(before["result"]["count"], 1);
        assert_eq!(before["download"]["count"], 1);
        assert_eq!(before["download"]["bytes"], 4);

        clear_image_cache(cache);
        clear_result_cache(cache);

        assert!(chapter.join("0.jpg").exists(), "清缓存不应删掉下载");
        let after: serde_json::Value =
            serde_json::from_str(&storage_usage(cache, downloads)).unwrap();
        assert_eq!(after["image"]["count"], 0);
        assert_eq!(after["result"]["count"], 0);
        assert_eq!(after["download"]["count"], 1);

        let _ = std::fs::remove_dir_all(&root);
    }
}
