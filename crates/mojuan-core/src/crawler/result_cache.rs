//! 抓取结果缓存（stale-while-revalidate 的 stale 一侧）：内存 LRU + 磁盘持久化。
//!
//! 缓存键 = (source, op, 规范化 payload, 源文档, 运行时版本标识) 的 sha256；只缓存列表/详情类
//! op 的成功结果（见 `is_cacheable`），失败结果不写入（接线在 `crawler::crawl`）。前端加载列表/
//! 详情时先经 `crawl_cached` 命令渲染缓存、再调 `crawl` 拉最新并回写缓存。
//! 运行时版本标识入键的理由：解释器的缺陷修正不改变任何文档的哈希，不入键的话按旧逻辑解析
//! 出来的结果会继续被当成新结果用。
//! 磁盘布局照 `cache.rs` 的图片缓存：`<cache_dir>/results/<sha256>.json`，内容
//! `{"at": <unix_ms>, "data": "<结果 JSON 字符串>"}`（data 以字符串保存，读取原样返回）。

use crate::js::runtime;
use crate::util::{hex, now_ms, Lru};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::{Duration, SystemTime};

/// 内存 LRU 上限（条数；逐出后回落到磁盘）。
const LRU_CAP: usize = 128;

/// 可缓存的 op：列表与详情。images 不缓存（图片地址可能带时效参数，打开章节要最新地址）；
/// cache_dump / cache_hydrate 是缓存管理 op 本身。
pub fn is_cacheable(op: &str) -> bool {
    matches!(op, "categories" | "category" | "search" | "detail")
}

/// 磁盘缓存文件：`at` 为抓取时刻（unix 毫秒，前端据此判断新鲜度）。
#[derive(Serialize, Deserialize)]
struct CacheFile {
    at: u64,
    data: String,
}

type Entry = (String, u64); // (结果 JSON, 抓取时刻)

static LRU: LazyLock<Lru<String, Entry>> = LazyLock::new(|| Lru::new(LRU_CAP));

/// 读缓存：内存 LRU → 磁盘。空 cache_dir 表示禁用缓存。
/// artifact 为空（源文档尚未同步进 registry）时同样禁用：缓存键含文档，未就绪时
/// 写入的条目与就绪后的条目分列两个键，永远不会再次命中。
pub fn get(
    cache_dir: &str,
    source: &str,
    op: &str,
    payload: &str,
    artifact: &str,
) -> Option<Entry> {
    if cache_dir.is_empty() || artifact.is_empty() || !is_cacheable(op) {
        return None;
    }
    let key = cache_key(source, op, payload, artifact);
    if let Some(entry) = LRU.get(&key) {
        return Some(entry);
    }
    let path = cache_path(cache_dir, &key);
    let raw = std::fs::read_to_string(&path).ok()?;
    let file: CacheFile = match serde_json::from_str(&raw) {
        Ok(f) => f,
        Err(_) => {
            // 文件损坏（写到一半退出等）：删除后按未命中处理，下次抓取重写
            let _ = std::fs::remove_file(&path);
            return None;
        }
    };
    let entry = (file.data, file.at);
    LRU.put(key, entry.clone());
    Some(entry)
}

/// 写缓存（内存 + 磁盘）。磁盘写失败忽略：缓存是优化通道，下次抓取会重写。
/// artifact 为空时不写入（同 `get` 的说明）。
pub fn put(cache_dir: &str, source: &str, op: &str, payload: &str, artifact: &str, data: &str) {
    if cache_dir.is_empty() || artifact.is_empty() || !is_cacheable(op) {
        return;
    }
    let key = cache_key(source, op, payload, artifact);
    let at = now_ms();
    LRU.put(key.clone(), (data.to_string(), at));
    let path = cache_path(cache_dir, &key);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
        if let Ok(json) = serde_json::to_string(&CacheFile {
            at,
            data: data.to_string(),
        }) {
            let _ = std::fs::write(&path, json);
        }
    }
}

/// 清理磁盘上超过 `max_age` 未更新的条目（启动时调用；常用条目每次抓取都会刷新修改时间）。
pub fn prune(cache_dir: &str, max_age: Duration) {
    if cache_dir.is_empty() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(results_dir(cache_dir)) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let stale = meta
            .modified()
            .ok()
            .and_then(|m| now.duration_since(m).ok())
            .map(|age| age > max_age)
            .unwrap_or(false);
        if stale {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// 结果缓存占用：`results` 下 `.json` 的字节数与条数。
pub fn usage(cache_dir: &str) -> (u64, usize) {
    let Ok(entries) = std::fs::read_dir(results_dir(cache_dir)) else {
        return (0, 0);
    };
    let mut bytes = 0u64;
    let mut count = 0usize;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Ok(meta) = entry.metadata() {
            if meta.is_file() {
                bytes += meta.len();
                count += 1;
            }
        }
    }
    (bytes, count)
}

/// 清空结果缓存：删掉 `results` 下的全部文件并清空内存表。
pub fn clear(cache_dir: &str) {
    if let Ok(entries) = std::fs::read_dir(results_dir(cache_dir)) {
        for entry in entries.flatten() {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    LRU.clear();
}

/// 缓存键：source / op / 规范化 payload / 源文档 / 运行时版本标识 的 sha256
/// （文档或运行时变化 = 旧条目不再命中）。
fn cache_key(source: &str, op: &str, payload: &str, artifact: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(source.as_bytes());
    hasher.update([0]);
    hasher.update(op.as_bytes());
    hasher.update([0]);
    hasher.update(normalize_payload(payload).as_bytes());
    hasher.update([0]);
    hasher.update(artifact.as_bytes());
    hasher.update([0]);
    hasher.update(runtime::fingerprint().as_bytes());
    hex(hasher.finalize().as_slice())
}

/// payload 规范化：解析后重新序列化（serde_json 默认按 BTreeMap 排序对象键），
/// 同一对象的不同键序命中同一缓存键；解析失败时原样使用。
fn normalize_payload(payload: &str) -> String {
    serde_json::from_str::<serde_json::Value>(payload)
        .map(|v| v.to_string())
        .unwrap_or_else(|_| payload.to_string())
}

fn results_dir(cache_dir: &str) -> PathBuf {
    Path::new(cache_dir).join("results")
}

fn cache_path(cache_dir: &str, key: &str) -> PathBuf {
    results_dir(cache_dir).join(format!("{key}.json"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mojuan-result-cache-test-{}-{}",
            tag,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn clear_lru() {
        LRU.clear();
    }

    #[test]
    fn put_then_get_hits_memory() {
        let dir = temp_dir("memory");
        let d = dir.to_str().unwrap();
        put(
            d,
            "webtoons",
            "category",
            r#"{"label":"动作"}"#,
            "s1",
            r#"[{"id":"a"}]"#,
        );
        let (data, at) = get(d, "webtoons", "category", r#"{"label":"动作"}"#, "s1").unwrap();
        assert_eq!(data, r#"[{"id":"a"}]"#);
        assert!(at > 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn disk_hit_after_lru_clear() {
        let dir = temp_dir("disk");
        let d = dir.to_str().unwrap();
        put(
            d,
            "webtoons",
            "detail",
            r#"{"comicId":"x"}"#,
            "s2",
            r#"{"comic":{}}"#,
        );
        clear_lru();
        let (data, _) = get(d, "webtoons", "detail", r#"{"comicId":"x"}"#, "s2").unwrap();
        assert_eq!(data, r#"{"comic":{}}"#);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_returns_none() {
        let dir = temp_dir("missing");
        let d = dir.to_str().unwrap();
        assert!(get(d, "webtoons", "search", r#"{"keyword":"x"}"#, "s3").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_cache_dir_disables_cache() {
        put("", "webtoons", "category", "{}", "s4", r#"[]"#);
        assert!(get("", "webtoons", "category", "{}", "s4").is_none());
    }

    #[test]
    fn empty_artifact_disables_cache() {
        let dir = temp_dir("noartifact");
        let d = dir.to_str().unwrap();
        put(d, "webtoons", "category", "{}", "", r#"["a"]"#);
        assert!(get(d, "webtoons", "category", "{}", "").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn non_cacheable_op_not_stored() {
        let dir = temp_dir("nocache");
        let d = dir.to_str().unwrap();
        put(
            d,
            "webtoons",
            "images",
            r#"{"comicId":"x"}"#,
            "s5",
            r#"["u"]"#,
        );
        assert!(get(d, "webtoons", "images", r#"{"comicId":"x"}"#, "s5").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn payload_key_order_normalized() {
        let dir = temp_dir("keyorder");
        let d = dir.to_str().unwrap();
        put(
            d,
            "webtoons",
            "detail",
            r#"{"comicId":"x","chapterIndex":2}"#,
            "s6",
            r#"{"ok":1}"#,
        );
        let hit = get(
            d,
            "webtoons",
            "detail",
            r#"{"chapterIndex":2,"comicId":"x"}"#,
            "s6",
        );
        assert!(hit.is_some(), "键序不同应命中同一缓存");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn artifact_change_invalidates() {
        let dir = temp_dir("artifact");
        let d = dir.to_str().unwrap();
        put(d, "webtoons", "category", "{}", "doc-v1", r#"["a"]"#);
        assert!(get(d, "webtoons", "category", "{}", "doc-v2").is_none());
        assert!(get(d, "webtoons", "category", "{}", "doc-v1").is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 运行时换版本：文档没变，旧结果也不能再命中（解释器改对了之后不该继续用旧解析结果）。
    #[test]
    fn runtime_change_invalidates() {
        let _guard = crate::crawler::registry::test_lock();
        let dir = temp_dir("runtime");
        let d = dir.to_str().unwrap();
        put(d, "webtoons", "category", "{}", "doc", r#"["a"]"#);
        assert!(get(d, "webtoons", "category", "{}", "doc").is_some());
        runtime::set(Some("function plan(){} function parse(){}".to_string()));
        assert!(
            get(d, "webtoons", "category", "{}", "doc").is_none(),
            "换运行时后旧条目不应命中"
        );
        runtime::set(None);
        assert!(get(d, "webtoons", "category", "{}", "doc").is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_file_treated_as_miss_and_removed() {
        let dir = temp_dir("corrupt");
        let d = dir.to_str().unwrap();
        put(d, "webtoons", "category", "{}", "s7", r#"["a"]"#);
        // 找到磁盘文件并写坏
        let files: Vec<_> = std::fs::read_dir(dir.join("results"))
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .collect();
        assert_eq!(files.len(), 1);
        std::fs::write(&files[0], "not json").unwrap();
        clear_lru();
        assert!(get(d, "webtoons", "category", "{}", "s7").is_none());
        assert!(!files[0].exists(), "损坏文件应被删除");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn prune_removes_stale_keeps_fresh() {
        let dir = temp_dir("prune");
        let d = dir.to_str().unwrap();
        put(d, "webtoons", "category", "{}", "s8", r#"["a"]"#);
        // 大窗口：保留
        prune(d, Duration::from_secs(3600));
        assert!(get(d, "webtoons", "category", "{}", "s8").is_some());
        // 零窗口：新建文件也满足 age > 0，删除
        clear_lru();
        prune(d, Duration::ZERO);
        assert!(get(d, "webtoons", "category", "{}", "s8").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn usage_counts_json_entries() {
        let dir = temp_dir("usage");
        let d = dir.to_str().unwrap();
        put(
            d,
            "webtoons",
            "category",
            r#"{"label":"动作"}"#,
            "s9",
            r#"[{"id":"a"}]"#,
        );
        put(
            d,
            "webtoons",
            "detail",
            r#"{"comicId":"x"}"#,
            "s9",
            r#"{"comic":{}}"#,
        );

        let (bytes, count) = usage(d);
        assert_eq!(count, 2);
        assert!(bytes > 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 清空之后目录为空、内存表也空：再取同一条要走磁盘并重写。
    #[test]
    fn clear_empties_disk_and_memory() {
        let dir = temp_dir("clear");
        let d = dir.to_str().unwrap();
        put(
            d,
            "webtoons",
            "category",
            r#"{"label":"动作"}"#,
            "s10",
            r#"["a"]"#,
        );

        clear(d);
        assert_eq!(usage(d), (0, 0), "清空后目录为空");
        assert!(get(d, "webtoons", "category", r#"{"label":"动作"}"#, "s10").is_none());

        put(
            d,
            "webtoons",
            "category",
            r#"{"label":"动作"}"#,
            "s10",
            r#"["b"]"#,
        );
        let (data, _) = get(d, "webtoons", "category", r#"{"label":"动作"}"#, "s10").unwrap();
        assert_eq!(data, r#"["b"]"#);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
