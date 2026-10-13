//! 墨卷桌面端后端：命令层（`commands` / `downloads`）、应用装配（`app`）与各运行时模块。

use std::sync::{Arc, LazyLock, Mutex, OnceLock};

/// 本机图片代理（research #31 换代理：自用 + Android 优先）。
mod img_proxy;

/// 隐藏 webview 渲染通道（Cloudflare 防护源；pub 供 examples/render_probe 复用）。
///
/// 仅桌面端：隐藏副窗口用到的 `skip_taskbar` / `decorations` / `focused` 在 tauri 里
/// 属于 `#[cfg(desktop)]` 的构建器方法，iOS / Android 上不存在；移动端的渲染通道
/// 由 `tauri-plugin-mojuan-render` 的离屏 webview 提供（见 `app.rs` 的注册）。
#[cfg(desktop)]
pub mod render;

/// Android OTA 更新（桌面端走官方 tauri-plugin-updater）。只在移动端编译：
/// 命令面与状态都是 Android 安装通道专用的。
#[cfg(mobile)]
mod ota;

mod app;
mod commands;
mod downloads;
mod system_bars;

/// 应用缓存目录（装配时解析 app cache dir 填充，代理线程里拿不到 AppHandle）：
/// 图片代理缓存与抓取结果缓存共用。
static APP_CACHE_DIR: OnceLock<String> = OnceLock::new();

/// 本机图片代理端口（装配时绑定 127.0.0.1:0 后填充，前端经 img_proxy_port 读取）。
static IMG_PROXY_PORT: OnceLock<u16> = OnceLock::new();

/// 用户配置的下载目录（前端读取设置后写入）。代理持有同一个 Arc 并每次请求现读，
/// 所以设置页改了目录即时生效。
static DOWNLOAD_DIR: LazyLock<Arc<Mutex<String>>> =
    LazyLock::new(|| Arc::new(Mutex::new(String::new())));

/// 结果缓存条目的保留期（秒）：超过此时长未更新的条目在装配时清理（常用条目每次抓取刷新）。
const RESULT_CACHE_MAX_AGE_SECS: u64 = 7 * 24 * 60 * 60;

pub use app::run;
