//! 隐藏 webview 渲染通道（Cloudflare 防护源用）。
//!
//! 宿主在 setup 时经 [`set_fetcher`] 注册渲染实现：不可见 webview 加载目标 URL，
//! 等待 Cloudflare 验证与页面渲染完成后取回完整 HTML。渲染源的 `fetch()`（见
//! `script.rs`）经本通道拿到的 HTML 走与普通抓取完全相同的 parse 契约，与
//! rquickjs 管道并存。
//!
//! 未注册宿主（mojuan-core 单独跑测试、无 webview 的进程）时 [`fetch`] 返回明确
//! 错误，由 `record_error` 呈现到前端错误行。
//!
//! 渲染实现的「判据」集中在本模块：[`STATE_SCRIPT`] 返回页面状态，
//! [`is_clean`] 判定是否可提取，[`POLL_INTERVAL`] / [`RENDER_TIMEOUT`] 给出轮询
//! 节奏与整体超时。桌面宿主（src-tauri 的隐藏窗口）与移动端插件（Android
//! WebView / iOS WKWebView）都执行同一段 [`STATE_SCRIPT`]，各平台只负责「重复
//! 评估、连续两次干净后取 [`HTML_SCRIPT`]」的循环。挑战页的容器与标题随站点
//! 改版变动，改这里一处即可两端生效。

use std::sync::OnceLock;
use std::time::Duration;

type RenderFetcher = Box<dyn Fn(&str) -> Result<String, String> + Send + Sync>;

static FETCHER: OnceLock<RenderFetcher> = OnceLock::new();

/// 整体渲染超时（含验证挑战等待与跳转链）。
pub const RENDER_TIMEOUT: Duration = Duration::from_secs(60);

/// 页面状态轮询间隔。
pub const POLL_INTERVAL: Duration = Duration::from_millis(500);

/// 页面状态探测脚本：返回 `{rs, href, ch, denied, clean}`。
///
/// - `ch`：验证挑战页（Cloudflare 多语言「Just a moment」系标题与 challenge /
///   turnstile 容器；包子漫画 tw 域自建的 proof-of-work 验证页
///   `__gatekeeper_challenge` 资源 +「正在验证浏览器」标题，JS 算完自动跳转）；
/// - `denied`：Cloudflare 1020 拒绝页（立即失败，不空耗超时）；
/// - `clean`：目标文档 DOM 解析完成、无挑战、无拒绝、已离开 about:blank，
///   即可以提取 HTML。`readyState` 接受 `interactive`：阅读器页有长时间挂起的
///   子资源（统计/广告脚本），`complete` 可能永远不来；`interactive` = 主文档
///   解析完成，`outerHTML` 已含全部内容，解析 HTML 只需要标记结构。
pub const STATE_SCRIPT: &str = r#"(function () {
  var rs = document.readyState;
  var href = location.href;
  var ch = !!(document.querySelector('#challenge-form, #challenge-running, #challenge-stage, #turnstile-wrapper, cf-chl-widget, #challenge-turnstile, link[href*="gatekeeper"], script[src*="gatekeeper"]')
    || /just a moment|only a moment|moment mal|un instant|attendez|请稍候|正在验证|正在驗證|verifying/i.test(document.title));
  var denied = !!(document.querySelector('.cf-error-details, #cf-error-details')
    || /attention required|access denied|error 1020/i.test(document.title));
  var clean = (rs === 'complete' || rs === 'interactive') && !ch && !denied && href.indexOf('http') === 0;
  return { rs: rs, href: href, ch: ch, denied: denied, clean: clean };
})()"#;

/// 取回渲染结果的脚本（在页面稳定后评估）。
pub const HTML_SCRIPT: &str = "document.documentElement.outerHTML";

/// [`STATE_SCRIPT`] 的结果是否「干净」（可以提取 HTML）。
pub fn is_clean(state: &serde_json::Value) -> bool {
    state
        .get("clean")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// 状态是否命中了 Cloudflare 拒绝页（错误页/访问被拒，立即失败）。
pub fn is_denied(state: &serde_json::Value) -> bool {
    state
        .get("denied")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// 宿主注册渲染实现（进程内一次；重复注册被忽略）。
pub fn set_fetcher(f: impl Fn(&str) -> Result<String, String> + Send + Sync + 'static) {
    let _ = FETCHER.set(Box::new(f));
}

/// 渲染一个页面 URL，返回渲染后的完整 HTML。
pub fn fetch(url: &str) -> Result<String, String> {
    match FETCHER.get() {
        Some(f) => f(url),
        None => Err("渲染通道未注册（当前宿主无隐藏 webview）".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 页面桩：给 `document` / `location` 装上状态脚本需要的字段。
    /// `hit` 是「页面里命中的元素选择器片段」，querySelector 命中它即返回节点。
    const PAGE_STUB: &str = r#"
    function page(opts) {
      var rs = opts.rs || 'complete';
      var title = opts.title || '';
      var href = opts.href || 'https://example.com/comic/1';
      var hit = opts.hit || null;
      globalThis.document = {
        readyState: rs,
        title: title,
        querySelector: function (sel) { return hit && sel.indexOf(hit) >= 0 ? { nodeType: 1 } : null; },
        documentElement: { outerHTML: '<html></html>' }
      };
      globalThis.location = { href: href };
    }
    "#;

    /// 在 QuickJS 里跑一遍 [`STATE_SCRIPT`]，返回脚本结果。
    fn run_state_script(opts: &str) -> serde_json::Value {
        let runtime = rquickjs::Runtime::new().expect("Runtime");
        let context = rquickjs::Context::full(&runtime).expect("Context");
        context.with(|cx| {
            cx.eval::<(), _>(PAGE_STUB).expect("页面桩");
            cx.eval::<(), _>(format!("page({opts})")).expect("页面");
            let out: String = cx
                .eval::<String, _>(format!("JSON.stringify({STATE_SCRIPT})"))
                .expect("状态脚本");
            serde_json::from_str(&out).expect("状态脚本返回 JSON")
        })
    }

    #[test]
    fn fetch_without_fetcher_errors_clearly() {
        // 测试进程未注册宿主：错误消息可直接呈现给用户
        let err = fetch("https://example.com").unwrap_err();
        assert!(err.contains("渲染通道未注册"), "err = {err}");
    }

    #[test]
    fn state_script_accepts_settled_documents() {
        for rs in ["complete", "interactive"] {
            let state = run_state_script(&format!("{{ rs: '{rs}' }}"));
            assert_eq!(state["rs"], rs);
            assert!(is_clean(&state), "rs = {rs}: {state}");
            assert!(!is_denied(&state));
        }
    }

    #[test]
    fn state_script_waits_for_document_and_target() {
        // 仍在解析主文档
        assert!(!is_clean(&run_state_script("{ rs: 'loading' }")));
        // 复位阶段停在 about:blank
        assert!(!is_clean(&run_state_script(
            "{ href: 'about:blank', rs: 'complete' }"
        )));
    }

    #[test]
    fn state_script_flags_challenge_pages() {
        // Cloudflare 挑战页：标题命中，且尚未离开挑战 URL
        let cf = run_state_script("{ title: 'Just a moment...' }");
        assert_eq!(cf["ch"], true);
        assert!(!is_clean(&cf));

        // 包子漫画 tw 域自建 proof-of-work 验证页：页面里有 gatekeeper 资源
        let gatekeeper = run_state_script("{ hit: 'gatekeeper' }");
        assert_eq!(gatekeeper["ch"], true);
        assert!(!is_clean(&gatekeeper));

        // 中文标题的挑战页
        let zh = run_state_script("{ title: '正在验证浏览器' }");
        assert_eq!(zh["ch"], true);
    }

    #[test]
    fn state_script_flags_denied_pages() {
        let by_container = run_state_script("{ hit: '.cf-error-details' }");
        assert_eq!(by_container["denied"], true);
        assert!(!is_clean(&by_container));

        let by_title = run_state_script("{ title: 'Attention Required! | Cloudflare' }");
        assert_eq!(by_title["denied"], true);
        assert!(!is_clean(&by_title));
    }

    #[test]
    fn state_helpers_default_to_false() {
        assert!(!is_clean(&json!({})));
        assert!(!is_denied(&json!({})));
        assert!(is_clean(&json!({ "clean": true })));
        assert!(is_denied(&json!({ "denied": true })));
    }
}
