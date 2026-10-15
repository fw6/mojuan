//! 隐藏值存储：名 → 键 → 值。
//!
//! 三处同形：已装源的跨 op 缓存（[`crate::crawler::registry::Entry`]）、调试运行的会话快照
//! （[`crate::crawler::debug`]）、以及测试里的观察者。这里给出一个共享类型，读写与快照往返
//! 只有一份实现。

use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::sync::Mutex;

/// 名 → 键 → 值。
type HiddenMap = BTreeMap<String, BTreeMap<String, String>>;

/// 线程安全的隐藏值存储。
#[derive(Default)]
pub struct HiddenStore {
    inner: Mutex<HiddenMap>,
}

impl HiddenStore {
    /// 从 JSON 文本解析会话快照；不成形的部分按无值处理（与 `cache_hydrate` 一致）。
    pub fn from_snapshot(snapshot: &str) -> Self {
        let store = Self::default();
        let parsed: Value = serde_json::from_str(snapshot).unwrap_or(Value::Null);
        store.hydrate(&parsed);
        store
    }

    /// 交给运行时的 `ctx.hidden` 形状：`{名: {键: 值}}`。
    pub fn ctx(&self) -> Value {
        let mut out = Map::new();
        for (name, by_key) in self.inner.lock().unwrap().iter() {
            let mut keys = Map::new();
            for (key, value) in by_key.iter() {
                keys.insert(key.clone(), Value::String(value.clone()));
            }
            out.insert(name.clone(), Value::Object(keys));
        }
        Value::Object(out)
    }

    /// 写入一条隐藏值。
    pub fn put(&self, name: &str, key: &str, value: &str) {
        self.inner
            .lock()
            .unwrap()
            .entry(name.to_string())
            .or_default()
            .insert(key.to_string(), value.to_string());
    }

    /// 清空（测试与「换源」时用）。
    pub fn clear(&self) {
        self.inner.lock().unwrap().clear();
    }

    /// 持久化快照（`cache_dump`）。
    pub fn dump(&self) -> Value {
        self.ctx()
    }

    /// 回灌快照（`cache_hydrate`）；不成形的部分按无值处理。
    pub fn hydrate(&self, value: &Value) {
        let Some(names) = value.as_object() else {
            return;
        };
        let mut store = self.inner.lock().unwrap();
        for (name, by_key) in names {
            let Some(keys) = by_key.as_object() else {
                continue;
            };
            let slot = store.entry(name.clone()).or_default();
            for (key, v) in keys {
                if let Some(s) = v.as_str() {
                    slot.insert(key.clone(), s.to_string());
                }
            }
        }
    }

    /// 把另一个存储的内容整体搬过来（换源版本时隐藏值按名字与键存，与文档版本无关）。
    pub fn copy_from(&self, other: &HiddenStore) {
        // 先取快照再上锁，避免同时持有两把锁
        let snapshot = other.inner.lock().unwrap().clone();
        *self.inner.lock().unwrap() = snapshot;
    }
}
