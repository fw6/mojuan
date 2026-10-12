//! mojuan-core：Tauri 桌面端共享的漫画核心逻辑。
//!
//! 承载爬虫引擎（`crawler`）、WebDAV/下载/本地文件 IO（`native`）与热链图片代理缓存（`cache`）。
//! 原 uniffi/JNI/Swift 绑定已随 Lynx 迁移整体移除（AGENTS.md：不做兼容层），
//! 桌面端由 `desktop/src-tauri` 的命令层以 &str API 调用。

pub mod cache;
pub mod crawler;
pub mod js;
pub mod native;
mod util;

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

/// 扫描本地已下载漫画：返回 JSON `[{source, comicId, chapterCount}]`（兼容命名空间与扁平布局）。
pub fn scan_local(dir: &str) -> String {
    native::files::scan_local(dir)
}

// 下载运行时（wayfinder #20/#22）：队列状态机、并发、重试、取消与进度推送同处 core；
// 宿主只接页面下载（core 已内置）与进度出口（构造时传入的回调）。
pub use native::download::{DownloadRuntime, PageDownloader, ProgressSink, DEFAULT_WORKERS};
pub use native::queue::{DownloadProgress, DownloadTask, DownloadTaskView, EnqueueResult};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_is_correct() {
        assert_eq!(mojuan_version(), "mojuan-core-rust");
    }
}
