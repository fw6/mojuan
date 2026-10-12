//! mojuan 移动端隐藏 webview 渲染通道（自建 tauri 插件）。
//!
//! 移动端需要与桌面端等价的渲染通道（`mojuan_core::crawler::render` 的契约）：受
//! 防护的源（Cloudflare 验证、TLS 被重置）拿不到页面，只能让真正的浏览器加载页面、
//! 等 JS 挑战跑完再取回 HTML。tauri/wry 的 `WebviewWindow` 在移动端做不到这件事
//! （Android 每个 activity 只有一个受 wry 记账的 webview，iOS 创建窗口即显示），
//! 所以这里由插件自带原生代码：Android 用不进入可见视图的 `WebView`（Kotlin），
//! iOS 用不加入任何窗口的 `WKWebView`（Swift），Rust 侧经
//! `PluginHandle::run_mobile_plugin` 同步调用（调用方是 `crawl` 命令的
//! `spawn_blocking` 线程，阻塞等待正好对上）。
//!
//! 判定与节奏都在 mojuan-core：状态脚本 [`mojuan_core::crawler::render::STATE_SCRIPT`]、
//! 取 HTML 的脚本、轮询间隔与整体超时随请求下发给原生侧。原生侧只做循环——加载、
//! 按间隔评估状态脚本、连续两次「干净」后取 HTML、拒绝页与超时 reject。挑战页的
//! 容器与标题随站点改版变动，改 mojuan-core 一处即可两端生效。
//!
//! 宿主在 setup 里把 [`render`] 注册给 mojuan-core（桌面端注册的是隐藏窗口实现）：
//!
//! ```ignore
//! let handle = app.handle().clone();
//! mojuan_core::crawler::render::set_fetcher(move |url| {
//!     tauri_plugin_mojuan_render::render(&handle, url)
//! });
//! ```

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
pub const PLUGIN_NAME: &str = "mojuan-render";

/// 渲染请求（camelCase 字段名与原生侧一致：Kotlin `@InvokeArg RenderArgs`、
/// Swift `RenderArgs: Decodable`）。判定与节奏都在 mojuan-core，随请求下发。
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RenderRequest<'a> {
    pub url: &'a str,
    /// 页面状态脚本（`mojuan_core::crawler::render::STATE_SCRIPT`）。
    pub state_script: &'a str,
    /// 取回 HTML 的脚本（`mojuan_core::crawler::render::HTML_SCRIPT`）。
    pub html_script: &'a str,
    pub poll_ms: u64,
    pub timeout_ms: u64,
}

/// 原生侧 resolve 的结果（Kotlin `JSObject().put("html", ..)` / Swift `resolve(["html": ..])`）。
#[cfg(any(mobile, test))]
#[derive(serde::Deserialize)]
pub(crate) struct RenderResponse {
    pub html: String,
}

/// 注册插件。桌面端为空实现：桌面渲染通道由 src-tauri 的隐藏窗口提供，
/// [`render`] 在桌面端返回明确错误。
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new(PLUGIN_NAME)
        .setup(platform::init)
        .build()
}

/// 渲染一个页面 URL，返回渲染后的完整 HTML。
///
/// 只接受 http(s)；移动端经原生离屏 webview，桌面端返回「由 src-tauri 的隐藏窗口
/// 实现」错误。调用方在阻塞线程上使用（同步等待原生侧结果，原生侧自带整体超时）。
pub fn render<R: Runtime>(app: &AppHandle<R>, url: &str) -> Result<String, String> {
    platform::render(app, url)
}

/// 把本插件的渲染实现注册进 mojuan-core（移动端 setup 时调用一次；
/// 桌面端注册的是 src-tauri 模块里的隐藏窗口实现）。
pub fn init_fetcher<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    mojuan_core::crawler::render::set_fetcher(move |url: &str| render(&handle, url));
}

/// 组装渲染请求（URL 校验 + mojuan-core 的判据与节奏）。
pub(crate) fn render_request(url: &str) -> Result<RenderRequest<'_>, String> {
    let target: tauri::Url = url.parse().map_err(|e| format!("渲染 URL 非法: {e}"))?;
    if !matches!(target.scheme(), "http" | "https") {
        return Err(format!("渲染通道只支持 http(s): {url}"));
    }
    Ok(RenderRequest {
        url,
        state_script: mojuan_core::crawler::render::STATE_SCRIPT,
        html_script: mojuan_core::crawler::render::HTML_SCRIPT,
        poll_ms: mojuan_core::crawler::render::POLL_INTERVAL.as_millis() as u64,
        timeout_ms: mojuan_core::crawler::render::RENDER_TIMEOUT.as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_http_urls() {
        for url in [
            "file:///etc/hosts",
            "javascript:alert(1)",
            "data:text/html,<html></html>",
            "about:blank",
            "not a url",
        ] {
            let err = render_request(url).unwrap_err();
            assert!(err.contains("只支持 http(s)") || err.contains("非法"), "url = {url}: {err}");
        }
        assert!(render_request("http://example.com/a").is_ok());
        assert!(render_request("https://example.com/a?b=c").is_ok());
    }

    /// 原生侧的字段名（Kotlin @InvokeArg / Swift Decodable）按字段名严格解析，
    /// 改字段名会静默打断桥接，这里把 wire 契约固定下来。
    #[test]
    fn wire_contract_field_names() {
        let request = render_request("https://example.com/a").unwrap();
        let json = serde_json::to_value(&request).unwrap();
        let mut keys: Vec<&str> = json.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["htmlScript", "pollMs", "stateScript", "timeoutMs", "url"],
            "渲染请求字段名与原生侧解析不一致"
        );
        assert_eq!(json["url"], "https://example.com/a");
        assert_eq!(json["pollMs"], 500);
        assert_eq!(json["timeoutMs"], 60_000);
        assert!(json["stateScript"].as_str().unwrap().contains("readyState"));
        assert_eq!(json["htmlScript"], "document.documentElement.outerHTML");

        let response: RenderResponse = serde_json::from_str(r#"{"html":"<html></html>"}"#).unwrap();
        assert_eq!(response.html, "<html></html>");
    }
}
