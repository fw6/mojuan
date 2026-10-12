//! 源文档的 Rust 侧端到端：真 QuickJS + 真 scraper，跑仓库里的 9 份文档与它们的 fixture。
//!
//! 与 JS 侧（`src/js/source-docs.test.js` 的共享驱动）跑同一批 fixture。这里守的是
//! **引擎差异**：node 侧用 jsdom 实现 HTML 选择器，这里是 `scraper`（html5ever），两侧
//! 对同一份标记的解析可能不同；本文件只断言「这个源在真引擎里跑得通、产出带自己前缀的
//! 结果」，逐字段的语义由 JS 侧的共享驱动覆盖。

use mojuan_core::crawler::registry::{self, SyncPayload, SyncSource};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

fn sources_dir() -> PathBuf {
    PathBuf::from(mojuan_core::SOURCE_DOC_DIR)
}

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn fixture(name: &str) -> String {
    std::fs::read_to_string(fixtures_dir().join(name))
        .unwrap_or_else(|e| panic!("读 fixture {name} 失败: {e}"))
}

/// 把仓库里的全部源文档同步进注册表（内置的 webtoons 会被同名文档覆盖，内容相同）。
fn sync_all() {
    static ONCE: OnceLock<()> = OnceLock::new();
    ONCE.get_or_init(|| {
        let mut sources: Vec<SyncSource> = std::fs::read_dir(sources_dir())
            .expect("源文档目录")
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("json"))
            .filter_map(|p| {
                let id = p.file_stem()?.to_str()?.to_string();
                Some(SyncSource {
                    id,
                    document: std::fs::read_to_string(&p).ok()?,
                })
            })
            .collect();
        sources.sort_by(|a, b| a.id.cmp(&b.id));
        let outcome = registry::sync(SyncPayload {
            runtime: None,
            sources,
        });
        assert!(
            outcome.rejected.is_empty(),
            "仓库里的源文档都应通过校验: {:?}",
            outcome.rejected
        );
    });
}

/// 把一个 op 的响应直接喂给解析（不联网）：`steps` 是 (步骤名, fixture 文件名)。
fn parse_with(source: &str, op: &str, payload: &str, steps: &[(&str, &str)]) -> Value {
    sync_all();
    let entry = registry::get(source).unwrap_or_else(|| panic!("{source} 应已注册"));
    let script = registry::script_for(&entry);
    let responses: serde_json::Map<String, Value> = steps
        .iter()
        .map(|(name, file)| ((*name).to_string(), Value::String(fixture(file))))
        .collect();
    let req = serde_json::json!({
        "op": op,
        "payload": serde_json::from_str::<Value>(payload).unwrap(),
        "ctx": { "hidden": entry.hidden_ctx() },
        "responses": responses,
    });
    let out = mojuan_core::js::call(&script, "parse", &req.to_string())
        .unwrap_or_else(|e| panic!("{source} {op} 解析失败: {e}"));
    let envelope: Value = serde_json::from_str(&out).expect("parse 应返回 JSON");
    // 隐藏值按真实流程写进缓存，后续 op 才能用上（与 script::run 一致）
    if let Some(items) = envelope.get("hidden").and_then(Value::as_array) {
        for item in items {
            let name = item["name"].as_str().unwrap_or("");
            let key = item["key"].as_str().unwrap_or("");
            let value = item["value"].as_str().unwrap_or("");
            if !name.is_empty() && !key.is_empty() && !value.is_empty() {
                entry.put_hidden(name, key, value);
            }
        }
    }
    envelope.get("data").cloned().unwrap_or(Value::Null)
}

/// 列表类 op 的通用断言：有结果，且 id 带该源的前缀。
fn assert_list(source: &str, op: &str, payload: &str, steps: &[(&str, &str)]) {
    let data = parse_with(source, op, payload, steps);
    let arr = data
        .as_array()
        .unwrap_or_else(|| panic!("{source} {op} 应返回数组: {data}"));
    assert!(!arr.is_empty(), "{source} {op} 应有结果");
    let id = arr[0]["id"].as_str().unwrap_or("");
    assert!(
        id.starts_with(&format!("{source}-")),
        "{source} 的 id 前缀不对: {id}"
    );
}

/// 详情类 op 的通用断言：有标题，且有章节。
fn assert_detail(source: &str, comic_id: &str, steps: &[(&str, &str)]) {
    let payload = format!(r#"{{"comicId":"{comic_id}"}}"#);
    let data = parse_with(source, "detail", &payload, steps);
    let title = data["comic"]["title"].as_str().unwrap_or("");
    assert!(!title.is_empty(), "{source} 详情应有标题: {data}");
    let chapters = data["chapters"]
        .as_array()
        .unwrap_or_else(|| panic!("{source} 详情应有章节数组: {data}"));
    assert!(!chapters.is_empty(), "{source} 详情应有章节");
}

#[test]
fn every_source_parses_its_list_fixture() {
    assert_list(
        "webtoons",
        "search",
        r#"{"keyword":"eleceed"}"#,
        &[("list", "search-card.html")],
    );
    assert_list(
        "mangadex",
        "search",
        r#"{"keyword":"eleceed"}"#,
        &[("list", "mangadex-search.json")],
    );
    assert_list(
        "copymanga",
        "search",
        r#"{"keyword":"海贼王"}"#,
        &[("list", "copymanga-search.json")],
    );
    assert_list(
        "dongman",
        "search",
        r#"{"keyword":"甜蜜"}"#,
        &[("list", "dongman-search.html")],
    );
    assert_list(
        "manhuagui",
        "search",
        r#"{"keyword":"音速"}"#,
        &[("list", "manhuagui-search.html")],
    );
    assert_list(
        "baozimh",
        "search",
        r#"{"keyword":"海贼"}"#,
        &[("list", "baozimh-search.html")],
    );
    assert_list(
        "nnhanman",
        "search",
        r#"{"keyword":"韓"}"#,
        &[("list", "nnhanman-search.html")],
    );
    assert_list(
        "kxmanhua",
        "search",
        r#"{"keyword":"最棒"}"#,
        &[("list", "kxmanhua-search.html")],
    );
    assert_list(
        "hentara",
        "search",
        r#"{"keyword":"harem"}"#,
        &[("index", "hentara-index.json")],
    );
}

#[test]
fn every_source_parses_its_detail_fixture() {
    assert_detail("webtoons", "webtoons-1571", &[("page", "detail.html")]);
    assert_detail(
        "mangadex",
        "mangadex-7e544761-7d3d-4fce-8137-719814d7d138",
        &[
            ("manga", "mangadex-detail.json"),
            ("feed", "mangadex-feed.json"),
        ],
    );
    assert_detail(
        "copymanga",
        "copymanga-haizeiwang",
        &[
            ("comic", "copymanga-detail.json"),
            ("feed", "copymanga-feed.json"),
        ],
    );
    assert_detail("dongman", "dongman-2859", &[("page", "dongman-detail.html")]);
    assert_detail(
        "manhuagui",
        "manhuagui-43847",
        &[("page", "manhuagui-detail.html")],
    );
    assert_detail(
        "baozimh",
        "baozimh-hanghaiwang-weitianrongyilang",
        &[("page", "baozimh-detail.html")],
    );
    assert_detail(
        "nnhanman",
        "nnhanman-zui-bang-de-ta",
        &[("page", "nnhanman-detail.html")],
    );
    assert_detail(
        "kxmanhua",
        "kxmanhua-7067",
        &[("page", "kxmanhua-detail.html")],
    );
    assert_detail(
        "hentara",
        "hentara-capitalist-harem",
        &[("comic", "hentara-detail.json")],
    );
}

#[test]
fn every_source_parses_its_image_fixture() {
    // 阅读页：章节号取各 fixture 里第一话的号
    let cases: &[(&str, &str, f64, &str, &str)] = &[
        ("webtoons", "webtoons-1571", 398.0, "viewer", "viewer.html"),
        ("mangadex", "mangadex-7e544761-7d3d-4fce-8137-719814d7d138", 2.0, "home", "mangadex-at-home.json"),
        ("copymanga", "copymanga-haizeiwang", 1.0, "chapter", "copymanga-chapter.json"),
        ("dongman", "dongman-2859", 9.0, "viewer", "dongman-viewer.html"),
        ("manhuagui", "manhuagui-43847", 901676.0, "page", "manhuagui-chapter.html"),
        ("baozimh", "baozimh-hanghaiwang-weitianrongyilang", 1.0, "page", "baozimh-chapter.html"),
        ("nnhanman", "nnhanman-zui-bang-de-ta", 85989.0, "page", "nnhanman-chapter.html"),
        ("kxmanhua", "kxmanhua-7067", 173803.0, "page", "kxmanhua-chapter.html"),
        ("hentara", "hentara-capitalist-harem", 1.0, "chapter", "hentara-episode.json"),
    ];
    for (source, comic_id, chapter_index, step, file) in cases {
        let payload =
            format!(r#"{{"comicId":"{comic_id}","chapterIndex":{chapter_index}}}"#);
        let data = parse_with(source, "images", &payload, &[(*step, *file)]);
        let urls = data
            .as_array()
            .unwrap_or_else(|| panic!("{source} images 应返回数组: {data}"));
        assert!(!urls.is_empty(), "{source} 的阅读页应有图片");
    }
}

#[test]
fn webtoons_categories_are_static() {
    sync_all();
    let out = mojuan_core::crawl("categories", "webtoons", "{}", "");
    let cats: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(cats.as_array().unwrap().len(), 8);
    assert!(cats.as_array().unwrap().iter().any(|c| c == "恋爱"));
}

/// 同步契约：被接受的源按传入顺序返回前端事实（显示名 + 热链对），坏文档不替换已装版本。
/// 前端源清单与图片代理就靠这个返回值。
#[test]
fn sync_reports_frontend_facts_in_order() {
    let docs = [
        ("dongman", "dongman.json"),
        ("kxmanhua", "kxmanhua.json"),
        ("manhuagui", "manhuagui.json"),
    ];
    let sources: Vec<SyncSource> = docs
        .iter()
        .map(|(id, file)| SyncSource {
            id: (*id).to_string(),
            document: std::fs::read_to_string(sources_dir().join(file)).expect("读文档"),
        })
        .collect();
    let outcome = registry::sync(SyncPayload {
        runtime: None,
        sources,
    });
    assert!(outcome.rejected.is_empty(), "{:?}", outcome.rejected);

    // 内置的 webtoons 恒排最前，其余按传入顺序
    let ids: Vec<&str> = outcome
        .accepted
        .iter()
        .map(|f| f["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec!["webtoons", "dongman", "kxmanhua", "manhuagui"]);

    let webtoons = &outcome.accepted[0];
    assert_eq!(webtoons["title"], "Webtoons");
    assert_eq!(webtoons["hotlinkReferers"][0]["domain"], "pstatic.net");
    let manhuagui = outcome
        .accepted
        .iter()
        .find(|f| f["id"] == "manhuagui")
        .expect("manhuagui 应被接受");
    assert_eq!(manhuagui["title"], "漫画柜");
    assert_eq!(manhuagui["hotlinkReferers"][0]["domain"], "hamreus.com");
}

/// 坏文档不替换已装版本，原因记在该源的错误行上（前端源管理页据此提示）。
#[test]
fn sync_keeps_the_installed_version_when_the_document_is_broken() {
    let good = std::fs::read_to_string(sources_dir().join("dongman.json")).expect("读文档");
    registry::sync(SyncPayload {
        runtime: None,
        sources: vec![SyncSource {
            id: "dongman".to_string(),
            document: good,
        }],
    });
    assert_eq!(registry::get("dongman").unwrap().doc.title, "咚漫");

    let outcome = registry::sync(SyncPayload {
        runtime: None,
        sources: vec![SyncSource {
            id: "dongman".to_string(),
            document: r#"{"schema": 1, "id": "dongman", "titel": "写错的键名", "ops": {}}"#.to_string(),
        }],
    });
    assert_eq!(outcome.rejected.len(), 1, "坏文档应被拒绝");
    let entry = registry::get("dongman").expect("旧版本应保留");
    assert_eq!(entry.doc.title, "咚漫");
    assert!(entry.error().is_some(), "应记录失败原因");
}
