//! 跨模块共用的小工具：有界 LRU、十六进制编码、当前时间。
//!
//! 这几样都在两个以上地方用到（图片缓存与抓取结果缓存各要一套 LRU，安装包校验与缓存键各要
//! 一次 hex，结果缓存与源错误各要一次 now_ms），收在这里一处实现、一处测试。

use std::borrow::Borrow;
use std::collections::{HashMap, VecDeque};
use std::hash::Hash;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// 按容量逐出最久未使用的键。锁在模块内部，调用方只写 `static CACHE: LazyLock<Lru<..>>`。
pub(crate) struct Lru<K, V> {
    cap: usize,
    inner: Mutex<Inner<K, V>>,
}

struct Inner<K, V> {
    map: HashMap<K, V>,
    /// 使用顺序：队首最久未用，命中或写入后移到队尾。
    order: VecDeque<K>,
}

impl<K, V> Default for Inner<K, V> {
    fn default() -> Self {
        Self {
            map: HashMap::new(),
            order: VecDeque::new(),
        }
    }
}

impl<K, V> Lru<K, V> {
    pub(crate) fn new(cap: usize) -> Self {
        Self {
            cap,
            inner: Mutex::new(Inner::default()),
        }
    }

    /// 清空（只给测试用：清掉内存命中，让「回落到磁盘」那段路径可测）。
    #[cfg(test)]
    pub(crate) fn clear(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.map.clear();
        inner.order.clear();
    }
}

impl<K: Eq + Hash + Clone, V: Clone> Lru<K, V> {
    /// 读一条；命中时把键移到队尾（算作最近使用）。键可以借成别的形态查（`String` 键用 `&str` 查）。
    pub(crate) fn get<Q>(&self, key: &Q) -> Option<V>
    where
        K: Borrow<Q>,
        Q: Eq + Hash + ToOwned<Owned = K> + ?Sized,
    {
        let mut inner = self.inner.lock().unwrap();
        let value = inner.map.get(key).cloned()?;
        if let Some(pos) = inner.order.iter().position(|k| k.borrow() == key) {
            inner.order.remove(pos);
        }
        inner.order.push_back(key.to_owned());
        Some(value)
    }

    /// 写一条；超过容量时逐出队首。
    pub(crate) fn put(&self, key: K, value: V) {
        let mut inner = self.inner.lock().unwrap();
        if !inner.map.contains_key(&key) {
            inner.order.push_back(key.clone());
        }
        inner.map.insert(key, value);
        while inner.order.len() > self.cap {
            if let Some(oldest) = inner.order.pop_front() {
                inner.map.remove(&oldest);
            }
        }
    }
}

/// 小写十六进制（缓存键与校验和用）。
pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// 当前 unix 毫秒。
pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(s: &str) -> String {
        s.to_string()
    }

    #[test]
    fn get_promotes_to_recent() {
        let lru = Lru::new(2);
        lru.put(key("a"), 1);
        lru.put(key("b"), 2);
        assert_eq!(lru.get("a"), Some(1)); // a 变成最近使用
        lru.put(key("c"), 3); // 逐出 b
        assert_eq!(lru.get("b"), None);
        assert_eq!(lru.get("a"), Some(1));
        assert_eq!(lru.get("c"), Some(3));
    }

    #[test]
    fn put_same_key_does_not_take_two_slots() {
        let lru = Lru::new(2);
        lru.put(key("a"), 1);
        lru.put(key("a"), 2);
        lru.put(key("b"), 3);
        // a 只占一个位置，b 进来时不会把 a 挤掉
        assert_eq!(lru.get("a"), Some(2));
        assert_eq!(lru.get("b"), Some(3));
    }

    #[test]
    fn capacity_one_keeps_only_the_latest() {
        let lru = Lru::new(1);
        lru.put(key("a"), 1);
        lru.put(key("b"), 2);
        assert_eq!(lru.get("a"), None);
        assert_eq!(lru.get("b"), Some(2));
    }

    #[test]
    fn clear_empties_the_cache() {
        let lru = Lru::new(4);
        lru.put(key("a"), 1);
        lru.clear();
        assert_eq!(lru.get("a"), None);
    }

    #[test]
    fn hex_is_lowercase_and_padded() {
        assert_eq!(hex(&[0x00, 0x0f, 0xff]), "000fff");
    }

    #[test]
    fn now_ms_is_unix_milliseconds() {
        // 2020-09-13 之后的毫秒数：秒/毫秒换算写反时这里会失败
        assert!(now_ms() > 1_600_000_000_000);
    }
}
