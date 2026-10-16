//! 源运行时的分发与版本标识。
//!
//! 运行时随 app 内置一份默认副本（否则首启与离线时任何文档都解析不了），并可被源仓库索引里
//! 的更新覆盖。`crawler` 组装脚本时把文档拼在本运行时之前（见 `js::call` 的体积检查）。
//!
//! 结果缓存的键含运行时的版本标识：运行时一变，按旧逻辑解析出来的缓存结果立即失效。

use crate::util::hex;
use sha2::{Digest, Sha256};
use std::sync::LazyLock;
use std::sync::RwLock;

/// 内置运行时（随 app 打包）。
const BUNDLED: &str = include_str!("runtime.js");

/// 源仓库同步进来的覆盖版本（未同步时为 None）。
static OVERRIDE: LazyLock<RwLock<Option<String>>> = LazyLock::new(|| RwLock::new(None));

/// 当前生效的运行时源码：覆盖版本优先，否则内置。
pub fn source() -> String {
    if let Some(s) = OVERRIDE.read().unwrap().as_ref() {
        return s.clone();
    }
    BUNDLED.to_string()
}

/// 设置覆盖版本（`None` 表示回到内置）。
pub fn set(script: Option<String>) {
    *OVERRIDE.write().unwrap() = script.filter(|s| !s.is_empty());
}

/// 运行时版本标识：当前源码 sha256 的前 16 个十六进制字符（结果缓存键用）。
pub fn fingerprint() -> String {
    let mut hasher = Sha256::new();
    hasher.update(source().as_bytes());
    hex(hasher.finalize().as_slice())[..16].to_string()
}

/// 内置运行时源码。测试里求值 plan/parse 契约时用这一份：`source()` 取的是当前生效的
/// 版本，而覆盖版本是全局状态，别的用例会在测试中间把它换掉。
#[cfg(test)]
pub(crate) fn bundled() -> &'static str {
    BUNDLED
}

/// 内置运行时的 sha256（源仓库比对与测试用）。
pub fn bundled_fingerprint() -> String {
    let mut hasher = Sha256::new();
    hasher.update(BUNDLED.as_bytes());
    hex(hasher.finalize().as_slice())[..16].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_is_used_until_overridden() {
        let _guard = crate::crawler::registry::test_lock();
        let bundled = source();
        assert!(bundled.contains("function plan("), "内置运行时应有 plan");
        assert!(bundled.contains("function parse("), "内置运行时应有 parse");
        set(Some("function plan(){} function parse(){}".to_string()));
        assert!(source().contains("function plan(){}"));
        set(None);
        assert_eq!(source(), bundled);
    }

    #[test]
    fn fingerprint_follows_the_override() {
        let _guard = crate::crawler::registry::test_lock();
        set(None);
        let before = fingerprint();
        assert_eq!(before, bundled_fingerprint());
        set(Some("function plan(){} function parse(){}".to_string()));
        assert_ne!(fingerprint(), before, "换运行时后版本标识应变化");
        set(None);
        assert_eq!(fingerprint(), before);
    }

    #[test]
    fn empty_override_falls_back_to_bundled() {
        let _guard = crate::crawler::registry::test_lock();
        set(Some(String::new()));
        assert_eq!(fingerprint(), bundled_fingerprint());
    }
}
