//! 应用装配：插件注册、窗口生命周期、缓存清理与各运行时（渲染通道、图片代理、下载）的启动。

#[cfg(mobile)]
use crate::ota;
#[cfg(desktop)]
use crate::render;
use crate::{
    commands, downloads, img_proxy, system_bars, APP_CACHE_DIR, DOWNLOAD_DIR, IMG_PROXY_PORT,
    RESULT_CACHE_MAX_AGE_SECS,
};
use std::sync::Arc;
use std::time::Duration;
use tauri::Manager;

/// 构建并运行应用。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    // debug-only 自动化桥（Tauri MCP 验证用，不影响 release）
    #[cfg(debug_assertions)]
    {
        builder = builder.plugin(tauri_plugin_mcp_bridge::init());
    }
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_mojuan_render::init())
        .plugin(tauri_plugin_mojuan_system_bars::init())
        .plugin(tauri_plugin_mojuan_update::init())
        // 主窗口销毁时连带销毁隐藏渲染 webview，保持「关掉全部窗口即退出」的原有行为
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                #[cfg(desktop)]
                {
                    if let Some(rw) = window.app_handle().get_webview_window(render::RENDER_LABEL) {
                        let _ = rw.destroy();
                    }
                }
            }
        })
        .setup(|app| {
            setup(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::crawl,
            commands::crawl_debug,
            commands::crawl_cached,
            commands::sync_sources,
            commands::source_schema,
            commands::source_errors,
            commands::webdav_put,
            commands::webdav_get,
            commands::list_downloaded,
            commands::scan_local,
            commands::read_comic_meta,
            commands::mojuan_version,
            commands::img_proxy_port,
            commands::img_proxy_set_download_dir,
            commands::storage_usage,
            commands::download_comics,
            commands::check_download,
            commands::clear_image_cache,
            commands::clear_result_cache,
            commands::set_image_cache_limit,
            system_bars::set_system_bars,
            downloads::subscribe_downloads,
            downloads::unsubscribe_downloads,
            downloads::get_downloads,
            downloads::enqueue_download,
            downloads::cancel_download,
            downloads::retry_download,
            downloads::clear_downloads,
            downloads::delete_downloaded,
            downloads::repair_download,
            // Android OTA（桌面端走官方更新器，这条通道只在移动端注册）
            #[cfg(mobile)]
            crate::ota::ota_check,
            #[cfg(mobile)]
            crate::ota::ota_download,
            #[cfg(mobile)]
            crate::ota::ota_install,
            #[cfg(mobile)]
            crate::ota::ota_can_install,
            #[cfg(mobile)]
            crate::ota::ota_open_install_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// setup 体：解析缓存目录、清理过期结果缓存，再启动各运行时。
fn setup(app: &mut tauri::App) {
    if let Ok(dir) = app.path().app_cache_dir() {
        let _ = APP_CACHE_DIR.set(dir.to_string_lossy().into_owned());
    }
    // 结果缓存清理：删除超过保留期未更新的条目（常用条目每次抓取都刷新修改时间）
    if let Some(cache_dir) = APP_CACHE_DIR.get().cloned() {
        tauri::async_runtime::spawn_blocking(move || {
            mojuan_core::crawler::result_cache::prune(
                &cache_dir,
                Duration::from_secs(RESULT_CACHE_MAX_AGE_SECS),
            );
        });
    }
    // 渲染通道注册（mojuan-core 的渲染源 fetch 经隐藏 webview 取页面）：
    // 桌面端是隐藏副窗口，移动端是插件的离屏 webview
    #[cfg(desktop)]
    render::init(app.handle());
    #[cfg(mobile)]
    tauri_plugin_mojuan_render::init_fetcher(app.handle());
    // Android OTA 状态（移动端才有这条通道）
    #[cfg(mobile)]
    ota::init(app.handle());
    // 本机图片代理（research #31 换代理）：绑定 127.0.0.1 随机端口，端口经
    // img_proxy_port 暴露给前端；取代自定义 scheme（Android 30s 拦截上限根因）。
    // 下载目录与前端共享：设置由前端读，代理按请求现取（离线阅读查下载索引）。
    if let Ok((listener, port)) = img_proxy::bind_img_proxy() {
        let _ = IMG_PROXY_PORT.set(port);
        let cache_dir = APP_CACHE_DIR.get().cloned().unwrap_or_default();
        let download_dir = Arc::clone(&DOWNLOAD_DIR);
        tauri::async_runtime::spawn(async move {
            img_proxy::serve(listener, cache_dir, download_dir).await;
        });
    }
    // 下载队列运行时（research #21：setup 里起常驻 worker）
    downloads::init(app.handle());
}
