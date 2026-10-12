//! 隐藏 webview 渲染通道（Cloudflare / 自建验证防护源，如 baozimh）。
//!
//! 单例不可见 webview + Rust 侧轮询：
//! 1. `render_sync`（阻塞线程调用，来自 `crawl` 命令的 spawn_blocking）经单飞互斥串行化；
//! 2. 懒创建隐藏 webview（主线程，run_on_main_thread 调度）；
//! 3. 每次渲染先导航回 `about:blank` 再导航到目标：保证目标加载恒为全新的跨文档
//!    导航（排除上一次渲染的残留文档与同 URL 片段导航），页面就绪判定用
//!    `location.href` + `document.readyState`（`eval_with_callback` 在跨站重定向、
//!    WebKit 进程交换场景下都可靠；`on_page_load` 事件在 macOS 跨站导航时会丢失，
//!    不可用作门控）；
//! 4. 每 500ms eval 页面状态：验证挑战页（Cloudflare / 包子漫画 tw 域自建的
//!    proof-of-work gatekeeper）等待其自动跳转，拒绝页立即报错；
//! 5. 连续两次干净检查后提取 `document.documentElement.outerHTML` 返回。
//!
//! 页面状态脚本与判定（[`mojuan_core::crawler::render`] 的 `STATE_SCRIPT` /
//! `is_clean` / `is_denied`）、轮询节奏与整体超时都由 mojuan-core 定义：移动端的
//! 隐藏 webview 插件（`tauri-plugin-mojuan-render`）执行同一套判据。
//!
//! HTML 经宿主侧 eval 回调取回（tauri 2.11 的 `eval_with_callback`），远程页面不需要
//! 任何 IPC 权限——渲染 webview 没有匹配的 capability，页面脚本无法调用应用命令。
//! 验证通过的 cookie（cf_clearance / gatekeeper ticket）由 WKWebView/WebView2 默认
//! 持久化数据存储保留，后续渲染与重启应用都能复用。

use mojuan_core::crawler::render::{
    is_clean, is_denied, HTML_SCRIPT, POLL_INTERVAL, RENDER_TIMEOUT, STATE_SCRIPT,
};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// 隐藏渲染 webview 的 label（capability 不覆盖它 = 远程页面无 IPC）。
pub const RENDER_LABEL: &str = "render";

/// 复位到 about:blank 的等待上限（本地文档，正常一两个轮询即到）。
const RESET_TIMEOUT: Duration = Duration::from_secs(5);
/// 单次 eval 回调等待上限。
const EVAL_TIMEOUT: Duration = Duration::from_secs(5);

/// 单飞：隐藏 webview 单实例，一次只渲染一个页面（crawl 并发调用在此排队）。
static FLIGHT: Mutex<()> = Mutex::new(());

/// 诊断跟踪：设置环境变量 `MOJUAN_RENDER_TRACE=1` 时把渲染过程打到 stderr。
macro_rules! trace {
    ($($arg:tt)*) => {
        if std::env::var_os("MOJUAN_RENDER_TRACE").is_some() {
            eprintln!("[render] {}", format_args!($($arg)*));
        }
    };
}

/// 把渲染通道注册进 mojuan-core（setup 时调用一次）。
pub fn init(app: &AppHandle) {
    let handle = app.clone();
    mojuan_core::crawler::render::set_fetcher(move |url: &str| render_sync(&handle, url));
}

/// 渲染一个 URL，返回渲染后的完整 HTML。供 render fetcher 与探针 example 调用。
pub fn render_sync(app: &AppHandle, url: &str) -> Result<String, String> {
    let _guard = FLIGHT.lock().unwrap();
    let target: tauri::Url = url.parse().map_err(|e| format!("渲染 URL 非法: {e}"))?;
    if !matches!(target.scheme(), "http" | "https") {
        return Err(format!("渲染通道只支持 http(s): {url}"));
    }
    let webview = ensure_webview(app)?;
    trace!("webview 就绪，开始渲染 {url}");
    let deadline = Instant::now() + RENDER_TIMEOUT;

    // 复位到 about:blank：后续目标导航必为全新跨文档加载，href 判定不受残留文档干扰
    webview
        .navigate("about:blank".parse().unwrap())
        .map_err(|e| format!("渲染复位导航失败: {e}"))?;
    wait_reset(&webview);

    webview
        .navigate(target)
        .map_err(|e| format!("渲染导航失败: {e}"))?;
    let mut settled = false; // 连续两次干净检查才算稳定（挑战页跳转瞬间防误提取）
    let mut last_state = String::new(); // 诊断：超时报错附带最后一次可见状态
    loop {
        let remain = deadline.checked_duration_since(Instant::now()).ok_or_else(|| {
            format!("渲染超时（页面加载未完成或验证未通过）: {url}；最后状态: {last_state}")
        })?;
        std::thread::sleep(POLL_INTERVAL.min(remain));
        match eval_value(&webview, STATE_SCRIPT) {
            Ok(state) => {
                trace!("状态: {state}");
                last_state = state.to_string();
                if is_denied(&state) {
                    return Err(format!("Cloudflare 拒绝访问（错误页/访问被拒）: {url}"));
                }
                if is_clean(&state) {
                    if settled {
                        break;
                    }
                    settled = true;
                } else {
                    settled = false;
                }
            }
            // eval 失败（文档切换瞬间/页面脚本繁忙）：按未就绪继续轮询，整体超时兜底
            Err(e) => {
                trace!("eval 失败: {e}");
                last_state = format!("eval 失败: {e}");
                settled = false;
            }
        }
    }
    let html = eval_string(&webview, HTML_SCRIPT)
        .map_err(|e| format!("渲染结果提取失败: {e}"))?;
    if html.trim().is_empty() {
        return Err(format!("渲染结果为空: {url}"));
    }
    Ok(html)
}

/// 等待复位导航落地（href 变为 about:blank）。超时不报错：目标导航会覆盖旧文档，
/// 极端情况下只是失去 href 门控的残留判定，整体超时兜底。
fn wait_reset(webview: &WebviewWindow) {
    let deadline = Instant::now() + RESET_TIMEOUT;
    while Instant::now() < deadline {
        if let Ok(state) = eval_value(webview, STATE_SCRIPT) {
            if state.get("href").and_then(|v| v.as_str()) == Some("about:blank") {
                return;
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    trace!("复位 about:blank 超时，继续导航");
}

/// 懒创建隐藏渲染 webview（已存在则复用）。创建必须在主线程：run_on_main_thread 调度后
/// 同步等待结果。1280x800 视口保证目标站给桌面版布局。
fn ensure_webview(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(w) = app.get_webview_window(RENDER_LABEL) {
        return Ok(w);
    }
    trace!("创建隐藏渲染 webview");
    let (tx, rx) = mpsc::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let built = WebviewWindowBuilder::new(
            &handle,
            RENDER_LABEL,
            WebviewUrl::External("about:blank".parse().unwrap()),
        )
        .title("mojuan-render")
        .inner_size(1280.0, 800.0)
        .visible(false)
        .skip_taskbar(true)
        .decorations(false)
        .resizable(false)
        .focused(false)
        .build();
        let _ = tx.send(built);
    })
    .map_err(|e| format!("渲染 webview 创建无法调度到主线程: {e}"))?;
    rx.recv_timeout(Duration::from_secs(10))
        .map_err(|e| format!("渲染 webview 创建超时: {e}"))?
        .map_err(|e| format!("渲染 webview 创建失败: {e}"))
}

/// eval 并把结果 JSON 反序列化（eval_with_callback 的回调收到 JSON 字符串）。
fn eval_value(webview: &WebviewWindow, expr: &str) -> Result<serde_json::Value, String> {
    let (tx, rx) = mpsc::channel();
    webview
        .eval_with_callback(expr, move |out| {
            let _ = tx.send(out);
        })
        .map_err(|e| format!("eval 失败: {e}"))?;
    let raw = rx
        .recv_timeout(EVAL_TIMEOUT)
        .map_err(|_| "eval 回调超时".to_string())?;
    serde_json::from_str(&raw).map_err(|e| format!("eval 结果非 JSON: {e}"))
}

/// eval 一个字符串表达式并取出字符串值。
fn eval_string(webview: &WebviewWindow, expr: &str) -> Result<String, String> {
    let v = eval_value(webview, expr)?;
    v.as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| format!("eval 结果非字符串: {v}"))
}
