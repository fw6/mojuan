//! 移动端实现：把系统栏设置交给原生侧（Android `WindowInsetsControllerCompat` /
//! iOS 视图控制器的状态栏求值）。

use crate::{OkResponse, SystemBarsRequest};
use tauri::plugin::mobile::{ErrorResponse, PluginInvokeError};
use tauri::plugin::{PluginApi, PluginHandle};
use tauri::{AppHandle, Manager, Runtime};

/// Android 侧插件类的包名（Kotlin `SystemBarsPlugin` 的 package）。
#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "io.github.fw6.mojuan.systembars";

/// iOS 侧插件初始化函数（Swift `@_cdecl("init_plugin_mojuan_system_bars")`）。
#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_mojuan_system_bars);

/// 原生侧插件句柄（Android 的 `SystemBarsPlugin` / iOS 的 `SystemBarsPlugin`）。
struct NativeSystemBars<R: Runtime>(PluginHandle<R>);

/// 插件注册：向原生侧注册插件类并持有句柄。
pub fn init<R: Runtime, C: serde::de::DeserializeOwned>(
    app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "SystemBarsPlugin")?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_mojuan_system_bars)?;
    app.manage(NativeSystemBars(handle));
    Ok(())
}

/// 设置系统栏（阻塞等待原生侧结果；原生侧在主线程上应用并结算）。
pub fn set_system_bars<R: Runtime>(
    app: &AppHandle<R>,
    hidden: bool,
    light_icons: bool,
) -> Result<(), String> {
    let request = SystemBarsRequest {
        hidden,
        light_icons,
    };
    let response = app
        .state::<NativeSystemBars<R>>()
        .0
        .run_mobile_plugin::<OkResponse>("setSystemBars", request)
        .map_err(native_error)?;
    if !response.ok {
        return Err("系统栏设置没有生效".to_string());
    }
    Ok(())
}

/// 原生侧 reject 的消息原样呈现（窗口未就绪、平台不支持都由原生侧给出可读文案）；
/// 其余错误是通道故障（JNI / FFI 调用失败、响应无法反序列化），加前缀区分。
fn native_error(e: PluginInvokeError) -> String {
    match e {
        PluginInvokeError::InvokeRejected(ErrorResponse {
            message: Some(message),
            ..
        }) => message,
        other => format!("系统栏通道调用失败: {other}"),
    }
}
