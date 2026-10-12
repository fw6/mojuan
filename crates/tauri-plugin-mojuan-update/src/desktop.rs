//! 桌面端占位：桌面更新走官方 tauri-plugin-updater（Windows / Linux）。

use tauri::{plugin::PluginApi, AppHandle, Runtime};

/// 桌面端不注册插件状态（安装通道只存在于移动端）。
pub fn init<R: Runtime, C: serde::de::DeserializeOwned>(
    _app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> Result<(), Box<dyn std::error::Error>> {
    Ok(())
}

pub fn install<R: Runtime>(_app: &AppHandle<R>, _path: &str) -> Result<String, String> {
    Err("安装通道只用于 Android：桌面端请用「检查新版本」".to_string())
}

pub fn can_install<R: Runtime>(_app: &AppHandle<R>) -> Result<bool, String> {
    Err("安装通道只用于 Android：桌面端请用「检查新版本」".to_string())
}

pub fn open_install_settings<R: Runtime>(_app: &AppHandle<R>) -> Result<(), String> {
    Err("安装通道只用于 Android：桌面端请用「检查新版本」".to_string())
}
