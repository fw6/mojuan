//! 移动端实现：把安装交给原生侧（Android `PackageInstaller`）。

use crate::{AllowedResponse, InstallRequest, InstallResponse, OkResponse};
use tauri::plugin::mobile::{ErrorResponse, PluginInvokeError};
use tauri::plugin::{PluginApi, PluginHandle};
use tauri::{AppHandle, Manager, Runtime};

/// Android 侧插件类的包名（Kotlin `UpdatePlugin` 的 package）。
#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "io.github.fw6.mojuan.update";

/// iOS 侧插件初始化函数（Swift `@_cdecl("init_plugin_mojuan_update")`）。
#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_mojuan_update);

/// 原生侧插件句柄（Android 的 `UpdatePlugin` / iOS 的 `UpdatePlugin`）。
struct NativeUpdate<R: Runtime>(PluginHandle<R>);

/// 插件注册：向原生侧注册插件类并持有句柄。
pub fn init<R: Runtime, C: serde::de::DeserializeOwned>(
    app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "UpdatePlugin")?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_mojuan_update)?;
    app.manage(NativeUpdate(handle));
    Ok(())
}

/// 交一个 APK 给系统安装器（阻塞等待原生侧结算）。
pub fn install<R: Runtime>(app: &AppHandle<R>, path: &str) -> Result<String, String> {
    let response = app
        .state::<NativeUpdate<R>>()
        .0
        .run_mobile_plugin::<InstallResponse>("install", InstallRequest { path })
        .map_err(native_error)?;
    Ok(response.status)
}

/// 是否已获得「安装未知应用」授权。
pub fn can_install<R: Runtime>(app: &AppHandle<R>) -> Result<bool, String> {
    let response = app
        .state::<NativeUpdate<R>>()
        .0
        .run_mobile_plugin::<AllowedResponse>("canInstall", ())
        .map_err(native_error)?;
    Ok(response.allowed)
}

/// 跳到系统的「安装未知应用」授权页。
pub fn open_install_settings<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let response = app
        .state::<NativeUpdate<R>>()
        .0
        .run_mobile_plugin::<OkResponse>("openInstallSettings", ())
        .map_err(native_error)?;
    if !response.ok {
        return Err("系统没有打开「安装未知应用」设置页".to_string());
    }
    Ok(())
}

/// 原生侧 reject 的消息原样呈现（授权缺失、签名不一致、系统安装失败都由原生侧给出
/// 可读文案）；其余错误是通道故障（JNI / FFI 调用失败、响应无法反序列化），加前缀区分。
fn native_error(e: PluginInvokeError) -> String {
    match e {
        PluginInvokeError::InvokeRejected(ErrorResponse {
            message: Some(message),
            ..
        }) => message,
        other => format!("安装通道调用失败: {other}"),
    }
}
