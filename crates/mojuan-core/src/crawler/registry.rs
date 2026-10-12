//! 已装源的运行时注册表：源文档、最近错误、跨 op 的隐藏值缓存。
//!
//! 取代旧的「一个源一个 Rust 适配器 + 静态 `SOURCES` 表」：一个源的全部知识在它的源文档里
//! （见 [`crate::crawler::doc`]），本模块只维护「当前装了哪些源」与宿主侧的状态。
//!
//! 内置源只有 webtoons 一个（格式的参考实现与首启可用的保证，见 ADR-0002）；其余源由前端从
//! 源仓库目录安装或手动导入，经 [`sync`] 同步进来。顺序即前端源清单的显示顺序（内置的排最前，
//! 其余按安装顺序）。
//!
//! 同步时逐份解析并校验文档：**坏文档不替换已装版本**，原因写进该源的错误行（前端源管理页
//! 据此呈现）。`sync` 返回被接受的源的前端事实（显示名与热链对），前端据此填源清单与图片代理。

use crate::crawler::doc::SourceDoc;
use crate::util::now_ms;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::{Arc, LazyLock, Mutex, RwLock};

/// 内置源：随 app 打包的文档（webtoons 是格式的参考实现）。
const BUNDLED: &[(&str, &str)] = &[(
    "webtoons",
    include_str!("../js/sources/webtoons.json"),
)];

/// 一个已装源的宿主侧状态。
pub struct Entry {
    pub doc: SourceDoc,
    /// 文档原文（拼进脚本交给运行时；也是结果缓存键的一部分）。
    pub json: String,
    error: Mutex<Option<(String, u64)>>,
    /// 跨 op 的隐藏值：名 → 键 → 值（webtoons 的系列 URL、baozimh 的章节中转链）。
    hidden: Mutex<BTreeMap<String, BTreeMap<String, String>>>,
}

impl Entry {
    fn new(doc: SourceDoc, json: String) -> Self {
        Self {
            doc,
            json,
            error: Mutex::new(None),
            hidden: Mutex::new(BTreeMap::new()),
        }
    }

    /// 记录该源最近一次错误（覆盖旧值）。
    pub fn record(&self, message: &str) {
        *self.error.lock().unwrap() = Some((message.to_string(), now_ms()));
    }

    /// op 成功时清除最近错误（前端错误行不显示陈旧错误）。
    pub fn clear(&self) {
        *self.error.lock().unwrap() = None;
    }

    pub fn error(&self) -> Option<(String, u64)> {
        self.error.lock().unwrap().clone()
    }

    /// 交给运行时的 `ctx.hidden`：`{名: {键: 值}}`。
    pub fn hidden_ctx(&self) -> Value {
        let store = self.hidden.lock().unwrap();
        let mut out = serde_json::Map::new();
        for (name, by_key) in store.iter() {
            let mut keys = serde_json::Map::new();
            for (key, value) in by_key.iter() {
                keys.insert(key.clone(), Value::String(value.clone()));
            }
            out.insert(name.clone(), Value::Object(keys));
        }
        Value::Object(out)
    }

    /// 写入一条隐藏值。
    pub fn put_hidden(&self, name: &str, key: &str, value: &str) {
        self.hidden
            .lock()
            .unwrap()
            .entry(name.to_string())
            .or_default()
            .insert(key.to_string(), value.to_string());
    }

    /// 清空隐藏值缓存（测试与「换源」时用）。
    pub fn clear_hidden(&self) {
        self.hidden.lock().unwrap().clear();
    }

    /// 持久化快照（`cache_dump`）。
    pub fn dump_hidden(&self) -> Value {
        self.hidden_ctx()
    }

    /// 回灌持久化快照（`cache_hydrate`）。
    pub fn hydrate_hidden(&self, value: &Value) {
        let Some(names) = value.as_object() else { return };
        let mut store = self.hidden.lock().unwrap();
        for (name, by_key) in names {
            let Some(keys) = by_key.as_object() else { continue };
            let slot = store.entry(name.clone()).or_default();
            for (key, v) in keys {
                if let Some(s) = v.as_str() {
                    slot.insert(key.clone(), s.to_string());
                }
            }
        }
    }
}

/// 同步进来的源（前端 sources.json 的形状）。
#[derive(Deserialize)]
pub struct SyncSource {
    pub id: String,
    /// 文档原文。旧模型留下的安装记录没有这个字段，缺省成空串后按「该源的文档为空」拒绝，
    /// 不让一条坏记录把整次同步的载荷判为非法。
    #[serde(default)]
    pub document: String,
}

/// 一次同步的输入：运行时源码（缺省用内置）+ 有序的源列表。
#[derive(Deserialize, Default)]
pub struct SyncPayload {
    #[serde(default)]
    pub runtime: Option<String>,
    #[serde(default)]
    pub sources: Vec<SyncSource>,
}

/// 一次同步的结果：被接受的源的前端事实，与被拒绝的原因。
pub struct SyncOutcome {
    pub accepted: Vec<Value>,
    pub rejected: Vec<(String, String)>,
}

static SOURCES: LazyLock<RwLock<Vec<Arc<Entry>>>> = LazyLock::new(|| {
    RwLock::new(
        BUNDLED
            .iter()
            .filter_map(|(_id, json)| {
                SourceDoc::parse(json)
                    .ok()
                    .map(|doc| Arc::new(Entry::new(doc, json.to_string())))
            })
            .collect(),
    )
});

/// 同步源列表：逐份解析文档，坏的跳过并保留旧版本。顺序按传入顺序（内置源恒在最前）。
pub fn sync(payload: SyncPayload) -> SyncOutcome {
    crate::js::runtime::set(payload.runtime);
    let previous: BTreeMap<String, Arc<Entry>> = SOURCES
        .read()
        .unwrap()
        .iter()
        .map(|e| (e.doc.id.clone(), e.clone()))
        .collect();

    let mut next: Vec<Arc<Entry>> = Vec::new();
    let mut accepted: Vec<Value> = Vec::new();
    let mut rejected: Vec<(String, String)> = Vec::new();

    // 内置源恒在最前：它的文档被同名条目覆盖时也保持这个位置。
    for (id, json) in BUNDLED {
        match SourceDoc::parse(json) {
            Ok(doc) => next.push(Arc::new(Entry::new(doc, json.to_string()))),
            Err(e) => rejected.push((id.to_string(), e)),
        }
    }
    for src in payload.sources {
        // 空文档（旧模型的安装记录、或手写漏了内容）按该源自己的失败处理：它只影响这个源，
        // 与「文档解析失败」走同一条路——内置源保留内置版本，已装源保留旧版本。
        let parsed = if src.document.trim().is_empty() {
            Err("源文档为空".to_string())
        } else {
            SourceDoc::parse(&src.document)
        };
        if BUNDLED.iter().any(|(id, _)| *id == src.id) {
            // 内置源被索引里的更新覆盖：换掉内容，位置不变
            match parsed {
                Ok(doc) => {
                    if let Some(pos) = next.iter().position(|e| e.doc.id == src.id) {
                        let entry = Arc::new(Entry::new(doc, src.document));
                        carry_state(previous.get(&src.id), &entry);
                        next[pos] = entry;
                    }
                }
                Err(e) => rejected.push((src.id, e)),
            }
            continue;
        }
        match parsed {
            Ok(doc) => {
                let entry = Arc::new(Entry::new(doc, src.document));
                carry_state(previous.get(&src.id), &entry);
                next.push(entry);
            }
            Err(e) => {
                // 坏文档：保留旧版本（已装过的仍可用），把原因记在它的错误行上
                match previous.get(&src.id) {
                    Some(old) => {
                        old.record(&format!("文档校验失败: {e}"));
                        rejected.push((src.id.clone(), e));
                        next.push(old.clone());
                    }
                    None => rejected.push((src.id, e)),
                }
            }
        }
    }

    for entry in &next {
        accepted.push(json!({
            "id": entry.doc.id,
            "title": entry.doc.title,
            "hotlinkReferers": entry.doc.hotlink_referers.iter().map(|h| json!({
                "domain": h.domain,
                "referer": h.referer,
            })).collect::<Vec<_>>(),
        }));
    }
    *SOURCES.write().unwrap() = next;
    SyncOutcome { accepted, rejected }
}

/// 换版本时把隐藏值缓存带过去：它按名字与键存，与文档版本无关（webtoons 的系列 URL
/// 在文档更新后仍然有效）。错误行不带：新版本从干净状态开始，旧版本的失败原因不再适用。
fn carry_state(previous: Option<&Arc<Entry>>, next: &Arc<Entry>) {
    let Some(old) = previous else { return };
    *next.hidden.lock().unwrap() = old.hidden.lock().unwrap().clone();
}

/// 按 sourceId 查已装源。
pub fn get(source: &str) -> Option<Arc<Entry>> {
    SOURCES
        .read()
        .unwrap()
        .iter()
        .find(|e| e.doc.id == source)
        .cloned()
}

/// 全部已装源（顺序即前端源清单的显示顺序）。
pub fn list() -> Vec<Arc<Entry>> {
    SOURCES.read().unwrap().clone()
}

/// op 成功时清除某源最近错误（未知 source 忽略）。
pub fn clear_error(source: &str) {
    if let Some(e) = get(source) {
        e.clear();
    }
}

/// 读取某源最近错误（不清空）。
pub fn last_error(source: &str) -> Option<(String, u64)> {
    get(source)?.error()
}

/// 全部源的最近错误（命令层展示用）。
pub fn all_errors() -> BTreeMap<String, (String, u64)> {
    list()
        .iter()
        .filter_map(|e| e.error().map(|err| (e.doc.id.clone(), err)))
        .collect()
}

/// 拼出交给运行时的脚本：文档作为 `DOC` 前置，运行时正文在后。
pub fn script_for(entry: &Entry) -> String {
    format!(
        "var DOC = {};\n{}",
        entry.json,
        crate::js::runtime::source()
    )
}

/// 注册表是进程级的（app 只有一个），测试并行跑会互相覆盖。碰全局状态的测试取这把锁串行化。
#[cfg(test)]
static TEST_LOCK: Mutex<()> = Mutex::new(());

#[cfg(test)]
pub fn test_lock() -> std::sync::MutexGuard<'static, ()> {
    // 一个测试 panic 不该毒死其余测试
    TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// 回到「只有内置源」的初始状态（测试用）。
#[cfg(test)]
pub fn reset_for_test() {
    sync(SyncPayload::default());
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOC: &str = r#"{
        "schema": 1, "id": "demo", "title": "演示",
        "ops": {
            "search": {
                "request": [{ "name": "list", "url": "https://example.com/s?q={keyword}" }],
                "items": "div.item",
                "id": { "attr": "data-id" }
            }
        }
    }"#;

    fn sync_payload(sources: Vec<(&str, &str)>) -> SyncPayload {
        SyncPayload {
            runtime: None,
            sources: sources
                .into_iter()
                .map(|(id, document)| SyncSource {
                    id: id.to_string(),
                    document: document.to_string(),
                })
                .collect(),
        }
    }

    fn reset() {
        sync(SyncPayload::default());
    }

    #[test]
    fn bundled_webtoons_is_always_registered() {
        let _guard = test_lock();
        reset();
        let entry = get("webtoons").expect("内置源恒在");
        assert_eq!(entry.doc.title, "Webtoons");
        assert_eq!(list()[0].doc.id, "webtoons", "内置源排最前");
    }

    #[test]
    fn imported_sources_are_appended_in_order() {
        let _guard = test_lock();
        let a = DOC.replace("\"demo\"", "\"aaa\"");
        let b = DOC.replace("\"demo\"", "\"bbb\"");
        let outcome = sync(sync_payload(vec![("aaa", &a), ("bbb", &b)]));
        assert!(outcome.rejected.is_empty(), "{:?}", outcome.rejected);
        let ids: Vec<String> = list().iter().map(|e| e.doc.id.clone()).collect();
        assert_eq!(ids, vec!["webtoons", "aaa", "bbb"]);
        assert_eq!(outcome.accepted.len(), 3);
    }

    #[test]
    fn bad_document_keeps_the_installed_version_and_records_the_reason() {
        let _guard = test_lock();
        let good = DOC.replace("\"demo\"", "\"aaa\"");
        sync(sync_payload(vec![("aaa", &good)]));
        assert!(get("aaa").is_some());

        let outcome = sync(sync_payload(vec![("aaa", "{ not json")]));
        assert_eq!(outcome.rejected.len(), 1);
        let entry = get("aaa").expect("旧版本应保留");
        assert_eq!(entry.doc.title, "演示");
        let (msg, _) = entry.error().expect("应记录失败原因");
        assert!(msg.contains("文档校验失败"), "msg = {msg}");
    }

    #[test]
    fn unknown_source_is_none() {
        let _guard = test_lock();
        reset();
        assert!(get("nope").is_none());
        clear_error("nope");
        assert!(last_error("nope").is_none());
    }

    /// 旧模型留下的安装记录没有 `document` 字段：整次同步仍要成立，只让那一条按自己的失败处理。
    #[test]
    fn a_source_without_a_document_does_not_break_the_whole_sync() {
        let _guard = test_lock();
        reset();
        let aaa = serde_json::to_string(&DOC.replace("\"demo\"", "\"aaa\"")).unwrap();
        let payload: SyncPayload = serde_json::from_str(&format!(
            r#"{{"sources":[{{"id":"stale"}},{{"id":"aaa","document":{aaa}}}]}}"#
        ))
        .expect("缺 document 的条目不该让载荷非法");
        let outcome = sync(payload);
        assert_eq!(outcome.rejected.len(), 1, "{:?}", outcome.rejected);
        assert_eq!(outcome.rejected[0].0, "stale");
        assert!(outcome.rejected[0].1.contains("为空"), "{:?}", outcome.rejected[0]);
        assert!(get("aaa").is_some(), "同一次同步里的其它源照常装载");
        assert!(get("stale").is_none());
        assert!(get("webtoons").is_some(), "内置源不受影响");
    }

    /// 已装源收到空文档：保留旧版本，把原因记在它的错误行上。
    #[test]
    fn an_empty_document_keeps_the_installed_version() {
        let _guard = test_lock();
        reset();
        let aaa = DOC.replace("\"demo\"", "\"aaa\"");
        sync(sync_payload(vec![("aaa", &aaa)]));
        let outcome = sync(sync_payload(vec![("aaa", "")]));
        assert_eq!(outcome.rejected.len(), 1);
        let entry = get("aaa").expect("旧版本应保留");
        assert_eq!(entry.doc.title, "演示");
        let (msg, _) = entry.error().expect("应记录失败原因");
        assert!(msg.contains("为空"), "msg = {msg}");
    }

    #[test]
    fn errors_are_per_source() {
        let _guard = test_lock();
        reset();
        let a = DOC.replace("\"demo\"", "\"aaa\"");
        sync(sync_payload(vec![("aaa", &a)]));
        let aaa = get("aaa").unwrap();
        let webtoons = get("webtoons").unwrap();
        aaa.record("parse(search): boom");
        assert!(last_error("aaa").is_some());
        assert!(last_error("webtoons").is_none());
        aaa.clear();
        assert!(last_error("aaa").is_none());
        assert!(all_errors().is_empty());
        webtoons.record("x");
        assert_eq!(all_errors().len(), 1);
        webtoons.clear();
    }

    #[test]
    fn hidden_store_round_trips_through_dump_and_hydrate() {
        let _guard = test_lock();
        reset();
        let webtoons = get("webtoons").unwrap();
        webtoons.put_hidden("seriesUrl", "webtoons-1", "https://x/list?title_no=1");
        let ctx = webtoons.hidden_ctx();
        assert_eq!(ctx["seriesUrl"]["webtoons-1"], "https://x/list?title_no=1");

        let dump = webtoons.dump_hidden();
        webtoons.clear_hidden();
        assert_eq!(webtoons.hidden_ctx(), json!({}));
        webtoons.hydrate_hidden(&dump);
        assert_eq!(webtoons.hidden_ctx(), ctx);
    }

    #[test]
    fn script_prepends_the_document_to_the_runtime() {
        let _guard = test_lock();
        reset();
        let entry = get("webtoons").unwrap();
        let script = script_for(&entry);
        assert!(script.starts_with("var DOC = {"));
        assert!(script.contains("function plan("));
    }
}
