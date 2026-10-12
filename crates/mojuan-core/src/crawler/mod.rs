//! 爬虫引擎统一入口：按 sourceId 查已装源，跑它的源文档（[ADR-0002](../../../../docs/adr/0002-source-definition-as-document.md)）。
//!
//! 协议（与前端 `crawl` 命令一致，不变）：
//! - `op`：categories | search | category | detail | images | cache_dump | cache_hydrate
//! - `payload`：JSON 对象（serde_json::Value），各 op 读取自己的字段
//! - 返回值：JSON 字符串（列表 / 对象 / 数组），失败返回空 JSON（`[]` / `{}`）
//!
//! 一个源的全部知识在它的**源文档**里（`crawler/doc.rs` 定义格式），由**源运行时**
//! （`js/runtime.rs`）解释；已装源与宿主侧状态（最近错误、隐藏值缓存）在 `crawler/registry.rs`。
//! 本模块只做分派：缓存管理 op 由宿主持有，其余 op 交 `script::run`。
//!
//! 结果缓存（`result_cache`）：列表/详情类 op 的成功结果写入内存 LRU + 磁盘
//! （cache_dir 为空表示禁用），供 `cached_result` 读取（前端 stale-while-revalidate 的
//! stale 一侧）；失败结果不写入。缓存键含源文档与运行时版本标识，任一变化即自然失效。

pub mod doc;
pub mod http;
pub mod models;
pub mod registry;
pub mod render;
pub mod result_cache;
pub mod script;

use serde_json::Value;

/// 分发并返回 JSON 字符串。未知 source/op 按列表类返回 `[]`。
/// `cache_dir`：结果缓存目录（空串禁用）；成功结果在此留一份供 `cached_result` 读取。
pub fn crawl(op: &str, source: &str, payload: &str, cache_dir: &str) -> String {
    let Some(entry) = registry::get(source) else {
        return "[]".into();
    };
    let (out, ok) = dispatch(&entry, op, payload);
    if ok {
        result_cache::put(cache_dir, source, op, payload, &entry.json, &out);
    }
    out
}

/// 读取缓存的抓取结果（不触发网络）。命中返回 `{"data": <结果>, "fetchedAt": <unix_ms>}`，
/// 未命中返回 `null`。命中视为该源有可用数据，清掉陈旧的错误行（与 crawl 的成功上报一致）。
pub fn cached_result(op: &str, source: &str, payload: &str, cache_dir: &str) -> String {
    let Some(entry) = registry::get(source) else {
        return "null".into();
    };
    let Some((data, at)) = result_cache::get(cache_dir, source, op, payload, &entry.json) else {
        return "null".into();
    };
    let Ok(value) = serde_json::from_str::<Value>(&data) else {
        return "null".into();
    };
    entry.clear();
    serde_json::json!({ "data": value, "fetchedAt": at }).to_string()
}

/// 分派：缓存管理 op 由宿主处理，未知 op 按空结果返回，其余交源文档。
/// 第二个返回值表示本次结果是否成功（供结果缓存判定）。
fn dispatch(entry: &registry::Entry, op: &str, payload: &str) -> (String, bool) {
    if !script::is_document_op(op) {
        return match op {
            "cache_dump" | "cache_hydrate" => (script::cache_op(entry, op, payload), true),
            _ => ("[]".into(), false),
        };
    }
    script::run(entry, op, payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crawler::registry::{sync, SyncPayload, SyncSource};

    const DOC: &str = r#"{
        "schema": 1, "id": "demo", "title": "演示",
        "categories": [{ "label": "悬疑", "url": "https://example.com/s" }],
        "ops": {
            "search": {
                "request": [{ "name": "list", "url": "https://example.com/search?q={keyword}" }],
                "items": "div.item",
                "id": { "attr": "data-id" }
            }
        }
    }"#;

    fn with_demo() {
        sync(SyncPayload {
            runtime: None,
            sources: vec![SyncSource {
                id: "demo".to_string(),
                document: DOC.to_string(),
            }],
        });
    }

    /// 分派：缓存管理 op 对任意已装源都是空操作成功，未知 op 与未知 source 返回空结果。
    #[test]
    fn dispatch_routes_cache_ops_and_rejects_unknown() {
        let _guard = registry::test_lock();
        with_demo();
        assert_eq!(crawl("cache_dump", "demo", "{}", ""), "{}");
        assert_eq!(crawl("cache_hydrate", "demo", "{}", ""), "true");
        assert_eq!(crawl("bogus", "demo", "{}", ""), "[]");
        assert_eq!(crawl("search", "nope", "{}", ""), "[]");
    }

    /// 未装源时 cached_result 返回 null。
    #[test]
    fn cached_result_is_null_for_unknown_source() {
        let _guard = registry::test_lock();
        assert_eq!(cached_result("search", "nope", "{}", ""), "null");
    }

    /// 缓存管理 op 不进结果缓存。
    #[test]
    fn cache_ops_are_not_result_cached() {
        assert!(!result_cache::is_cacheable("cache_dump"));
        assert!(!result_cache::is_cacheable("cache_hydrate"));
        assert!(result_cache::is_cacheable("detail"));
    }

    /// 内置的 webtoons 文档在引擎里跑得通（分类表是静态的，不需要网络）。
    #[test]
    fn bundled_webtoons_answers_categories_offline() {
        let _guard = registry::test_lock();
        registry::reset_for_test();
        let out = crawl("categories", "webtoons", "{}", "");
        let cats: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(cats.as_array().unwrap().len(), 8);
        assert!(out.contains("恋爱"));
    }
}
