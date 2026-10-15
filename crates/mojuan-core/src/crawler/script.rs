//! 源 op 执行器：plan → 抓取 → plan → … → parse → 隐藏值入缓存。
//!
//! 抓取留在 Rust（网络、请求头、渲染通道、HTTP 超时），运行时只做纯计算（求 URL 与解析），
//! 所以引擎的 2 秒墙钟超时只覆盖计算，不覆盖网络往返（见 `js::call` 的说明）。
//!
//! 一个 op 可以按顺序发多次请求：运行时的 `plan` 每次返回下一个还没拿到响应的步骤，
//! 后一步的 URL 可以用前面步骤响应里取出的值（mangadex / copymanga / dongman 的章节 id、
//! copymanga 的 uuid、dongman 的 viewer URL 都是这个形状）。

use crate::crawler::doc::{OPS, SCHEMA_VERSION};
use crate::crawler::registry::Entry;
use crate::crawler::{http, registry, render};
use serde_json::{json, Map, Value};

/// 单个 op 的请求步骤上限（防文档写出没有尽头的请求链）。
const MAX_STEPS: usize = 8;

/// op 执行循环的可观察接口：隐藏值存储、错误上报、步骤记录。
///
/// 已装源路径的实现（[`EntryObserver`]）沿用该源的错误行与隐藏值缓存、丢弃步骤记录；
/// 调试路径的实现把步骤收集起来（见 `crawl_debug`）。
pub trait RunObserver {
    /// 交给运行时的 `ctx.hidden`（`{名: {键: 值}}`）。
    fn hidden_ctx(&self) -> Value;
    /// 写入一条隐藏值。
    fn put_hidden(&self, name: &str, key: &str, value: &str);
    /// 上报一次失败：`stage` 是 plan / fetch / parse。
    fn record_error(&self, stage: &str, message: &str);
    /// op 成功时清除最近错误。
    fn clear_error(&self);
    /// 记录一步。
    fn record_step(&self, step: Step);
}

/// 一次运行走过的一步（调试台按顺序展示）。
#[derive(Debug)]
pub enum Step {
    /// 运行时为一个请求步骤求出的 URL 与请求头。
    Plan {
        name: String,
        url: String,
        headers: Vec<(String, String)>,
    },
    /// 一次抓取拿到的响应体；抓取失败时 `error` 带上原因（调试台据此显示失败停在这一步）。
    Fetch {
        name: String,
        url: String,
        body: String,
        error: Option<String>,
    },
    /// parse 的输出（数据与运行时交出的隐藏值）。
    Parse { data: Value, hidden: Value },
}

impl Step {
    /// 阶段名（plan / fetch / parse）。
    pub fn stage(&self) -> &'static str {
        match self {
            Step::Plan { .. } => "plan",
            Step::Fetch { .. } => "fetch",
            Step::Parse { .. } => "parse",
        }
    }
}

/// 跑一个 op。第二个返回值 = 本次是否成功（供结果缓存判定，见 `crawler::crawl`）。
/// 失败按协议返回空 JSON 并把原因记进该源的错误行。
pub fn run(entry: &Entry, op: &str, payload: &str) -> (String, bool) {
    let observer = EntryObserver { entry, op };
    execute(
        &observer,
        &registry::script_for(entry),
        entry.doc.render_channel,
        op,
        payload,
    )
}

/// 已装源（生产路径）的观察者：错误写进该源的错误行、隐藏值进缓存、步骤丢弃。
struct EntryObserver<'a> {
    entry: &'a Entry,
    op: &'a str,
}

impl RunObserver for EntryObserver<'_> {
    fn hidden_ctx(&self) -> Value {
        self.entry.hidden_ctx()
    }

    fn put_hidden(&self, name: &str, key: &str, value: &str) {
        self.entry.put_hidden(name, key, value);
    }

    fn record_error(&self, stage: &str, message: &str) {
        self.entry.record(&format!("{stage}({}): {message}", self.op));
    }

    fn clear_error(&self) {
        self.entry.clear();
    }

    fn record_step(&self, _step: Step) {}
}

/// 执行循环：plan → fetch → … → parse。隐藏值、错误、步骤都经 `observer` 上报；
/// 脚本与渲染通道由调用方给定（已装源走 [`run`]，调试运行另给一份文档原文）。
pub fn execute(
    observer: &dyn RunObserver,
    script: &str,
    render_channel: bool,
    op: &str,
    payload: &str,
) -> (String, bool) {
    let ctx = json!({ "hidden": observer.hidden_ctx() });
    let mut responses = Map::new();

    for _ in 0..MAX_STEPS {
        let req = request_json(op, payload, &ctx, &responses);
        let step = match crate::js::call(script, "plan", &req) {
            Ok(s) => s,
            Err(e) => return fail(observer, op, "plan", &e),
        };
        let step: Value = match serde_json::from_str(&step) {
            Ok(v) => v,
            Err(e) => return fail(observer, op, "plan", &e.to_string()),
        };
        // 模板求值为空（如缺 ctx 派生值）：按空结果返回，不算成功，不记错误
        if step.get("abort").and_then(Value::as_bool).unwrap_or(false) {
            return (empty_for(op), false);
        }
        if step.get("done").and_then(Value::as_bool).unwrap_or(false) {
            break;
        }
        let name = step.get("name").and_then(Value::as_str).unwrap_or("");
        let url = step.get("url").and_then(Value::as_str).unwrap_or("");
        if name.is_empty() || url.is_empty() {
            return fail(observer, op, "plan", "请求步骤缺 name 或 url");
        }
        let headers = header_pairs(step.get("headers"));
        observer.record_step(Step::Plan {
            name: name.to_string(),
            url: url.to_string(),
            headers: headers
                .iter()
                .map(|(k, v)| (k.to_string(), v.clone()))
                .collect(),
        });
        match fetch(render_channel, url, &headers) {
            Ok(body) => {
                observer.record_step(Step::Fetch {
                    name: name.to_string(),
                    url: url.to_string(),
                    body: body.clone(),
                    error: None,
                });
                responses.insert(name.to_string(), Value::String(body));
            }
            Err(e) => {
                observer.record_step(Step::Fetch {
                    name: name.to_string(),
                    url: url.to_string(),
                    body: String::new(),
                    error: Some(e.clone()),
                });
                return fail(observer, op, "fetch", &e);
            }
        }
    }

    let req = request_json(op, payload, &ctx, &responses);
    let out = match crate::js::call(script, "parse", &req) {
        Ok(o) => o,
        Err(e) => return fail(observer, op, "parse", &e),
    };
    let envelope: Value = match serde_json::from_str(&out) {
        Ok(v) => v,
        Err(e) => return fail(observer, op, "parse", &e.to_string()),
    };
    let data = envelope.get("data").cloned().unwrap_or_else(|| json!([]));
    let hidden = envelope.get("hidden").cloned().unwrap_or_else(|| json!([]));
    store_hidden(observer, envelope.get("hidden"));
    observer.record_step(Step::Parse { data: data.clone(), hidden });
    observer.clear_error();
    (data.to_string(), true)
}

/// 协议级的缓存管理 op：隐藏值缓存在宿主侧，文档不参与。
pub fn cache_op(entry: &Entry, op: &str, payload: &str) -> String {
    match op {
        "cache_dump" => entry.dump_hidden().to_string(),
        "cache_hydrate" => {
            let value: Value = serde_json::from_str(payload).unwrap_or(Value::Null);
            entry.hydrate_hidden(&value);
            "true".into()
        }
        _ => "{}".into(),
    }
}

/// 该 op 是否由文档描述（缓存管理 op 与未知 op 不经运行时）。
pub fn is_document_op(op: &str) -> bool {
    OPS.contains(&op)
}

fn fail(observer: &dyn RunObserver, op: &str, stage: &str, message: &str) -> (String, bool) {
    observer.record_error(stage, message);
    (empty_for(op), false)
}

/// 失败时的空结果：detail 是对象，其余 op 是列表。
fn empty_for(op: &str) -> String {
    if op == "detail" {
        "{}".into()
    } else {
        "[]".into()
    }
}

fn request_json(op: &str, payload: &str, ctx: &Value, responses: &Map<String, Value>) -> String {
    let payload: Value = serde_json::from_str(payload).unwrap_or(Value::Null);
    json!({
        "op": op,
        "payload": payload,
        "ctx": ctx,
        "responses": Value::Object(responses.clone()),
    })
    .to_string()
}

/// 运行时给回的请求头（`{名: 值}`）转成抓取层要的键值对。
fn header_pairs(headers: Option<&Value>) -> Vec<(&str, String)> {
    let Some(obj) = headers.and_then(Value::as_object) else {
        return Vec::new();
    };
    obj.iter()
        .filter_map(|(k, v)| v.as_str().map(|s| (k.as_str(), s.to_string())))
        .collect()
}

/// 抓取原始响应体：声明了渲染通道的源整源经隐藏 webview 取页面。
fn fetch(render_channel: bool, url: &str, headers: &[(&str, String)]) -> Result<String, String> {
    if render_channel {
        return render::fetch(url);
    }
    let borrowed: Vec<(&str, &str)> = headers.iter().map(|(k, v)| (*k, v.as_str())).collect();
    http::get_text(url, &borrowed)
}

/// 把运行时交出来的隐藏值写进缓存（供后续 op 经 ctx 取用）。
fn store_hidden(observer: &dyn RunObserver, hidden: Option<&Value>) {
    let Some(items) = hidden.and_then(Value::as_array) else {
        return;
    };
    for item in items {
        let name = item.get("name").and_then(Value::as_str).unwrap_or("");
        let key = item.get("key").and_then(Value::as_str).unwrap_or("");
        let value = item.get("value").and_then(Value::as_str).unwrap_or("");
        if !name.is_empty() && !key.is_empty() && !value.is_empty() {
            observer.put_hidden(name, key, value);
        }
    }
}

/// 文档格式版本（命令层展示与测试用）。
pub fn schema_version() -> u32 {
    SCHEMA_VERSION
}

/// 本地 mock HTTP 服务：对每个请求返回 `body(端口)` 给出的 HTML，监听一个空闲端口（测试用）。
/// 响应体按端口拼（页面里的链接指向 mock 自己，供多步请求链使用）。
#[cfg(test)]
pub(crate) fn spawn_mock(body: impl Fn(u16) -> String) -> u16 {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let body = body(port);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let mut buf = [0u8; 8192];
            let _ = stream.read(&mut buf).unwrap_or(0);
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(resp.as_bytes());
            let _ = stream.flush();
        }
    });
    port
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crawler::registry::{sync, SyncPayload, SyncSource};

    const DOC: &str = r#"{
        "schema": 1, "id": "demo", "title": "演示", "idPrefix": "demo-",
        "base": "https://example.com",
        "categories": [{ "label": "悬疑", "url": "https://example.com/s" }],
        "ops": {
            "search": {
                "request": [{ "name": "list", "url": "{base}/search?q={keyword}" }],
                "items": "div.item",
                "id": { "attr": "data-id" },
                "fields": { "title": "h3" },
                "hidden": { "seriesUrl": { "attr": "data-href" } }
            },
            "images": {
                "request": [{ "name": "page", "url": "{seriesUrl}" }],
                "items": "img.p",
                "url": { "attr": "src" }
            }
        }
    }"#;

    const LIST_HTML: &str = r#"
        <div class="item" data-id="1" data-href="https://example.com/1"><h3>甲</h3></div>
    "#;

    fn entry() -> std::sync::Arc<Entry> {
        sync(SyncPayload {
            runtime: None,
            sources: vec![SyncSource {
                id: "demo".to_string(),
                document: DOC.to_string(),
            }],
        });
        registry::get("demo").expect("应已注册")
    }

    /// 用本地 mock HTTP 服务跑一次 search：验证 URL、抓取、解析与隐藏值入缓存。
    #[test]
    fn search_runs_end_to_end_against_a_local_server() {
        let _guard = registry::test_lock();
        let port = spawn_mock(|_| LIST_HTML.to_string());
        let doc = DOC.replace("https://example.com", &format!("http://127.0.0.1:{port}"));
        sync(SyncPayload {
            runtime: None,
            sources: vec![SyncSource {
                id: "demo".to_string(),
                document: doc,
            }],
        });
        let entry = registry::get("demo").unwrap();
        let (out, ok) = run(&entry, "search", r#"{"keyword":"x"}"#);
        assert!(ok, "out = {out}");
        let comics: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(comics[0]["id"], "demo-1");
        assert_eq!(comics[0]["title"], "甲");
        assert!(comics[0].get("seriesUrl").is_none(), "隐藏值不进前端数据");
        // 隐藏值进了缓存：images 的 {seriesUrl} 现在能解析（值来自响应里的 data-href）
        assert_eq!(entry.hidden_ctx()["seriesUrl"]["demo-1"], "https://example.com/1");
    }

    #[test]
    fn missing_ctx_value_aborts_with_an_empty_result() {
        let _guard = registry::test_lock();
        let entry = entry();
        // images 的 URL 是 {seriesUrl}，这个漫画在缓存里没有值 → 模板为空 → 空结果、
        // 不算成功、不记错误（对比 fetch 失败：那是错误）
        let (out, ok) = run(&entry, "images", r#"{"comicId":"demo-999","chapterIndex":1}"#);
        assert_eq!(out, "[]");
        assert!(!ok);
        assert!(
            entry.error().is_none(),
            "空模板不是错误，得到 {:?}",
            entry.error()
        );
    }

    #[test]
    fn categories_comes_from_the_document() {
        let _guard = registry::test_lock();
        let entry = entry();
        let (out, ok) = run(&entry, "categories", "{}");
        assert!(ok);
        assert_eq!(out, r#"["悬疑"]"#);
    }

    #[test]
    fn cache_ops_round_trip_the_hidden_store() {
        let _guard = registry::test_lock();
        let entry = entry();
        entry.put_hidden("seriesUrl", "demo-1", "https://example.com/1");
        let dump = cache_op(&entry, "cache_dump", "{}");
        entry.clear_hidden();
        assert_eq!(entry.hidden_ctx(), json!({}));
        assert_eq!(cache_op(&entry, "cache_hydrate", &dump), "true");
        assert_eq!(entry.hidden_ctx()["seriesUrl"]["demo-1"], "https://example.com/1");
    }

    #[test]
    fn unknown_op_is_not_a_document_op() {
        assert!(is_document_op("search"));
        assert!(!is_document_op("bogus"));
        assert!(!is_document_op("cache_dump"));
        assert_eq!(schema_version(), 1);
    }

    /// 一个测试用的观察者：把步骤按顺序收集，隐藏值与错误各自记下。
    #[derive(Default)]
    struct Recorder {
        steps: std::sync::Mutex<Vec<Step>>,
        errors: std::sync::Mutex<Vec<(String, String)>>,
        hidden: std::sync::Mutex<std::collections::BTreeMap<String, std::collections::BTreeMap<String, String>>>,
    }

    impl RunObserver for Recorder {
        fn hidden_ctx(&self) -> Value {
            let store = self.hidden.lock().unwrap();
            let mut out = Map::new();
            for (name, by_key) in store.iter() {
                let mut keys = Map::new();
                for (key, value) in by_key.iter() {
                    keys.insert(key.clone(), Value::String(value.clone()));
                }
                out.insert(name.clone(), Value::Object(keys));
            }
            Value::Object(out)
        }

        fn put_hidden(&self, name: &str, key: &str, value: &str) {
            self.hidden
                .lock()
                .unwrap()
                .entry(name.to_string())
                .or_default()
                .insert(key.to_string(), value.to_string());
        }

        fn record_error(&self, stage: &str, message: &str) {
            self.errors
                .lock()
                .unwrap()
                .push((stage.to_string(), message.to_string()));
        }

        fn clear_error(&self) {
            self.errors.lock().unwrap().clear();
        }

        fn record_step(&self, step: Step) {
            self.steps.lock().unwrap().push(step);
        }
    }

    /// 用一个测试用的观察者驱动一次真实运行：步骤按 plan → fetch → parse 的顺序被收集。
    #[test]
    fn execute_collects_steps_in_order() {
        let _guard = registry::test_lock();
        let port = spawn_mock(|_| LIST_HTML.to_string());
        let doc = DOC.replace("https://example.com", &format!("http://127.0.0.1:{port}"));
        let script = format!("var DOC = {};\n{}", doc, crate::js::runtime::source());
        let recorder = Recorder::default();

        let (out, ok) = execute(&recorder, &script, false, "search", r#"{"keyword":"x"}"#);
        assert!(ok, "out = {out}");

        let steps = recorder.steps.lock().unwrap();
        let stages: Vec<&str> = steps.iter().map(Step::stage).collect();
        assert_eq!(stages, vec!["plan", "fetch", "parse"], "步骤应按顺序收集");

        match &steps[0] {
            Step::Plan { name, url, .. } => {
                assert_eq!(name, "list");
                assert!(url.contains("/search?q=x"), "url = {url}");
            }
            other => panic!("第一步应为 plan，得到 {other:?}"),
        }
        match &steps[1] {
            Step::Fetch { name, body, .. } => {
                assert_eq!(name, "list");
                assert!(body.contains(r#"div class="item""#), "body = {body}");
            }
            other => panic!("第二步应为 fetch，得到 {other:?}"),
        }
        match &steps[2] {
            Step::Parse { data, hidden } => {
                assert_eq!(data[0]["id"], "demo-1");
                assert_eq!(hidden[0]["name"], "seriesUrl");
            }
            other => panic!("第三步应为 parse，得到 {other:?}"),
        }
        drop(steps);

        // 隐藏值经观察者写入（值来自响应里的 data-href）
        assert_eq!(
            recorder.hidden_ctx()["seriesUrl"]["demo-1"],
            "https://example.com/1"
        );
        assert!(
            recorder.errors.lock().unwrap().is_empty(),
            "成功运行不应上报错误"
        );
    }

    #[test]
    fn fetch_failure_is_recorded_on_the_source() {
        let _guard = registry::test_lock();
        let doc = DOC.replace("https://example.com", "http://127.0.0.1:1");
        sync(SyncPayload {
            runtime: None,
            sources: vec![SyncSource {
                id: "demo".to_string(),
                document: doc,
            }],
        });
        let entry = registry::get("demo").unwrap();
        let (out, ok) = run(&entry, "search", r#"{"keyword":"x"}"#);
        assert_eq!(out, "[]");
        assert!(!ok);
        let (msg, _) = entry.error().expect("应记录错误");
        assert!(msg.starts_with("fetch(search)"), "msg = {msg}");
    }
}
