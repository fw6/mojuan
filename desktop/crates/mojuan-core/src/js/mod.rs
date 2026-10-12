//! 源运行时执行层 —— 契约（[ADR-0002](../../../../docs/adr/0002-source-definition-as-document.md)）。
//!
//! 装载器把 `var DOC = <文档 JSON>;` 拼在运行时源码之前，合成一段脚本交给本层。脚本导出
//! 两个全局函数，参数与返回值都是 JSON 字符串：
//! - `plan(req)` → 下一个请求步骤 `{name,url,headers,input}`，或 `{done:true}`（请求已发完），
//!   或 `{abort:true}`（本次 op 无法进行，按空结果返回）
//! - `parse(req)` → `{"data": <crawl 协议值>, "hidden": [{"name","key","value"}]}`
//! - `req` = `{op, payload, ctx, responses}`；`responses` 是 `{步骤名: 响应体}`
//!
//! 抓取由宿主做（见 `crawler/script.rs` 的 op 流程）：本层只负责求值与解析，所以 2 秒墙钟
//! 超时仍然只覆盖纯计算，不覆盖网络往返。
//!
//! HTML 求值经宿主绑定 [`HOST_BINDING`]：`__host.select(html, selector)` 返回
//! `[{attrs, text, html}]` 的 JSON 字符串，由 app 侧的 `scraper`（html5ever + CSS 选择器）
//! 完成。绑定是纯计算，不碰网络与文件系统。
//!
//! 限制（research #13/#14 定案，含 #14 修订）：每次调用新建 Runtime（用完即弃）；
//! 内存上限 32MB；墙钟超时 2s（interrupt handler）；脚本 ≤ 256KB（运行时 + 文档，Rust 侧检查）。
//! 线程模型：本层无内部线程、无跨调用状态，调用方在 blocking 线程内使用
//! （src-tauri 的 `spawn_blocking`），天然并发安全。
//! rquickjs 0.12.2 默认 features；勿开 `rust-alloc`（令 `set_memory_limit` 失效）。
//! 全局白名单挂 Date/Json/Eval/RegExp（research #14 修订：Eval intrinsic 必须挂——引擎执行脚本
//! 本身走 `eval_internal`，`custom` 缺 Eval 时连脚本都加载不了；全局 eval/Function 无法分离禁用，
//! DoS 兜底靠超时/内存/脚本体积）。RegExp 供文档里的钩子用（算法型源的出口）：灾难性回溯由
//! 2 秒墙钟超时打断（见 `catastrophic_regex_backtracking_is_interrupted`），MapSet 未挂。

pub mod runtime;

use rquickjs::context::intrinsic::{Date, Eval, Json, RegExp};
use rquickjs::{CaughtError, CatchResultExt, Context, Function, Object, Runtime};
use std::time::{Duration, Instant};

/// 脚本体积上限（字节；运行时与文档之和）。
const MAX_SCRIPT_BYTES: usize = 256 * 1024;
/// 单次解析墙钟超时。
const TIMEOUT: Duration = Duration::from_secs(2);
/// 引擎内存上限（字节）。
const MEMORY_LIMIT: usize = 32 * 1024 * 1024;

/// 宿主绑定的全局名。
pub const HOST_BINDING: &str = "__host";

/// 调源运行时的全局函数：`func(reqJson)`，成功返回 JSON 字符串。
pub fn call(script: &str, func: &str, req: &str) -> Result<String, String> {
    if script.len() > MAX_SCRIPT_BYTES {
        return Err(format!(
            "运行时与文档合计超过 {}KB 上限",
            MAX_SCRIPT_BYTES / 1024
        ));
    }
    let runtime = Runtime::new().map_err(|e| e.to_string())?;
    runtime.set_memory_limit(MEMORY_LIMIT);
    let deadline = Instant::now() + TIMEOUT;
    runtime.set_interrupt_handler(Some(Box::new(move || Instant::now() >= deadline)));

    let context =
        Context::custom::<(Date, Json, Eval, RegExp)>(&runtime).map_err(|e| e.to_string())?;
    context.with(|cx| {
        // 先编译并执行脚本（语法错误/顶层 throw 在这里报出，含行号堆栈）。
        cx.eval::<(), _>(script).catch(&cx).map_err(caught_error)?;
        install_host(&cx)?;
        let f: Function = cx.globals().get(func).map_err(|e| e.to_string())?;
        f.call::<_, String>((req,)).catch(&cx).map_err(caught_error)
    })
}

/// 挂宿主绑定：目前只有纯计算的 HTML 选择器。
fn install_host(cx: &rquickjs::Ctx<'_>) -> Result<(), String> {
    let host = Object::new(cx.clone()).map_err(|e| e.to_string())?;
    host.set(
        "select",
        Function::new(cx.clone(), |html: String, selector: String| -> String {
            match select_regions(&html, &selector) {
                Ok(json) => json,
                // 选择器非法：抛给脚本（运行时不捕获，最终作为 op 的错误呈现）
                Err(e) => format!("{{\"__error\":{}}}", serde_json::Value::String(e)),
            }
        }),
    )
    .map_err(|e| e.to_string())?;
    cx.globals()
        .set(HOST_BINDING, host)
        .map_err(|e| e.to_string())
}

/// HTML 选择器的宿主实现：`scraper`（html5ever + CSS 选择器）求值，返回
/// `[{"attrs": {名: 值}, "text": 文本, "html": 内部标记}]` 的 JSON 字符串。
pub fn select_regions(html: &str, selector: &str) -> Result<String, String> {
    use scraper::{Html, Selector};
    let sel = Selector::parse(selector).map_err(|e| format!("选择器非法 {selector}: {e:?}"))?;
    let doc = Html::parse_document(html);
    let mut out = Vec::new();
    for el in doc.select(&sel) {
        let mut attrs = serde_json::Map::new();
        for (name, value) in el.value().attrs() {
            attrs.insert(name.to_string(), serde_json::Value::String(value.to_string()));
        }
        let text = el.text().collect::<Vec<_>>().join(" ");
        out.push(serde_json::json!({
            "attrs": attrs,
            "text": text,
            "html": el.inner_html(),
        }));
    }
    serde_json::to_string(&out).map_err(|e| e.to_string())
}

/// 把 JS 侧错误转为带消息与堆栈的字符串。
fn caught_error(c: CaughtError) -> String {
    match c {
        CaughtError::Exception(e) => format!(
            "{} @ {}",
            e.message().unwrap_or_default(),
            e.stack().unwrap_or_default()
        ),
        CaughtError::Value(v) => format!("脚本抛出非 Error 值: {v:?}"),
        CaughtError::Error(e) => e.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// 最小文档 + 最小运行时：验证 plan/parse 契约与宿主绑定。
    const MINI_DOC: &str = r#"{
        "schema": 1, "id": "demo", "title": "演示", "idPrefix": "demo-",
        "base": "https://example.com",
        "categories": [{ "label": "悬疑", "url": "https://example.com/s" }],
        "ops": {
            "search": {
                "request": [{ "name": "list", "url": "{base}/search?q={keyword}" }],
                "items": "div.item",
                "id": { "attr": "data-id" },
                "fields": { "title": "h3", "cover": { "select": "img", "attr": "src" } }
            }
        }
    }"#;

    const LIST_HTML: &str = r#"
        <div class="item" data-id="1"><h3>海贼王</h3><img src="https://img.example.com/1.webp"></div>
        <div class="item" data-id="2"><h3>电锯人</h3><img src="https://img.example.com/2.webp"></div>
    "#;

    fn script() -> String {
        format!("var DOC = {MINI_DOC};\n{}", runtime::source())
    }

    fn plan(op: &str, payload: &str, responses: &str) -> Value {
        let req = format!(
            r#"{{"op":"{op}","payload":{payload},"ctx":{{}},"responses":{responses}}}"#
        );
        let out = call(&script(), "plan", &req).expect("plan 应成功");
        serde_json::from_str(&out).expect("plan 返回 JSON")
    }

    fn parse(op: &str, payload: &str, responses: &str) -> Value {
        let req = format!(
            r#"{{"op":"{op}","payload":{payload},"ctx":{{}},"responses":{responses}}}"#
        );
        let out = call(&script(), "parse", &req).expect("parse 应成功");
        serde_json::from_str(&out).expect("parse 返回 JSON")
    }

    #[test]
    fn plan_returns_the_first_step_url() {
        let step = plan("search", r#"{"keyword":"op"}"#, "{}");
        assert_eq!(step["name"], "list");
        assert_eq!(step["url"], "https://example.com/search?q=op");
    }

    #[test]
    fn plan_is_done_when_every_step_has_a_response() {
        let step = plan("search", r#"{"keyword":"op"}"#, r#"{"list":""}"#);
        assert_eq!(step["done"], true);
    }

    #[test]
    fn parse_reads_the_response_by_step_name() {
        let out = parse(
            "search",
            r#"{"keyword":"op"}"#,
            &format!(r#"{{"list":{}}}"#, serde_json::to_string(LIST_HTML).unwrap()),
        );
        let comics = out["data"].as_array().expect("data 应是数组");
        assert_eq!(comics.len(), 2);
        assert_eq!(comics[0]["id"], "demo-1");
        assert_eq!(comics[0]["title"], "海贼王");
        assert_eq!(comics[0]["cover"], "https://img.example.com/1.webp");
        assert_eq!(comics[0]["source"], "demo");
    }

    #[test]
    fn categories_comes_from_the_static_table() {
        let out = parse("categories", "{}", "{}");
        assert_eq!(out["data"][0], "悬疑");
    }

    #[test]
    fn selector_errors_are_reported() {
        let err = select_regions("<div></div>", "div:::").unwrap_err();
        assert!(err.contains("选择器非法"), "err = {err}");
    }

    #[test]
    fn host_select_returns_attrs_text_and_inner_html() {
        let json = select_regions(LIST_HTML, "div.item").unwrap();
        let list: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(list.as_array().unwrap().len(), 2);
        assert_eq!(list[0]["attrs"]["data-id"], "1");
        assert_eq!(list[0]["text"], "海贼王");
        assert!(list[0]["html"].as_str().unwrap().contains("<h3>"));
    }

    #[test]
    fn throw_surfaces_as_err_with_message() {
        let broken = "var DOC = {}; function plan() { throw new Error('boom') } function parse(){}";
        let err = call(broken, "plan", "{}").unwrap_err();
        assert!(err.contains("boom"), "err = {err}");
    }

    #[test]
    fn script_syntax_error_reports_line() {
        let err = call("function plan( { return 1 }", "plan", "{}").unwrap_err();
        assert!(!err.is_empty(), "语法错误应报出消息/堆栈");
    }

    #[test]
    fn infinite_loop_interrupted_by_timeout() {
        let evil = "function plan() { while (true) {} } function parse(){}";
        let started = Instant::now();
        let err = call(evil, "plan", "{}").unwrap_err();
        assert!(started.elapsed() < TIMEOUT * 3, "应被 {TIMEOUT:?} 超时打断");
        assert!(!err.is_empty());
    }

    #[test]
    fn oversized_script_rejected() {
        let big = "x".repeat(MAX_SCRIPT_BYTES + 1);
        assert!(call(&big, "plan", "{}").is_err());
    }

    /// 带 items 钩子的文档：钩子用共享前导与选择器自己挑单元，字段仍走声明式。
    const HOOK_DOC: &str = r#"{
        "schema": 1, "id": "hook", "title": "钩子演示", "idPrefix": "hook-",
        "base": "https://example.com",
        "ops": {
            "search": {
                "request": [{ "name": "list", "url": "{base}/s?q={keyword}" }],
                "items": { "script": "function (api) {\n  if (typeof api.select !== 'function' || !api.helpers) throw new Error('钩子 api 缺 select / helpers');\n  var nodes = api.select(api.responses.list, 'div.item');\n  var kw = api.helpers.trim(api.payload.keyword || '');\n  var out = [];\n  for (var i = 0; i < nodes.length; i++) {\n    if (api.helpers.collapse(nodes[i].text).indexOf(kw) >= 0) out.push(nodes[i]);\n  }\n  return out;\n}" },
                "id": { "attr": "data-id" },
                "fields": { "title": "h3" }
            }
        }
    }"#;

    /// 整 op 钩子的文档：用 RegExp 从响应里取一个值（沙箱挂了 RegExp）。
    const REGEX_DOC: &str = r#"{
        "schema": 1, "id": "re", "title": "正则", "idPrefix": "re-",
        "base": "https://example.com",
        "ops": {
            "search": {
                "request": [{ "name": "list", "url": "{base}/s?q={keyword}" }],
                "script": "function (api) {\n  var m = /title_no=(\\d+)/.exec(api.responses.list);\n  return m ? [m[1]] : [];\n}"
            }
        }
    }"#;

    fn call_doc(doc: &str, op: &str, payload: &str, responses: &str) -> Value {
        let script = format!("var DOC = {doc};\n{}", runtime::source());
        let req =
            format!(r#"{{"op":"{op}","payload":{payload},"ctx":{{}},"responses":{responses}}}"#);
        let out = call(&script, "parse", &req).expect("parse 应成功");
        serde_json::from_str(&out).expect("parse 返回 JSON")
    }

    #[test]
    fn hook_gets_the_shared_prelude_and_the_selector() {
        let responses = format!(
            r#"{{"list":{}}}"#,
            serde_json::to_string(LIST_HTML).unwrap()
        );
        let out = call_doc(HOOK_DOC, "search", r#"{"keyword":"电"}"#, &responses);
        let comics = out["data"].as_array().expect("data 应是数组");
        assert_eq!(comics.len(), 1, "钩子应只留下命中关键词的单元");
        assert_eq!(comics[0]["id"], "hook-2");
        assert_eq!(comics[0]["title"], "电锯人");
    }

    #[test]
    fn hook_may_use_regexp() {
        let responses = r#"{"list":"<a href=\"/viewer?title_no=1571\">x</a>"}"#;
        let out = call_doc(REGEX_DOC, "search", r#"{"keyword":"x"}"#, responses);
        assert_eq!(out["data"][0], "1571");
    }

    #[test]
    fn catastrophic_regex_backtracking_is_interrupted() {
        let evil = "function plan() { var s = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!'; \
                    return String(/(a+)+$/.test(s)) } function parse(){}";
        let started = Instant::now();
        let out = call(evil, "plan", "{}");
        let elapsed = started.elapsed();
        println!("elapsed = {elapsed:?}, out = {out:?}");
        assert!(elapsed < TIMEOUT * 3, "灾难性回溯应被超时打断，实际 {elapsed:?}");
    }
}
