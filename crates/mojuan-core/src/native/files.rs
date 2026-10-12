//! 本地下载 / 文件 IO（移植自旧 DownloadModule / LocalModule）。
//! 目录路径由原生侧传入（Android getExternalFilesDir/download，iOS Documents/download）。
//! 下载布局（wayfinder #19 定案）：`<dir>/<source>/<comicId>/chapter_<n>/<page>.<ext>`；
//! 「本地」tab 扫描兼容旧扁平布局（顶层目录直接含 chapter_* → source 记 "local"）。

use crate::crawler::http;
use crate::native::download_index;
use crate::native::paths::{comic_dir, FLAT_SOURCE};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

const CHROME_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

fn chapter_dir_name(index: i64) -> String {
    format!("chapter_{}", index)
}

fn chapter_index_from_dir_name(name: &str) -> Option<i64> {
    name.strip_prefix("chapter_")?.parse().ok()
}

/// 取 URL 最后一个 '.' 后的后缀（最多 5 字符，无 '.' 时回退 "jpg"），对应 Kotlin substringAfterLast('.', "jpg").take(5)。
fn extension_from_url(url: &str) -> String {
    let after = match url.rfind('.') {
        Some(i) => &url[i + 1..],
        None => "jpg",
    };
    let taken: String = after.chars().take(5).collect();
    if taken.is_empty() {
        "jpg".to_string()
    } else {
        taken
    }
}

/// 该章节是否已在磁盘（下载队列去重：入队即 done，grilling #22 #4）。
/// 章节目录存在且至少含一个文件才算已下载。
pub fn chapter_downloaded(dir: &str, source: &str, comic_id: &str, chapter_index: i64) -> bool {
    let chapter = comic_dir(dir, source, comic_id).join(chapter_dir_name(chapter_index));
    match fs::read_dir(&chapter) {
        Ok(mut it) => it.by_ref().any(|e| e.is_ok()),
        Err(_) => false,
    }
}

/// 下载单张图片到 `<dir>/<source>/<comicId>/chapter_<n>/<page>.<ext>`。
/// referer 非空时带上（热链域如 pstatic.net 需要，research #4）；失败返回原因（HTTP 状态、写盘错误）。
/// 成功后记录 url → 相对路径到下载索引（wayfinder #31：离线也传 url）。
pub fn download_image(
    url: &str,
    dir: &str,
    source: &str,
    comic_id: &str,
    chapter_index: i64,
    page_index: i64,
    referer: &str,
) -> Result<(), String> {
    let mut headers: Vec<(&str, &str)> = vec![("User-Agent", CHROME_UA)];
    if !referer.is_empty() {
        headers.push(("Referer", referer));
    }
    let bytes = http::get_bytes(url, &headers)?;
    let chapter_dir = comic_dir(dir, source, comic_id).join(chapter_dir_name(chapter_index));
    fs::create_dir_all(&chapter_dir)
        .map_err(|e| format!("创建 {} 失败: {e}", chapter_dir.display()))?;
    let file = chapter_dir.join(format!("{}.{}", page_index, extension_from_url(url)));
    fs::write(&file, bytes).map_err(|e| format!("写入 {} 失败: {e}", file.display()))?;
    // 记录下载索引（相对路径：chapter_<n>/<file>）
    let rel = format!("{}/{}", chapter_dir_name(chapter_index), file.file_name().unwrap().to_string_lossy());
    let _ = download_index::record_download(dir, source, comic_id, url, &rel);
    Ok(())
}

/// 已下载章节文件列表：`{chapterIndex: [{"url": "...", "path": "relative/path"}]}`（按文件名排序）。
/// 包含 url 字段供离线阅读器直接传 url 调用 img_proxy（wayfinder #31）；旧数据无索引时 url 为空字符串。
pub fn list_downloaded(dir: &str, source: &str, comic_id: &str) -> String {
    download_index::list_downloaded_with_urls(dir, source, comic_id)
}

/// 该目录下的章节目录数（仅 chapter_* 前缀）。
fn chapter_count(comic_path: &Path) -> i64 {
    fs::read_dir(comic_path)
        .map(|it| {
            it.flatten()
                .filter(|e| e.path().is_dir())
                .filter(|e| chapter_index_from_dir_name(&e.file_name().to_string_lossy()).is_some())
                .count() as i64
        })
        .unwrap_or(0)
}

/// 扫描本地已下载漫画：`[{source, comicId, chapterCount}]`。
/// 兼容两种布局：命名空间 `<dir>/<source>/<comicId>/…` 与旧扁平 `<dir>/<comicId>/…`
/// （扁平条目 source = "local"，wayfinder #19）。
pub fn scan_local(dir: &str) -> String {
    let base = Path::new(dir);
    let mut arr = Vec::new();
    if let Ok(entries) = fs::read_dir(base) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            // 顶层目录直接含 chapter_* → 扁平漫画
            if chapter_count(&path) > 0 {
                arr.push(json!({ "source": FLAT_SOURCE, "comicId": name, "chapterCount": chapter_count(&path) }));
                continue;
            }
            // 否则按 source 层递归一层：子目录含 chapter_* → 命名空间漫画
            if let Ok(children) = fs::read_dir(&path) {
                for child in children.flatten() {
                    let child_path = child.path();
                    if !child_path.is_dir() {
                        continue;
                    }
                    let count = chapter_count(&child_path);
                    if count > 0 {
                        arr.push(json!({
                            "source": name,
                            "comicId": child.file_name().to_string_lossy().to_string(),
                            "chapterCount": count,
                        }));
                    }
                }
            }
        }
    }
    Value::Array(arr).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mojuan-test-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn extension_from_url_matches_kotlin() {
        assert_eq!(extension_from_url("https://x/a.jpg?type=q90"), "jpg?t");
        assert_eq!(extension_from_url("https://x/a.png"), "png");
        assert_eq!(extension_from_url("https://x/novalue"), "jpg");
    }

    #[test]
    fn scan_namespaced_and_flat_layouts() {
        let dir = temp_dir("scan2");
        // 命名空间：webtoons/comic-a 有 chapter_1/chapter_2，mangadex/comic-b 有 chapter_3
        fs::create_dir_all(dir.join("webtoons").join("comic-a").join("chapter_1")).unwrap();
        fs::create_dir_all(dir.join("webtoons").join("comic-a").join("chapter_2")).unwrap();
        fs::create_dir_all(dir.join("mangadex").join("comic-b").join("chapter_3")).unwrap();
        fs::write(dir.join("webtoons").join("comic-a").join("chapter_1").join("0.jpg"), b"x").unwrap();
        // 非 chapter_ 前缀目录不计
        fs::create_dir_all(dir.join("webtoons").join("comic-a").join("misc")).unwrap();
        // 扁平：comic-c 直接含 chapter_4
        fs::create_dir_all(dir.join("comic-c").join("chapter_4")).unwrap();
        fs::write(dir.join("comic-c").join("chapter_4").join("0.webp"), b"y").unwrap();

        let scanned: Vec<Value> = serde_json::from_str(&scan_local(dir.to_str().unwrap())).unwrap();
        let norm = |v: &Value| {
            format!(
                "{}:{}",
                v["source"].as_str().unwrap(),
                v["comicId"].as_str().unwrap()
            )
        };
        let mut keys: Vec<String> = scanned.iter().map(norm).collect();
        keys.sort();
        assert_eq!(
            keys,
            vec!["local:comic-c", "mangadex:comic-b", "webtoons:comic-a"]
        );
        let a = scanned.iter().find(|v| v["comicId"] == "comic-a").unwrap();
        assert_eq!(a["chapterCount"], 2); // misc 不计
        let c = scanned.iter().find(|v| v["comicId"] == "comic-c").unwrap();
        assert_eq!(c["source"], "local");
        assert_eq!(c["chapterCount"], 1);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_downloaded_resolves_namespace_and_flat() {
        let dir = temp_dir("list2");
        fs::create_dir_all(dir.join("webtoons").join("comic-a").join("chapter_1")).unwrap();
        fs::write(dir.join("webtoons").join("comic-a").join("chapter_1").join("0.jpg"), b"x").unwrap();
        fs::create_dir_all(dir.join("comic-c").join("chapter_4")).unwrap();
        fs::write(dir.join("comic-c").join("chapter_4").join("0.webp"), b"y").unwrap();

        let listed: Value = serde_json::from_str(&list_downloaded(dir.to_str().unwrap(), "webtoons", "comic-a")).unwrap();
        // 新格式：[{ "url": "", "path": "chapter_1/0.jpg" }]
        assert_eq!(listed["1"].as_array().unwrap().len(), 1);
        assert_eq!(listed["1"][0]["path"], "chapter_1/0.jpg");
        // 命名空间下找不到扁平路径
        assert!(serde_json::from_str::<Value>(&list_downloaded(dir.to_str().unwrap(), "mangadex", "comic-a")).unwrap().as_object().unwrap().is_empty());

        let flat: Value = serde_json::from_str(&list_downloaded(dir.to_str().unwrap(), "local", "comic-c")).unwrap();
        assert_eq!(flat["4"].as_array().unwrap().len(), 1);
        assert_eq!(flat["4"][0]["path"], "chapter_4/0.webp");

        let _ = fs::remove_dir_all(&dir);
    }
}
