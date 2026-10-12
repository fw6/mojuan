//! 桌面端占位：桌面渲染通道由 src-tauri 的隐藏窗口实现（`mojuan_lib::render`）。

use tauri::{plugin::PluginApi, AppHandle, Runtime};

/// 桌面端不注册插件状态（渲染通道注册在 src-tauri 里）。
pub fn init<R: Runtime, C: serde::de::DeserializeOwned>(
    _app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> Result<(), Box<dyn std::error::Error>> {
    Ok(())
}

/// 桌面端经插件渲染不可用：宿主应注册 src-tauri 的隐藏窗口实现。
/// 先过一遍请求组装，保证非 http(s) 的报错口径与移动端一致。
pub fn render<R: Runtime>(_app: &AppHandle<R>, url: &str) -> Result<String, String> {
    crate::render_request(url)?;
    Err("渲染通道在桌面端由 src-tauri 的隐藏窗口实现".to_string())
}
