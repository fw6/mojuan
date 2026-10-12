//! 移动端实现：把渲染请求交给原生离屏 webview（Android WebView / iOS WKWebView）。

use crate::{render_request, RenderResponse};
use std::sync::Mutex;
use tauri::plugin::mobile::{ErrorResponse, PluginInvokeError};
use tauri::plugin::{PluginApi, PluginHandle};
use tauri::{AppHandle, Manager, Runtime};

/// Android 侧插件类的包名（Kotlin `RenderPlugin` 的 package）。
#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "io.github.fw6.mojuan.render";

// iOS 侧插件初始化函数（Swift `@_cdecl("init_plugin_mojuan_render")`）。
#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_mojuan_render);

/// 原生侧插件句柄（Android 的 `RenderPlugin` / iOS 的 `RenderPlugin`）。
struct NativeRender<R: Runtime>(PluginHandle<R>);

/// 单飞：原生侧是单实例离屏 webview，一次只渲染一个页面（并发 crawl 在此排队）。
static FLIGHT: Mutex<()> = Mutex::new(());

/// 插件注册：向原生侧注册插件类并持有句柄。
pub fn init<R: Runtime, C: serde::de::DeserializeOwned>(
    app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "RenderPlugin")?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_mojuan_render)?;
    app.manage(NativeRender(handle));
    Ok(())
}

/// 渲染一个 URL（阻塞等待原生侧结果；原生侧自带整体超时，必定 resolve 或 reject）。
pub fn render<R: Runtime>(app: &AppHandle<R>, url: &str) -> Result<String, String> {
    let request = render_request(url)?;
    let _guard = FLIGHT.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let handle = app.state::<NativeRender<R>>();
    let response = handle
        .0
        .run_mobile_plugin::<RenderResponse>("render", request)
        .map_err(native_error)?;
    if response.html.trim().is_empty() {
        return Err(format!("渲染结果为空: {url}"));
    }
    Ok(response.html)
}

/// 原生侧 reject 的消息原样呈现（渲染超时、拒绝页、加载失败都由原生侧给出可读
/// 文案）；其余错误是通道故障（JNI / FFI 调用失败、响应无法反序列化），加前缀区分。
fn native_error(e: PluginInvokeError) -> String {
    match e {
        PluginInvokeError::InvokeRejected(ErrorResponse {
            message: Some(message),
            ..
        }) => message,
        other => format!("渲染通道调用失败: {other}"),
    }
}
