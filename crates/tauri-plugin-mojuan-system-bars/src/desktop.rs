//! 桌面端实现：桌面窗口没有系统栏（状态栏与导航栏是移动端的概念），这里什么都不做，
//! 调用方不必按平台分叉。

use tauri::{AppHandle, Runtime};

/// 桌面端没有原生侧要注册。
pub fn init<R: Runtime, C: serde::de::DeserializeOwned>(
    _app: &AppHandle<R>,
    _api: tauri::plugin::PluginApi<R, C>,
) -> Result<(), Box<dyn std::error::Error>> {
    Ok(())
}

/// 桌面端没有系统栏可设置。
pub fn set_system_bars<R: Runtime>(
    _app: &AppHandle<R>,
    _hidden: bool,
    _light_icons: bool,
) -> Result<(), String> {
    Ok(())
}
