//! mojuan 移动端系统栏（自建 tauri 插件）。
//!
//! 阅读器的全屏阅读要隐藏状态栏与导航栏，并让栏内图标取浅色（阅读画布是暗的）。
//! tauri 的窗口 API 在移动端给不出这件事：`WebviewWindow::set_fullscreen` 在 Android
//! 上是空实现（tao 只打一条 `Cannot set fullscreen on Android`），系统栏的显隐与图标
//! 明暗都要经平台的窗口 insets 控制器，所以这里由插件自带原生代码：Android 用
//! `WindowInsetsControllerCompat`（Kotlin），iOS 换掉视图控制器的状态栏求值（Swift），
//! Rust 侧经 `PluginHandle::run_mobile_plugin` 调用（见 `src/mobile.rs`）。
//!
//! 安全区不在这里给：前端用 `env(safe-area-inset-*)`（Android WebView 与 iOS 都提供，
//! 实测 Android 17 上状态栏 49px、导航栏 24px，栏隐藏时底部那个自己变成 0），
//! 与外壳其余页面同一个来源。
//!
//! 宿主只调 [`set_system_bars`] 一个入口，命令面为零：
//!
//! ```ignore
//! tauri_plugin_mojuan_system_bars::set_system_bars(&app, hidden, light_icons)?;
//! ```

#[cfg(any(mobile, test))]
use serde::Serialize;
use tauri::{plugin::TauriPlugin, AppHandle, Runtime};

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

#[cfg(desktop)]
use desktop as platform;
#[cfg(mobile)]
use mobile as platform;

/// 插件名（原生侧的注册键，与 Kotlin / Swift 插件类一一对应）。
pub const PLUGIN_NAME: &str = "mojuan-system-bars";

/// 设置请求（camelCase 字段名与原生侧一致：Kotlin `@InvokeArg SystemBarsArgs`、
/// Swift `SystemBarsArgs: Decodable`）。
#[cfg(any(mobile, test))]
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SystemBarsRequest {
    /// 隐藏系统栏（沉浸式全屏）。
    pub hidden: bool,
    /// 栏内图标取浅色——阅读画布是暗色，浅色主题下系统的深色图标会看不见。
    pub light_icons: bool,
}

/// 原生侧 resolve 的结果（Kotlin `JSObject().put("ok", true)` / Swift `resolve(["ok": true])`）。
#[cfg(any(mobile, test))]
#[derive(serde::Deserialize)]
pub(crate) struct OkResponse {
    pub ok: bool,
}

/// 注册插件。桌面端没有系统栏，[`set_system_bars`] 什么都不做。
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new(PLUGIN_NAME)
        .setup(platform::init)
        .build()
}

/// 设置系统栏的显隐与图标明暗。
///
/// 调用方在后台线程上使用（同步等待原生侧结果）。
pub fn set_system_bars<R: Runtime>(
    app: &AppHandle<R>,
    hidden: bool,
    light_icons: bool,
) -> Result<(), String> {
    platform::set_system_bars(app, hidden, light_icons)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 原生侧的字段名（Kotlin @InvokeArg / Swift Decodable）按字段名严格解析，
    /// 改字段名会静默打断桥接，这里把 wire 契约固定下来。
    #[test]
    fn wire_contract_field_names() {
        let request = SystemBarsRequest {
            hidden: true,
            light_icons: false,
        };
        let json = serde_json::to_value(&request).unwrap();
        let mut keys: Vec<&str> = json.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["hidden", "lightIcons"],
            "系统栏请求字段名与原生侧解析不一致"
        );
        assert_eq!(json["hidden"], true);
        assert_eq!(json["lightIcons"], false);

        let response: OkResponse = serde_json::from_str(r#"{"ok":true}"#).unwrap();
        assert!(response.ok);
    }
}
