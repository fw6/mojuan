//! 爬虫、源清单、本地文件与 WebDAV 备份的命令面（下载队列的命令在 `downloads`）。
//!
//! 公开函数接收 `&str`、返回 JSON 字符串（见 docs/agents/mojuan-core.md 的命令 API 约定）；
//! 阻塞式 reqwest 一律放 `spawn_blocking`——同步命令在主线程执行，直接调用会冻结界面。

use crate::{APP_CACHE_DIR, DOWNLOAD_DIR, IMG_PROXY_PORT};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::Manager;

/// 源脚本运行时 registry：sourceId -> script（前端从 sources.json 同步进来；
/// 未同步的源 crawl 返回空结果，见 mojuan-core 分发保护）。
pub struct SourceRegistry(pub Mutex<HashMap<String, String>>);

impl Default for SourceRegistry {
    fn default() -> Self {
        Self(Mutex::new(HashMap::new()))
    }
}

/// 爬虫引擎统一入口（转发 Rust core，返回 JSON 字符串）。
/// 成功结果由 core 写入结果缓存（cache_dir），供 crawl_cached 读取。
/// 源脚本错误（#17 呈现）经 mojuan-core 错误 registry 记录，这里追加到 app 日志目录。
#[tauri::command]
pub async fn crawl(
    app: tauri::AppHandle,
    state: tauri::State<'_, SourceRegistry>,
    op: String,
    source: String,
    payload: String,
) -> Result<String, String> {
    let src = source.clone();
    let script = state.0.lock().unwrap().get(&source).cloned().unwrap_or_default();
    let cache_dir = APP_CACHE_DIR.get().cloned().unwrap_or_default();
    let out = tauri::async_runtime::spawn_blocking(move || {
        mojuan_core::crawl(&op, &src, &payload, &script, &cache_dir)
    })
    .await
    .map_err(|e| format!("爬虫任务异常终止: {e}"))?;
    if let Some((msg, at)) = mojuan_core::crawler::sources::last_error(&source) {
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

/// 读取抓取结果缓存（不触发网络）。命中返回 `{"data": <结果>, "fetchedAt": <unix_ms>}`，
/// 未命中返回 `null`。前端加载列表/详情的 stale-while-revalidate 前半段：
/// 先渲染缓存，再调 crawl 拉最新并回写。
#[tauri::command]
pub async fn crawl_cached(
    state: tauri::State<'_, SourceRegistry>,
    op: String,
    source: String,
    payload: String,
) -> Result<String, String> {
    let script = state.0.lock().unwrap().get(&source).cloned().unwrap_or_default();
    let cache_dir = APP_CACHE_DIR.get().cloned().unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        mojuan_core::cached_result(&op, &source, &payload, &script, &cache_dir)
    })
    .await
    .map_err(|e| format!("缓存读取异常终止: {e}"))
}

/// 内置源清单（顺序 = 源注册表的注册顺序，前端据此排源列表；首个为默认源）。
/// 每个源带显示名、脚本（debug 读磁盘实现 #17 开发回路，release 用 include_str! 打包）
/// 与图片热链对（前端图片代理与下载 Referer 用）。
#[tauri::command]
pub fn bundled_sources() -> Vec<serde_json::Value> {
    mojuan_core::crawler::sources::SOURCES
        .iter()
        .map(|(id, src)| {
            serde_json::json!({
                "id": id,
                "title": src.title(),
                "script": mojuan_core::js::sources::load(id).unwrap_or_default(),
                "hotlinkReferers": src
                    .hotlink_referers()
                    .iter()
                    .map(|h| serde_json::json!({ "domain": h.domain, "referer": h.referer }))
                    .collect::<Vec<_>>(),
            })
        })
        .collect()
}

/// 前端启动/更新后把 sources.json 里的脚本同步进 registry。
#[tauri::command]
pub fn sync_sources(state: tauri::State<'_, SourceRegistry>, entries: HashMap<String, String>) {
    *state.0.lock().unwrap() = entries;
}

/// 各源最近一次错误（Sources 错误行 / Settings 源区展示，wayfinder #17）。
#[tauri::command]
pub fn source_errors() -> HashMap<String, serde_json::Value> {
    mojuan_core::crawler::sources::all_errors()
        .into_iter()
        .map(|(source, (message, at))| (source, serde_json::json!({ "message": message, "at": at })))
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
