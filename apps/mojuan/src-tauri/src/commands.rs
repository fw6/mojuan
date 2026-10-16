//! 爬虫、源清单、本地文件与 WebDAV 备份的命令面（下载队列的命令在 `downloads`）。
//!
//! 公开函数接收 `&str`、返回 JSON 字符串（见 docs/agents/mojuan-core.md 的命令 API 约定）；
//! 阻塞式 reqwest 一律放 `spawn_blocking`——同步命令在主线程执行，直接调用会冻结界面。

use crate::{APP_CACHE_DIR, DOWNLOAD_DIR, IMG_PROXY_PORT};
use std::collections::HashMap;
use tauri::Manager;

/// 爬虫引擎统一入口（转发 Rust core，返回 JSON 字符串）。
/// 已装源在 mojuan-core 的源注册表里（前端经 `sync_sources` 同步），成功结果由 core 写入
/// 结果缓存（cache_dir），供 crawl_cached 读取。源错误经 core 的注册表记录，这里追加到 app 日志目录。
#[tauri::command]
pub async fn crawl(
    app: tauri::AppHandle,
    op: String,
    source: String,
    payload: String,
) -> Result<String, String> {
    let src = source.clone();
    let cache_dir = APP_CACHE_DIR.get().cloned().unwrap_or_default();
    let out = tauri::async_runtime::spawn_blocking(move || {
        mojuan_core::crawl(&op, &src, &payload, &cache_dir)
    })
    .await
    .map_err(|e| format!("爬虫任务异常终止: {e}"))?;
    if let Some((msg, at)) = mojuan_core::crawler::registry::last_error(&source) {
        if let Ok(log_dir) = app.path().app_log_dir() {
            let _ = std::fs::create_dir_all(&log_dir);
            let line = format!("[{at}] {source}: {msg}\n");
            let _ = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(log_dir.join("sources.log"))
                .and_then(|f| {
                    use std::io::Write;
                    let mut w = std::io::BufWriter::new(f);
                    w.write_all(line.as_bytes())
                });
        }
    }
    Ok(out)
}

/// 源调试台的一次运行：文档原文、op、payload 与会话隐藏值快照进，运行记录 JSON 出。
/// 走真实的网络、请求头与渲染通道，与 `crawl` 同一条路；但不写结果缓存、不碰任何已装源，
/// 所以不追加 sources.log。
#[tauri::command]
pub async fn crawl_debug(
    document: String,
    op: String,
    payload: String,
    hidden: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        mojuan_core::crawl_debug(&document, &op, &payload, &hidden)
    })
    .await
    .map_err(|e| format!("调试运行异常终止: {e}"))
}

/// 读取抓取结果缓存（不触发网络）。命中返回 `{"data": <结果>, "fetchedAt": <unix_ms>}`，
/// 未命中返回 `null`。前端加载列表/详情的 stale-while-revalidate 前半段：
/// 先渲染缓存，再调 crawl 拉最新并回写。
#[tauri::command]
pub async fn crawl_cached(op: String, source: String, payload: String) -> Result<String, String> {
    let cache_dir = APP_CACHE_DIR.get().cloned().unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        mojuan_core::cached_result(&op, &source, &payload, &cache_dir)
    })
    .await
    .map_err(|e| format!("缓存读取异常终止: {e}"))
}

/// 同步已装源：源运行时（可选，缺省用内置）+ 有序的源文档列表。
/// 逐份校验文档，坏的跳过并保留已装版本；返回被接受的源的前端事实（显示名与热链对）
/// 与被拒绝的原因（前端源管理页据此呈现）。
#[tauri::command]
pub fn sync_sources(payload: String) -> Result<String, String> {
    let payload: mojuan_core::crawler::registry::SyncPayload =
        serde_json::from_str(&payload).map_err(|e| format!("同步参数非法: {e}"))?;
    let outcome = mojuan_core::crawler::registry::sync(payload);
    Ok(serde_json::json!({
        "sources": outcome.accepted,
        "rejected": outcome.rejected
            .into_iter()
            .map(|(id, reason)| serde_json::json!({ "id": id, "reason": reason }))
            .collect::<Vec<_>>(),
    })
    .to_string())
}

/// 源文档的 JSON Schema（源管理页展示与手动导入时的校验提示用）。
#[tauri::command]
pub fn source_schema() -> String {
    mojuan_core::source_schema()
}

/// 各源最近一次错误（Sources 错误行 / Settings 源区展示，wayfinder #17）。
#[tauri::command]
pub fn source_errors() -> HashMap<String, serde_json::Value> {
    mojuan_core::crawler::registry::all_errors()
        .into_iter()
        .map(|(source, (message, at))| {
            (source, serde_json::json!({ "message": message, "at": at }))
        })
        .collect()
}

#[tauri::command]
pub async fn webdav_put(
    base: String,
    user: String,
    password: String,
    file_name: String,
    content: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        mojuan_core::webdav_put(&base, &user, &password, &file_name, &content)
    })
    .await
    .map_err(|e| format!("备份任务异常终止: {e}"))
}

#[tauri::command]
pub async fn webdav_get(
    base: String,
    user: String,
    password: String,
    file_name: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        mojuan_core::webdav_get(&base, &user, &password, &file_name)
    })
    .await
    .map_err(|e| format!("读取备份异常终止: {e}"))
}

#[tauri::command]
pub async fn list_downloaded(
    dir: String,
    source: String,
    comic_id: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        mojuan_core::list_downloaded(&dir, &source, &comic_id)
    })
    .await
    .map_err(|e| format!("读取下载目录异常终止: {e}"))
}

#[tauri::command]
pub async fn scan_local(dir: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || mojuan_core::scan_local(&dir))
        .await
        .map_err(|e| format!("扫描本地目录异常终止: {e}"))
}

/// 一部已下载作品的元数据（标题、封面、各话标题）：书架「下载」展开时取真实话名。
/// 没有这份元数据（旧下载或用户自己的文件夹）返回 `null`。
#[tauri::command]
pub async fn read_comic_meta(
    dir: String,
    source: String,
    comic_id: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        mojuan_core::read_comic_meta(&dir, &source, &comic_id)
    })
    .await
    .map_err(|e| format!("读取作品信息异常终止: {e}"))
}

#[tauri::command]
pub fn mojuan_version() -> String {
    mojuan_core::mojuan_version()
}

/// 本机图片代理端口（装配时绑定后填充；前端启动时调用，用于拼图片 URL）。
#[tauri::command]
pub fn img_proxy_port() -> u16 {
    IMG_PROXY_PORT.get().copied().unwrap_or(0)
}

/// 告诉代理当前的下载目录（前端读取 settings 后调用，wayfinder #31：离线也传 url）。
/// 代理每次请求现读，改设置之后不用重启。
#[tauri::command]
pub fn img_proxy_set_download_dir(dir: String) {
    *DOWNLOAD_DIR.lock().unwrap() = dir;
}

/// 存储占用：图片缓存、结果缓存与下载三项（字节数与条数/作品数）。
/// `dir` 是用户配置的下载目录，缓存目录取应用缓存目录。扫描整个下载目录较慢，走阻塞线程。
#[tauri::command]
pub async fn storage_usage(dir: String) -> Result<String, String> {
    let cache_dir = APP_CACHE_DIR.get().cloned().unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || mojuan_core::storage_usage(&cache_dir, &dir))
        .await
        .map_err(|e| format!("统计存储占用异常终止: {e}"))
}

/// 按作品列出下载占用（存储页的下载列表：每部的字节数、话数与页数）。走阻塞线程。
#[tauri::command]
pub async fn download_comics(dir: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || mojuan_core::download_comics(&dir))
        .await
        .map_err(|e| format!("统计下载占用异常终止: {e}"))
}

/// 按作品检查下载完整性（存储页的「检查」）：逐话给出页数、缺失页、损坏页与有没有页清单。
/// 逐话逐页读磁盘，走阻塞线程；只读本地文件，不发网络请求。
#[tauri::command]
pub async fn check_download(
    dir: String,
    source: String,
    comic_id: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        mojuan_core::check_download(&dir, &source, &comic_id)
    })
    .await
    .map_err(|e| format!("检查下载完整性异常终止: {e}"))
}

/// 清空图片缓存（磁盘 + 内存表），不碰下载目录。
#[tauri::command]
pub async fn clear_image_cache() -> Result<(), String> {
    let cache_dir = APP_CACHE_DIR.get().cloned().unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || mojuan_core::clear_image_cache(&cache_dir))
        .await
        .map_err(|e| format!("清空图片缓存异常终止: {e}"))
}

/// 清空结果缓存（磁盘 + 内存表），不碰下载目录。
#[tauri::command]
pub async fn clear_result_cache() -> Result<(), String> {
    let cache_dir = APP_CACHE_DIR.get().cloned().unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || mojuan_core::clear_result_cache(&cache_dir))
        .await
        .map_err(|e| format!("清空结果缓存异常终止: {e}"))
}

/// 设置图片缓存上限（字节；0 表示不限制）并就地整理到上限以内。
/// 前端启动时按设置里的值推一次，设置页改动时再推一次。
#[tauri::command]
pub async fn set_image_cache_limit(bytes: u64) -> Result<(), String> {
    let cache_dir = APP_CACHE_DIR.get().cloned().unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        mojuan_core::set_image_cache_limit(&cache_dir, bytes)
    })
    .await
    .map_err(|e| format!("设置图片缓存上限异常终止: {e}"))
}
