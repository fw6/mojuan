//! 结果缓存接线测试：crawl 成功写入 / 失败不写入，cached_result 读取命中（离线，无网络）。
//!
//! 注册表是进程级的，一次 sync 会整体替换已装源，所以这些用例放在同一个测试函数里顺序跑。

use mojuan_core::crawler::registry::{sync, SyncPayload, SyncSource};
use mojuan_core::{cached_result, crawl};

/// categories 是静态 op（不抓取），用它在离线环境跑通成功链路。
const GOOD_DOC: &str = r#"{
    "schema": 1, "id": "good", "title": "成功源",
    "categories": [{ "label": "动作", "url": "https://example.com/a" }],
    "ops": { "search": { "items": "div.item", "id": { "attr": "data-id" } } }
}"#;

/// search 的解析用钩子直接抛错：走失败分支，不写缓存。
const FAIL_DOC: &str = r#"{
    "schema": 1, "id": "bad", "title": "失败源",
    "ops": {
        "search": { "script": "function(){ throw new Error('boom') }" }
    }
}"#;

fn temp_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "mojuan-crawl-cache-test-{}-{}",
        tag,
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn install(good: &str, bad: &str) {
    let outcome = sync(SyncPayload {
        runtime: None,
        sources: vec![
            SyncSource {
                id: "good".into(),
                document: good.into(),
            },
            SyncSource {
                id: "bad".into(),
                document: bad.into(),
            },
        ],
    });
    assert!(outcome.rejected.is_empty(), "{:?}", outcome.rejected);
}

#[test]
fn crawl_writes_cache_only_on_success_and_cached_result_reads_it() {
    let dir = temp_dir("ok");
    let d = dir.to_str().unwrap();
    install(GOOD_DOC, FAIL_DOC);

    // 成功：结果写进缓存，cached_result 能读回来
    let payload = r#"{"tag":"ok"}"#;
    let out = crawl("categories", "good", payload, d);
    assert_eq!(out, r#"["动作"]"#);
    let cached = cached_result("categories", "good", payload, d);
    let v: serde_json::Value = serde_json::from_str(&cached).unwrap();
    assert_eq!(v["data"], serde_json::json!(["动作"]));
    assert!(v["fetchedAt"].as_u64().unwrap() > 0);

    // 失败：不写缓存
    let bad_payload = r#"{"tag":"fail"}"#;
    assert_eq!(crawl("search", "bad", bad_payload, d), "[]");
    assert_eq!(cached_result("search", "bad", bad_payload, d), "null");

    // 不可缓存的 op
    let img_payload = r#"{"tag":"img"}"#;
    crawl("images", "good", img_payload, d);
    assert_eq!(cached_result("images", "good", img_payload, d), "null");

    // 空 cache_dir 禁用缓存
    let off_payload = r#"{"tag":"off"}"#;
    crawl("categories", "good", off_payload, "");
    assert_eq!(cached_result("categories", "good", off_payload, ""), "null");

    // 未装源
    assert_eq!(cached_result("categories", "nope", payload, d), "null");

    let _ = std::fs::remove_dir_all(&dir);
}
