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

/// 跑一个 op。第二个返回值 = 本次是否成功（供结果缓存判定，见 `crawler::crawl`）。
/// 失败按协议返回空 JSON 并把原因记进该源的错误行。
pub fn run(entry: &Entry, op: &str, payload: &str) -> (String, bool) {
    let script = registry::script_for(entry);
    let ctx = ctx_for(entry);
    let mut responses = Map::new();

    for _ in 0..MAX_STEPS {
        let req = request_json(op, payload, &ctx, &responses);
        let step = match crate::js::call(&script, "plan", &req) {
            Ok(s) => s,
            Err(e) => return fail(entry, op, "plan", &e),
        };
        let step: Value = match serde_json::from_str(&step) {
            Ok(v) => v,
            Err(e) => return fail(entry, op, "plan", &e.to_string()),
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
            return fail(entry, op, "plan", "请求步骤缺 name 或 url");
        }
        let headers = header_pairs(step.get("headers"));
        match fetch(entry, url, &headers) {
            Ok(body) => {
                responses.insert(name.to_string(), Value::String(body));
            }
            Err(e) => return fail(entry, op, "fetch", &e),
        }
    }

    let req = request_json(op, payload, &ctx, &responses);
    let out = match crate::js::call(&script, "parse", &req) {
        Ok(o) => o,
        Err(e) => return fail(entry, op, "parse", &e),
    };
    let envelope: Value = match serde_json::from_str(&out) {
        Ok(v) => v,
        Err(e) => return fail(entry, op, "parse", &e.to_string()),
    };
    store_hidden(entry, envelope.get("hidden"));
    entry.clear();
    let data = envelope.get("data").cloned().unwrap_or_else(|| json!([]));
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

fn fail(entry: &Entry, op: &str, stage: &str, message: &str) -> (String, bool) {
    entry.record(&format!("{stage}({op}): {message}"));
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

/// 交给运行时的 ctx：目前只有宿主侧的隐藏值缓存（`{名: {键: 值}}`）。
fn ctx_for(entry: &Entry) -> Value {
    json!({ "hidden": entry.hidden_ctx() })
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
fn fetch(entry: &Entry, url: &str, headers: &[(&str, String)]) -> Result<String, String> {
    if entry.doc.render_channel {
        return render::fetch(url);
    }
    let borrowed: Vec<(&str, &str)> = headers.iter().map(|(k, v)| (*k, v.as_str())).collect();
    http::get_text(url, &borrowed)
}

/// 把运行时交出来的隐藏值写进该源的缓存（供后续 op 经 ctx 取用）。
fn store_hidden(entry: &Entry, hidden: Option<&Value>) {
    let Some(items) = hidden.and_then(Value::as_array) else {
        return;
    };
    for item in items {
        let name = item.get("name").and_then(Value::as_str).unwrap_or("");
        let key = item.get("key").and_then(Value::as_str).unwrap_or("");
        let value = item.get("value").and_then(Value::as_str).unwrap_or("");
        if !name.is_empty() && !key.is_empty() && !value.is_empty() {
            entry.put_hidden(name, key, value);
        }
    }
}

/// 文档格式版本（命令层展示与测试用）。
pub fn schema_version() -> u32 {
    SCHEMA_VERSION
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
    fn spawn_mock(body: &'static str) -> u16 {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
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

    #[test]
    fn search_runs_end_to_end_against_a_local_server() {
        let _guard = registry::test_lock();
        let port = spawn_mock(LIST_HTML);
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
