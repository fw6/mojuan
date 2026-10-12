//! 渲染通道真网探针（live 验证与 fixture 采集工具，Tauri 侧等价于 mojuan-core 的 live_smoke）。
//!
//! 用法（在 `apps/mojuan/src-tauri` 下）：
//!   cargo run --example render_probe -- dump <url> <outfile>
//!       经隐藏 webview 渲染单个页面，把渲染后 HTML 写入 outfile（fixture 采集）。
//!   cargo run --example render_probe -- crawl <source> <op> <payload-json>
//!       走 `mojuan_core::crawl` 全链路（渲染源），结果 JSON 打印到 stdout。
//!   cargo run --example render_probe -- chain <source> <comicId> <chapterIndex>
//!       同进程跑 detail → images（验证进程内章节 URL 缓存与全链路），打印摘要。
//!
//! 启动最小 Tauri 应用：主窗口立即隐藏（探针无界面），`ExitRequested` 仅在探针显式
//! `exit(code)` 时放行；渲染通道与正式应用同一实现（`mojuan_lib::render`）。

use mojuan_lib::render;
use tauri::Manager;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let app = tauri::Builder::default()
        .setup(move |app| {
            let handle = app.handle().clone();
            // 探针无界面：隐藏配置声明的主窗口（销毁会让窗口计数归零触发退出流程）
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.hide();
            }
            render::init(&handle);
            let args = args.clone();
            std::thread::spawn(move || {
                let code = run(&handle, &args);
                handle.exit(code);
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("探针应用启动失败");
    app.run(|_app, event| {
        // 窗口全关不退出；只有 handle.exit(code)（code 非 None）才结束进程
        if let tauri::RunEvent::ExitRequested { code, api, .. } = event {
            if code.is_none() {
                api.prevent_exit();
            }
        }
    });
}

fn run(app: &tauri::AppHandle, args: &[String]) -> i32 {
    match args {
        [cmd, url, outfile] if cmd == "dump" => match render::render_sync(app, url) {
            Ok(html) => {
                if let Err(e) = std::fs::write(outfile, &html) {
                    eprintln!("写入 {outfile} 失败: {e}");
                    return 1;
                }
                eprintln!("已写入 {} 字节 -> {outfile}", html.len());
                0
            }
            Err(e) => {
                eprintln!("渲染失败: {e}");
                1
            }
        },
        [cmd, source, op, payload] if cmd == "crawl" => {
            if !install_source(source) {
                return 2;
            }
            // 禁用结果缓存（空 cache_dir）：探针每次走真实链路
            let out = mojuan_core::crawl(op, source, payload, "");
            println!("{out}");
            if let Some((msg, _)) = mojuan_core::crawler::registry::last_error(source) {
                eprintln!("源错误: {msg}");
            }
            0
        }
        [cmd, source, comic_id, chapter_index] if cmd == "chain" => {
            if !install_source(source) {
                return 2;
            }
            let payload = format!(r#"{{"comicId":"{comic_id}"}}"#);
            let detail = mojuan_core::crawl("detail", source, &payload, "");
            if let Some((msg, _)) = mojuan_core::crawler::registry::last_error(source) {
                eprintln!("detail 源错误: {msg}");
                return 1;
            }
            println!("detail: {}", summarize_detail(&detail));
            let payload = format!(r#"{{"comicId":"{comic_id}","chapterIndex":{chapter_index}}}"#);
            let images = mojuan_core::crawl("images", source, &payload, "");
            if let Some((msg, _)) = mojuan_core::crawler::registry::last_error(source) {
                eprintln!("images 源错误: {msg}");
                return 1;
            }
            println!("images: {}", summarize_images(&images));
            0
        }
        _ => {
            eprintln!("用法:");
            eprintln!("  cargo run --example render_probe -- dump <url> <outfile>");
            eprintln!("  cargo run --example render_probe -- crawl <source> <op> <payload-json>");
            eprintln!("  cargo run --example render_probe -- chain <source> <comicId> <chapterIndex>");
            2
        }
    }
}

/// 把该源的文档从仓库里装进注册表（探针不带前端，源由这里装）。
fn install_source(source: &str) -> bool {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../crates/mojuan-core/src/js/sources")
        .join(format!("{source}.json"));
    let Ok(document) = std::fs::read_to_string(&path) else {
        eprintln!("源文档不存在: {}", path.display());
        return false;
    };
    let outcome = mojuan_core::crawler::registry::sync(mojuan_core::crawler::registry::SyncPayload {
        runtime: None,
        sources: vec![mojuan_core::crawler::registry::SyncSource {
            id: source.to_string(),
            document,
        }],
    });
    if let Some((id, reason)) = outcome.rejected.into_iter().next() {
        eprintln!("源文档校验失败 {id}: {reason}");
        return false;
    }
    true
}

/// detail 摘要：标题/章节数/首末章 + 隐藏字段 pageUrl 已被 post_process 剥离。
fn summarize_detail(json: &str) -> String {
    let v: serde_json::Value = match serde_json::from_str(json) {
        Ok(v) => v,
        Err(_) => return format!("JSON 解析失败: {}", json.chars().take(200).collect::<String>()),
    };
    let title = v.pointer("/comic/title").and_then(|t| t.as_str()).unwrap_or("");
    let chapters = v
        .get("chapters")
        .and_then(|c| c.as_array())
        .cloned()
        .unwrap_or_default();
    let first = chapters
        .first()
        .and_then(|c| c.get("title"))
        .and_then(|t| t.as_str())
        .unwrap_or("");
    let last = chapters
        .last()
        .and_then(|c| c.get("title"))
        .and_then(|t| t.as_str())
        .unwrap_or("");
    let leaked = chapters
        .first()
        .map(|c| c.get("pageUrl").is_some())
        .unwrap_or(false);
    format!(
        "title={title} chapters={} first={first} last={last} pageUrl 泄漏={leaked}",
        chapters.len()
    )
}

/// images 摘要：图片数 + 首图。
fn summarize_images(json: &str) -> String {
    let v: serde_json::Value = match serde_json::from_str(json) {
        Ok(v) => v,
        Err(_) => return format!("JSON 解析失败: {}", json.chars().take(200).collect::<String>()),
    };
    let urls = v.as_array().cloned().unwrap_or_default();
    let first = urls
        .first()
        .and_then(|u| u.as_str())
        .unwrap_or("");
    format!("count={} first={first}", urls.len())
}

