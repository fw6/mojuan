//! 真网冒烟（手动验证）：默认忽略，`cargo test -- --ignored` 手动跑。
//! 用真实网络验证源文档全链路（plan → 抓取 → parse → 输出非空）。
//! CI 不跑：依赖外网站点，易受网络/反爬波动影响。

use mojuan_core::crawler::registry::{self, SyncPayload, SyncSource};
use std::path::{Path, PathBuf};

/// 把仓库里的全部源文档同步进注册表（内置只有 webtoons，其余 8 个要从文档目录装载）。
fn sync_all() {
    let dir = Path::new(mojuan_core::SOURCE_DOC_DIR);
    let mut sources: Vec<SyncSource> = std::fs::read_dir(&dir)
        .expect("源文档目录")
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p: &PathBuf| p.extension().and_then(|x| x.to_str()) == Some("json"))
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
        "源文档都应通过校验: {:?}",
        outcome.rejected
    );
}

fn live_crawl(source: &str, op: &str, payload: &str) -> serde_json::Value {
    sync_all();
    let out = mojuan_core::crawl(op, source, payload, "");
    serde_json::from_str(&out).expect("输出应为合法 JSON")
}

#[test]
#[ignore]
fn webtoons_live_search() {
    let comics = live_crawl("webtoons", "search", r#"{"keyword":"eleceed"}"#);
    let arr = comics.as_array().expect("search 返回数组");
    assert!(!arr.is_empty(), "webtoons 搜索应有结果");
    println!("webtoons: {} 条，首条 {} / {}", arr.len(), arr[0]["id"], arr[0]["title"]);
}

#[test]
#[ignore]
fn mangadex_live_search() {
    let comics = live_crawl("mangadex", "search", r#"{"keyword":"eleceed"}"#);
    let arr = comics.as_array().expect("search 返回数组");
    assert!(!arr.is_empty(), "mangadex 搜索应有结果");
    println!("mangadex: {} 条，首条 {} / {}", arr.len(), arr[0]["id"], arr[0]["title"]);
}

#[test]
#[ignore]
fn mangadex_live_detail() {
    // 用上面搜索到的第一本的 id
    let comics = live_crawl("mangadex", "search", r#"{"keyword":"eleceed"}"#);
    let id = comics[0]["id"].as_str().expect("comicId").to_string();
    let detail = live_crawl("mangadex", "detail", &format!(r#"{{"comicId":"{id}"}}"#));
    assert!(detail["chapters"].as_array().map(|c| !c.is_empty()).unwrap_or(false));
    println!("mangadex detail: {} 章，lastChapter {}", detail["chapters"].as_array().unwrap().len(), detail["comic"]["lastChapter"]);
}

#[test]
#[ignore]
fn copymanga_live_search() {
    let comics = live_crawl("copymanga", "search", r#"{"keyword":"海贼王"}"#);
    let arr = comics.as_array().expect("search 返回数组");
    assert!(!arr.is_empty(), "copymanga 搜索应有结果");
    println!("copymanga: {} 条，首条 {} / {}", arr.len(), arr[0]["id"], arr[0]["title"]);
}

#[test]
#[ignore]
fn copymanga_live_detail_and_images() {
    // 完整链路：搜索 → 详情 → 章节 → 图片。
    // 注意：本测试需在不受 Copymanga IP 风控的（家用）网络跑——若 detail 为空且记录到
    // 错误，多为被风控拦截（comic2 返回 results:null / code 210「等待1小时自动解除」），
    // 属外部服务封锁而非代码问题；换网络后重试即可。
    let comics = live_crawl("copymanga", "search", r#"{"keyword":"海贼王"}"#);
    let arr = comics.as_array().expect("search 返回数组");
    assert!(!arr.is_empty(), "copymanga 搜索应有结果（空 = 可能连 search 也被风控拦截）");
    let id = arr[0]["id"].as_str().expect("comicId").to_string();
    let detail = live_crawl("copymanga", "detail", &format!(r#"{{"comicId":"{id}"}}"#));
    let chapters = detail
        .get("chapters")
        .and_then(|c| c.as_array())
        .cloned()
        .unwrap_or_default();
    let err = mojuan_core::crawler::registry::last_error("copymanga")
        .map(|(m, _)| m)
        .unwrap_or_default();
    if chapters.is_empty() {
        panic!(
            "copymanga 详情应有章节；空 detail + 记录错误 [{err}] \
             = 被 Copymanga IP 风控拦截（results:null / code 210），请换家用网络重试"
        );
    }
    let idx = chapters[0]["index"].as_f64().unwrap();
    let imgs = live_crawl("copymanga", "images", &format!(r#"{{"comicId":"{id}","chapterIndex":{idx}}}"#));
    let imgs_arr = imgs.as_array().cloned().unwrap_or_default();
    assert!(!imgs_arr.is_empty(), "copymanga 章节应有图片");
    println!("copymanga detail: {} 章；首章 {} 张图", chapters.len(), imgs_arr.len());
}

#[test]
#[ignore]
fn dongman_live_search() {
    let comics = live_crawl("dongman", "search", r#"{"keyword":"甜蜜"}"#);
    let arr = comics.as_array().expect("search 返回数组");
    assert!(!arr.is_empty(), "dongman 搜索应有结果");
    println!("dongman: {} 条，首条 {} / {}", arr.len(), arr[0]["id"], arr[0]["title"]);
}

#[test]
#[ignore]
fn dongman_live_detail_and_images() {
    // 完整链路：搜索 → 详情（/episodeList?titleNo=N 跟随 301）→ 章节 → viewer → 图片。
    // 咚漫无 IP 风控（2026-08-19 本环境实测可通），家用网络应正常。
    let comics = live_crawl("dongman", "search", r#"{"keyword":"甜蜜"}"#);
    let arr = comics.as_array().expect("search 返回数组");
    assert!(!arr.is_empty(), "dongman 搜索应有结果");
    let id = arr[0]["id"].as_str().expect("comicId").to_string();
    let detail = live_crawl("dongman", "detail", &format!(r#"{{"comicId":"{id}"}}"#));
    let chapters = detail
        .get("chapters")
        .and_then(|c| c.as_array())
        .cloned()
        .unwrap_or_default();
    assert!(!chapters.is_empty(), "dongman 详情应有章节");
    let idx = chapters[0]["index"].as_f64().unwrap();
    let imgs = live_crawl("dongman", "images", &format!(r#"{{"comicId":"{id}","chapterIndex":{idx}}}"#));
    let imgs_arr = imgs.as_array().cloned().unwrap_or_default();
    assert!(!imgs_arr.is_empty(), "dongman 章节应有图片");
    println!("dongman detail: {} 章；首章 {} 张图", chapters.len(), imgs_arr.len());
}

#[test]
#[ignore]
fn manhuagui_live_search() {
    let comics = live_crawl("manhuagui", "search", r#"{"keyword":"音速"}"#);
    let arr = comics.as_array().expect("search 返回数组");
    assert!(!arr.is_empty(), "manhuagui 搜索应有结果");
    println!("manhuagui: {} 条，首条 {} / {}", arr.len(), arr[0]["id"], arr[0]["title"]);
}

#[test]
#[ignore]
fn manhuagui_live_detail_and_images() {
    // 完整链路：搜索 → 详情（章节列表在详情页）→ 章节页 → 解包 p.a.c.k.e.r → 图片。
    // 注意：章节页的图片脚本（path/files/sl）会被本机（数据中心 IP）剥离——
    // 家用网络应能拿到；若 images 为空且本机直连章节页无 eval(function(p,a,c,k,e,d)，
    // 为服务端反爬剥离，换家用网络重试即可。
    let comics = live_crawl("manhuagui", "search", r#"{"keyword":"海贼王"}"#);
    let arr = comics.as_array().expect("search 返回数组");
    assert!(!arr.is_empty(), "manhuagui 搜索应有结果");
    let id = arr[0]["id"].as_str().expect("comicId").to_string();
    let detail = live_crawl("manhuagui", "detail", &format!(r#"{{"comicId":"{id}"}}"#));
    let chapters = detail
        .get("chapters")
        .and_then(|c| c.as_array())
        .cloned()
        .unwrap_or_default();
    let err = mojuan_core::crawler::registry::last_error("manhuagui")
        .map(|(m, _)| m)
        .unwrap_or_default();
    if chapters.is_empty() {
        panic!(
            "manhuagui 详情应有章节（首条搜索 {id}）；空 detail + 记录错误 [{err}] \
             = 服务端对数据中心 IP 剥离章节/图片数据，请换家用网络重试"
        );
    }
    let idx = chapters[0]["index"].as_f64().unwrap();
    let imgs = live_crawl("manhuagui", "images", &format!(r#"{{"comicId":"{id}","chapterIndex":{idx}}}"#));
    let imgs_arr = imgs.as_array().cloned().unwrap_or_default();
    if imgs_arr.is_empty() {
        panic!(
            "manhuagui 章节应有图片；空 + 章节页无 eval(p.a.c.k.e.r) = 服务端对数据中心 IP \
             剥离图片脚本，请换家用网络重试"
        );
    }
    println!("manhuagui detail: {} 章；首章 {} 张图", chapters.len(), imgs_arr.len());
}

#[test]
#[ignore]
fn kxmanhua_live_detail_and_images() {
    // 完整链路：搜索 → 详情 → 章节页 → 图片。开心看漫画无 IP 风控（2026-09-30 本环境实测可通）。
    let comics = live_crawl("kxmanhua", "search", r#"{"keyword":"最棒"}"#);
    let arr = comics.as_array().expect("search 返回数组");
    assert!(!arr.is_empty(), "kxmanhua 搜索应有结果");
    let id = arr[0]["id"].as_str().expect("comicId").to_string();
    let detail = live_crawl("kxmanhua", "detail", &format!(r#"{{"comicId":"{id}"}}"#));
    let chapters = detail
        .get("chapters")
        .and_then(|c| c.as_array())
        .cloned()
        .unwrap_or_default();
    assert!(!chapters.is_empty(), "kxmanhua 详情应有章节");
    let idx = chapters[0]["index"].as_f64().unwrap();
    let imgs = live_crawl("kxmanhua", "images", &format!(r#"{{"comicId":"{id}","chapterIndex":{idx}}}"#));
    let imgs_arr = imgs.as_array().cloned().unwrap_or_default();
    assert!(!imgs_arr.is_empty(), "kxmanhua 章节应有图片");
    println!("kxmanhua detail: {} 章；首章 {} 张图", chapters.len(), imgs_arr.len());
}

#[test]
#[ignore]
fn hentara_live_detail_and_images() {
    // 完整链路：搜索（index.json 本地过滤）→ 详情 → 章节 JSON → 图片。
    // Hentara 站点与数据 CDN 都无 IP 风控（2026-09-30 本环境实测可通）。
    let comics = live_crawl("hentara", "search", r#"{"keyword":"harem"}"#);
    let arr = comics.as_array().expect("search 返回数组");
    assert!(!arr.is_empty(), "hentara 搜索应有结果");
    let id = arr[0]["id"].as_str().expect("comicId").to_string();
    let detail = live_crawl("hentara", "detail", &format!(r#"{{"comicId":"{id}"}}"#));
    let chapters = detail
        .get("chapters")
        .and_then(|c| c.as_array())
        .cloned()
        .unwrap_or_default();
    assert!(!chapters.is_empty(), "hentara 详情应有章节");
    let idx = chapters[0]["index"].as_f64().unwrap();
    let imgs = live_crawl("hentara", "images", &format!(r#"{{"comicId":"{id}","chapterIndex":{idx}}}"#));
    let imgs_arr = imgs.as_array().cloned().unwrap_or_default();
    assert!(!imgs_arr.is_empty(), "hentara 章节应有图片");
    println!("hentara detail: {} 章；首章 {} 张图", chapters.len(), imgs_arr.len());
}

// nnhanman 是渲染源：页面抓取经隐藏 webview 渲染通道，mojuan-core 单进程没有宿主，
// 真网验证走 src-tauri 的渲染通道探针（见 docs/research/nnhanman-source.md）：
//   cd apps/mojuan/src-tauri
//   cargo run --example render_probe -- chain nnhanman nnhanman-zui-bang-de-ta 85989
