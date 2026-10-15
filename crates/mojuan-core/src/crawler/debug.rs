//! 源调试台的一次运行：给一份文档原文、op、payload 与会话隐藏值快照，跑一次真实取数，
//! 返回这次运行走过的每一步。
//!
//! 与已装源那条路径（[`script::run`]）共用同一个执行循环（[`script::execute`]），只是观察者
//! 换成 [`DebugObserver`]：步骤收进返回值，隐藏值只在本次运行的快照里累积。所以调试台看到的
//! 步骤与线上真实走的路是同一份代码，不会各自演化。
//!
//! 与已装源完全隔离：不写结果缓存，不碰注册表里任何已装源的错误行与隐藏值。文档校验失败时
//! 只记一步 `validate` 并就地返回，不发起任何请求。

use crate::crawler::doc::SourceDoc;
use crate::crawler::script::{self, RunObserver, Step};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::sync::Mutex;

/// 单个响应体回传给调试台的上限；超出即截断并置 `truncated`。
const MAX_BODY_BYTES: usize = 512 * 1024;

/// 跑一次调试取数，返回运行记录 JSON：
/// `{ok, data, hidden, steps, error}`（见模块说明）。
pub fn run(document: &str, op: &str, payload: &str, hidden: &str) -> String {
    let store = hidden_store(hidden);
    let doc = match SourceDoc::parse(document) {
        Ok(doc) => doc,
        Err(reason) => {
            let message = failure_message("validate", op, &reason);
            let steps = vec![json!({
                "stage": "validate",
                "ok": false,
                "error": message,
            })];
            // 文档没通过校验，会话里已有的隐藏值原样交回（改错一个键名不该清掉会话）
            return record(
                false,
                Value::Null,
                hidden_ctx(&store),
                steps,
                Some(("validate", message)),
            );
        }
    };

    let observer = DebugObserver::new(op, store);
    let script = format!("var DOC = {document};\n{}", crate::js::runtime::source());
    let (out, ok) = script::execute(&observer, &script, doc.render_channel, op, payload);

    let data = if ok {
        // execute 成功时 out 是 parse 输出的序列化，必然是合法 JSON；序列化失败会破坏这个不变量
        serde_json::from_str(&out).expect("script::execute 成功时返回的是 parse 输出的序列化")
    } else {
        Value::Null
    };
    let mut steps = vec![json!({ "stage": "validate", "ok": true })];
    steps.append(&mut observer.steps.lock().unwrap());
    let error = observer.error.lock().unwrap().clone();
    record(
        ok,
        data,
        observer.hidden_ctx(),
        steps,
        error.as_ref().map(|(s, m)| (s.as_str(), m.clone())),
    )
}

/// 拼出最终记录。`error` 是 `(阶段名, 带阶段名的原因)`。
fn record(
    ok: bool,
    data: Value,
    hidden: Value,
    steps: Vec<Value>,
    error: Option<(&str, String)>,
) -> String {
    json!({
        "ok": ok,
        "data": data,
        "hidden": hidden,
        "steps": steps,
        "error": match error {
            Some((stage, message)) => json!({ "stage": stage, "message": message }),
            None => Value::Null,
        },
    })
    .to_string()
}

/// 失败原因的统一写法（与已装源错误行一致）：`阶段(op): 原因`。
fn failure_message(stage: &str, op: &str, reason: &str) -> String {
    format!("{stage}({op}): {reason}")
}

/// 隐藏值存储：名 → 键 → 值（与已装源的缓存同形）。
type HiddenStore = BTreeMap<String, BTreeMap<String, String>>;

/// 解析前端交回的会话隐藏值快照；不成形的部分按无值处理（与 `cache_hydrate` 一致）。
fn hidden_store(snapshot: &str) -> HiddenStore {
    let mut store = HiddenStore::new();
    let parsed: Value = serde_json::from_str(snapshot).unwrap_or(Value::Null);
    let Some(names) = parsed.as_object() else {
        return store;
    };
    for (name, by_key) in names {
        let Some(keys) = by_key.as_object() else {
            continue;
        };
        let slot = store.entry(name.clone()).or_default();
        for (key, value) in keys {
            if let Some(s) = value.as_str() {
                slot.insert(key.clone(), s.to_string());
            }
        }
    }
    store
}

/// 存储转成交给运行时的 `ctx.hidden` 形状。
fn hidden_ctx(store: &HiddenStore) -> Value {
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

/// 调试运行的观察者：步骤按顺序收集，隐藏值只在本次运行的快照里累积，错误记在返回值里。
struct DebugObserver {
    op: String,
    hidden: Mutex<HiddenStore>,
    steps: Mutex<Vec<Value>>,
    error: Mutex<Option<(String, String)>>,
}

impl DebugObserver {
    fn new(op: &str, hidden: HiddenStore) -> Self {
        Self {
            op: op.to_string(),
            hidden: Mutex::new(hidden),
            steps: Mutex::new(Vec::new()),
            error: Mutex::new(None),
        }
    }
}

impl RunObserver for DebugObserver {
    fn hidden_ctx(&self) -> Value {
        hidden_ctx(&self.hidden.lock().unwrap())
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
        let message = failure_message(stage, &self.op, message);
        *self.error.lock().unwrap() = Some((stage.to_string(), message));
    }

    fn clear_error(&self) {
        *self.error.lock().unwrap() = None;
    }

    fn record_step(&self, step: Step) {
        self.steps.lock().unwrap().push(step_json(&self.op, step));
    }
}

/// 一步的 JSON 形状。`validate` 那一步由 [`run`] 直接给出。
fn step_json(op: &str, step: Step) -> Value {
    match step {
        Step::Plan { name, url, headers } => {
            let mut out = Map::new();
            for (k, v) in headers {
                out.insert(k, Value::String(v));
            }
            json!({
                "stage": "plan",
                "name": name,
                "url": url,
                "headers": Value::Object(out),
            })
        }
        Step::Fetch {
            name,
            url,
            body,
            error,
        } => {
            let mut out = Map::new();
            out.insert("stage".into(), json!("fetch"));
            out.insert("name".into(), json!(name));
            out.insert("url".into(), json!(url));
            match error {
                Some(reason) => {
                    out.insert("error".into(), json!(failure_message("fetch", op, &reason)));
                }
                None => {
                    let (body, truncated) = truncate(&body);
                    out.insert("body".into(), json!(body));
                    out.insert("truncated".into(), json!(truncated));
                }
            }
            Value::Object(out)
        }
        Step::Parse { data, hidden } => {
            json!({ "stage": "parse", "data": data, "hidden": hidden })
        }
    }
}

/// 截断响应体到上限：按 UTF-8 字符边界切，不切开字符。
fn truncate(body: &str) -> (String, bool) {
    if body.len() <= MAX_BODY_BYTES {
        return (body.to_string(), false);
    }
    let mut end = MAX_BODY_BYTES;
    while !body.is_char_boundary(end) {
        end -= 1;
    }
    (body[..end].to_string(), true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crawl_debug;
    use crate::crawler::registry::{self, sync, SyncPayload, SyncSource};
    use crate::crawler::{result_cache, script};

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

    /// 列表页响应体：`data-href` 指向 mock 自己（隐藏值会在下一次运行里被请求）。
    fn list_html(port: u16) -> String {
        format!(
            r#"<div class="item" data-id="1" data-href="http://127.0.0.1:{port}/1"><h3>甲</h3></div>"#
        )
    }

    /// 列表页与图片页共用的响应体：两次运行各取自己需要的部分。
    fn chain_html(port: u16) -> String {
        format!(
            r#"{}<img class="p" src="http://127.0.0.1:{port}/1/0.jpg">"#,
            list_html(port)
        )
    }

    fn doc_at(port: u16) -> String {
        DOC.replace("https://example.com", &format!("http://127.0.0.1:{port}"))
    }

    fn record(out: &str) -> Value {
        serde_json::from_str(out).expect("运行记录应是合法 JSON")
    }

    fn stages(rec: &Value) -> Vec<&str> {
        rec["steps"]
            .as_array()
            .expect("steps 应是数组")
            .iter()
            .map(|s| s["stage"].as_str().expect("每步都有阶段名"))
            .collect()
    }

    #[test]
    fn a_search_run_records_validate_plan_fetch_parse() {
        let port = script::spawn_mock(list_html);
        let out = crawl_debug(&doc_at(port), "search", r#"{"keyword":"x"}"#, "{}");
        let rec = record(&out);

        assert_eq!(rec["ok"], true, "{out}");
        assert_eq!(
            stages(&rec),
            vec!["validate", "plan", "fetch", "parse"],
            "{out}"
        );
        assert_eq!(rec["steps"][0]["ok"], true, "{out}");

        let plan = &rec["steps"][1];
        assert_eq!(plan["name"], "list");
        assert!(
            plan["url"].as_str().unwrap().contains("/search?q=x"),
            "{out}"
        );

        let fetch = &rec["steps"][2];
        assert_eq!(fetch["name"], "list");
        assert_eq!(fetch["truncated"], false);
        assert!(
            fetch["body"]
                .as_str()
                .unwrap()
                .contains(r#"div class="item""#),
            "{out}"
        );

        let parse = &rec["steps"][3];
        assert_eq!(parse["data"][0]["id"], "demo-1");
        assert_eq!(parse["hidden"][0]["name"], "seriesUrl");

        assert_eq!(rec["data"][0]["title"], "甲");
        assert_eq!(
            rec["hidden"]["seriesUrl"]["demo-1"],
            format!("http://127.0.0.1:{port}/1")
        );
        assert_eq!(rec["error"], Value::Null);
    }

    #[test]
    fn an_invalid_document_stops_at_validate_without_any_request() {
        // base 指向连不上的端口：真发了请求就会在 fetch 步失败
        let doc = doc_at(1).replace(r#""items": "div.item","#, r#""itemsx": "div.item","#);
        let session = r#"{"seriesUrl":{"demo-1":"http://127.0.0.1:1/1"}}"#;
        let out = crawl_debug(&doc, "search", "{}", session);
        let rec = record(&out);

        assert_eq!(rec["ok"], false);
        assert_eq!(stages(&rec), vec!["validate"], "{out}");
        assert_eq!(rec["steps"][0]["ok"], false);
        assert_eq!(rec["error"]["stage"], "validate");
        assert!(
            rec["error"]["message"]
                .as_str()
                .unwrap()
                .starts_with("validate(search):"),
            "{out}"
        );
        // 会话里已有的隐藏值原样交回：改错一个键名不该清掉会话
        assert_eq!(
            rec["hidden"]["seriesUrl"]["demo-1"], "http://127.0.0.1:1/1",
            "{out}"
        );
    }

    #[test]
    fn a_failed_request_is_reported_on_the_fetch_step() {
        let out = crawl_debug(&doc_at(1), "search", r#"{"keyword":"x"}"#, "{}");
        let rec = record(&out);

        assert_eq!(rec["ok"], false);
        assert_eq!(stages(&rec), vec!["validate", "plan", "fetch"], "{out}");
        let message = rec["steps"][2]["error"]
            .as_str()
            .expect("fetch 步带失败原因");
        assert!(message.starts_with("fetch(search):"), "message = {message}");
        assert_eq!(rec["error"]["stage"], "fetch");
        assert_eq!(rec["error"]["message"], message);
    }

    #[test]
    fn an_oversized_response_body_is_truncated() {
        let big = "x".repeat(MAX_BODY_BYTES + 1024);
        let port = script::spawn_mock(move |_| big.clone());
        let out = crawl_debug(&doc_at(port), "search", r#"{"keyword":"x"}"#, "{}");
        let rec = record(&out);

        let fetch = &rec["steps"][2];
        assert_eq!(fetch["truncated"], true, "超限应置 truncated");
        assert_eq!(fetch["body"].as_str().unwrap().len(), MAX_BODY_BYTES);
    }

    #[test]
    fn a_debug_run_leaves_installed_sources_and_the_result_cache_alone() {
        let _guard = registry::test_lock();
        let port = script::spawn_mock(list_html);
        let doc = doc_at(port);
        sync(SyncPayload {
            runtime: None,
            sources: vec![SyncSource {
                id: "demo".to_string(),
                document: doc.clone(),
            }],
        });
        let entry = registry::get("demo").expect("应已注册");
        entry.record("fetch(search): 旧错误");
        entry.put_hidden("seriesUrl", "demo-1", "https://installed.example/1");

        let out = crawl_debug(&doc, "search", r#"{"keyword":"x"}"#, "{}");
        assert_eq!(record(&out)["ok"], true, "{out}");

        assert_eq!(
            entry.error().expect("错误行应原样保留").0,
            "fetch(search): 旧错误",
            "调试运行不该改已装源的错误行"
        );
        assert_eq!(
            entry.hidden_ctx()["seriesUrl"]["demo-1"],
            "https://installed.example/1",
            "调试运行不该改已装源的隐藏值"
        );

        let dir = std::env::temp_dir().join(format!("mojuan-debug-cache-{port}"));
        std::fs::create_dir_all(&dir).unwrap();
        let dir = dir.to_string_lossy().to_string();
        assert!(
            result_cache::get(&dir, "demo", "search", r#"{"keyword":"x"}"#, &doc).is_none(),
            "调试运行不写结果缓存"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn hidden_values_from_one_run_feed_the_next() {
        let port = script::spawn_mock(chain_html);
        let doc = doc_at(port);

        let first = record(&crawl_debug(&doc, "search", r#"{"keyword":"x"}"#, "{}"));
        assert_eq!(first["ok"], true, "{first}");
        assert_eq!(first["data"][0]["id"], "demo-1", "{first}");
        let hidden = first["hidden"].clone();
        assert_eq!(
            hidden["seriesUrl"]["demo-1"],
            format!("http://127.0.0.1:{port}/1"),
            "{first}"
        );

        let second = record(&crawl_debug(
            &doc,
            "images",
            r#"{"comicId":"demo-1","chapterIndex":1}"#,
            &hidden.to_string(),
        ));
        assert_eq!(second["ok"], true, "{second}");
        assert_eq!(
            second["data"][0],
            format!("http://127.0.0.1:{port}/1/0.jpg"),
            "{second}"
        );
    }
}
