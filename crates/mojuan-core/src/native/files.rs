//! 本地下载 / 文件 IO（移植自旧 DownloadModule / LocalModule）。
//! 目录路径由原生侧传入（Android getExternalFilesDir/download，iOS Documents/download）。
//! 下载布局（wayfinder #19 定案）：`<dir>/<source>/<comicId>/chapter_<n>/<page>.<ext>`；
//! 扫描兼容旧扁平布局（顶层目录直接含 chapter_* → source 记 "local"）。

use crate::crawler::http;
use crate::native::comic_meta;
use crate::native::download_index;
use crate::native::paths::{comic_dir, FLAT_SOURCE};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

const CHROME_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

fn chapter_dir_name(index: i64) -> String {
    format!("chapter_{}", index)
}

pub(crate) fn chapter_index_from_dir_name(name: &str) -> Option<i64> {
    name.strip_prefix("chapter_")?.parse().ok()
}

/// 一话的目录（`<dir>/<source>/<comicId>/chapter_<n>`）。
pub(crate) fn chapter_dir(dir: &str, source: &str, comic_id: &str, chapter_index: i64) -> PathBuf {
    comic_dir(dir, source, comic_id).join(chapter_dir_name(chapter_index))
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
/// 章节目录存在且至少含一个页文件才算已下载；页清单（`.pages.json`）是元数据，
/// 只有它、没有页的话不算已下载。
pub fn chapter_downloaded(dir: &str, source: &str, comic_id: &str, chapter_index: i64) -> bool {
    match fs::read_dir(chapter_dir(dir, source, comic_id, chapter_index)) {
        Ok(entries) => entries
            .flatten()
            .any(|e| !e.file_name().to_string_lossy().starts_with('.')),
        Err(_) => false,
    }
}

/// 页文件在作品目录下的相对路径（`chapter_<n>/<页号>.<扩展名>`）。
/// 下载落盘与下载索引记录共用这一份命名规则。
pub fn page_rel_path(chapter_index: i64, page_index: i64, url: &str) -> String {
    format!(
        "{}/{}.{}",
        chapter_dir_name(chapter_index),
        page_index,
        extension_from_url(url)
    )
}

/// 下载单张图片到 `<dir>/<source>/<comicId>/chapter_<n>/<page>.<ext>`。
/// referer 非空时带上（热链域如 pstatic.net 需要，research #4）；失败返回原因（HTTP 状态、写盘错误）。
/// 响应不是图片（Content-Type 既不是 `image/*` 也不以 `octet-stream` 结尾）时判这一页失败、
/// 不写磁盘：站点的错误页因此不会以 `.jpg` 的名字进库。
/// 下载索引由下载运行时在整话结束时一次写入（`download_index::record_downloads`）。
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
    let (bytes, content_type) = http::get_bytes_with_type(url, &headers)?;
    if !is_image_content_type(&content_type) {
        return Err(format!(
            "站点返回的不是图片（Content-Type: {content_type}）"
        ));
    }
    let file = comic_dir(dir, source, comic_id).join(page_rel_path(chapter_index, page_index, url));
    let parent = file.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(|e| format!("创建 {} 失败: {e}", parent.display()))?;
    fs::write(&file, bytes).map_err(|e| format!("写入 {} 失败: {e}", file.display()))?;
    Ok(())
}

/// Content-Type 是否为图片：媒体类型是 `image/*` 或以 `octet-stream` 结尾（带参数时看分号前）。
fn is_image_content_type(content_type: &str) -> bool {
    let media = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    media.starts_with("image/") || media.ends_with("octet-stream")
}

/// 已下载章节文件列表：`{chapterIndex: [{"url": "...", "path": "relative/path"}]}`（按文件名排序）。
/// 包含 url 字段供离线阅读器直接传 url 调用 img_proxy（wayfinder #31）；旧数据无索引时 url 为空字符串。
pub fn list_downloaded(dir: &str, source: &str, comic_id: &str) -> String {
    download_index::list_downloaded_with_urls(dir, source, comic_id)
}

/// 一部作品的元数据 JSON（书架「下载」展开时取各话的真实标题）。没有这份元数据返回 `null`。
pub fn read_comic_meta(dir: &str, source: &str, comic_id: &str) -> String {
    match comic_meta::read(dir, source, comic_id) {
        Some(meta) => serde_json::to_string(&meta).unwrap_or_else(|_| "null".to_string()),
        None => "null".to_string(),
    }
}

/// 删除某漫画的下载：整目录（含下载索引与全部章节）。
/// 目标由 `comic_dir` 唯一决定，必须严格落在下载目录之内，否则拒绝；
/// 目录本就不存在返回 `Ok(false)`。
pub fn delete_downloaded(dir: &str, source: &str, comic_id: &str) -> Result<bool, String> {
    let base = Path::new(dir);
    let target = comic_dir(dir, source, comic_id);
    if dir.is_empty()
        || source.is_empty()
        || comic_id.is_empty()
        || target == base
        || !target.starts_with(base)
    {
        return Err(format!("拒绝删除 {}：不在下载目录内", target.display()));
    }
    match fs::remove_dir_all(&target) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("删除 {} 失败: {e}", target.display())),
    }
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

/// 扫描本地已下载漫画：`[{source, comicId, chapterCount, title, cover}]`。
/// 兼容两种布局：命名空间 `<dir>/<source>/<comicId>/…` 与旧扁平 `<dir>/<comicId>/…`
/// （扁平条目 source = "local"，wayfinder #19）。
/// 标题与封面来自该作品目录下的 `comic.json`（下载入队时写入）；旧下载没有这份
/// 元数据，两个字段为空串，消费方回落到 comicId。
pub fn scan_local(dir: &str) -> String {
    let base = Path::new(dir);
    let mut arr = Vec::new();
    for path in comic_dirs(dir) {
        // 扁平条目落在下载目录的下一层：它的父目录就是下载目录本身
        let source = match path.parent() {
            Some(parent) if parent != base => {
                parent.file_name().map(|n| n.to_string_lossy().into_owned())
            }
            _ => Some(FLAT_SOURCE.to_string()),
        }
        .unwrap_or_default();
        let comic_id = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let meta = comic_meta::read(dir, &source, &comic_id);
        arr.push(json!({
            "source": source,
            "comicId": comic_id,
            "chapterCount": chapter_count(&path),
            "title": meta.as_ref().map(|m| m.title.clone()).unwrap_or_default(),
            "cover": meta.as_ref().map(|m| m.cover.clone()).unwrap_or_default(),
        }));
    }
    Value::Array(arr).to_string()
}

/// 下载目录下的作品目录（含 `chapter_*` 的目录），命名空间与扁平两种布局都算。
/// `scan_local` 与 `download_usage` 共用这一份判定。
fn comic_dirs(dir: &str) -> Vec<PathBuf> {
    let base = Path::new(dir);
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(base) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        // 顶层目录直接含 chapter_* → 扁平漫画
        if chapter_count(&path) > 0 {
            out.push(path);
            continue;
        }
        // 否则按 source 层递归一层：子目录含 chapter_* → 命名空间漫画
        if let Ok(children) = fs::read_dir(&path) {
            for child in children.flatten() {
                let child_path = child.path();
                if child_path.is_dir() && chapter_count(&child_path) > 0 {
                    out.push(child_path);
                }
            }
        }
    }
    out
}

/// 目录下全部文件（递归）的字节数；读不到按 0 计。
fn dir_size(path: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    let mut total = 0u64;
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            total += dir_size(&p);
        } else if let Ok(meta) = entry.metadata() {
            total += meta.len();
        }
    }
    total
}

/// 下载占用：整棵下载目录的字节数与作品数（作品判定与 `scan_local` 一致）。只读本地文件。
pub fn download_usage(dir: &str) -> (u64, usize) {
    let comics = comic_dirs(dir);
    let bytes = comics.iter().map(|path| dir_size(path)).sum();
    (bytes, comics.len())
}

/// 该作品的页文件数：各 `chapter_*` 目录的直接子文件，点开头的元数据文件不算页
/// （与 `list_downloaded_with_urls` 同一口径）。
fn page_count(comic_path: &Path) -> usize {
    let Ok(entries) = fs::read_dir(comic_path) else {
        return 0;
    };
    let mut total = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if chapter_index_from_dir_name(&name).is_none() {
            continue;
        }
        let Ok(files) = fs::read_dir(entry.path()) else {
            continue;
        };
        total += files
            .flatten()
            .filter(|f| f.path().is_file() && !f.file_name().to_string_lossy().starts_with('.'))
            .count();
    }
    total
}

/// 按作品列出下载占用：`[{source, comicId, title, cover, chapters, pages, bytes}]`。
/// `title` 与 `cover` 取自作品目录里的 `comic.json`（没有就空串）；`chapters` 是 `chapter_*`
/// 目录数；`pages` 是全部页文件数；`bytes` 是整部作品目录的递归字节数（含页清单等元数据文件）。
/// 作品判定复用 `comic_dirs`，命名空间与扁平两种布局都算。只读本地文件。
pub fn download_comics(dir: &str) -> String {
    let base = Path::new(dir);
    let mut arr = Vec::new();
    for path in comic_dirs(dir) {
        // 扁平条目落在下载目录的下一层：它的父目录就是下载目录本身
        let source = match path.parent() {
            Some(parent) if parent != base => {
                parent.file_name().map(|n| n.to_string_lossy().into_owned())
            }
            _ => Some(FLAT_SOURCE.to_string()),
        }
        .unwrap_or_default();
        let comic_id = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let meta = comic_meta::read(dir, &source, &comic_id);
        arr.push(json!({
            "source": source,
            "comicId": comic_id,
            "title": meta.as_ref().map(|m| m.title.clone()).unwrap_or_default(),
            "cover": meta.as_ref().map(|m| m.cover.clone()).unwrap_or_default(),
            "chapters": chapter_count(&path),
            "pages": page_count(&path),
            "bytes": dir_size(&path),
        }));
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
        fs::write(
            dir.join("webtoons")
                .join("comic-a")
                .join("chapter_1")
                .join("0.jpg"),
            b"x",
        )
        .unwrap();
        // 非 chapter_ 前缀目录不计
        fs::create_dir_all(dir.join("webtoons").join("comic-a").join("misc")).unwrap();
        // 扁平：comic-c 直接含 chapter_4
        fs::create_dir_all(dir.join("comic-c").join("chapter_4")).unwrap();
        fs::write(dir.join("comic-c").join("chapter_4").join("0.webp"), b"y").unwrap();
        // comic-a 有作品元数据，comic-b 没有（旧下载）
        comic_meta::record_chapter(
            dir.to_str().unwrap(),
            "webtoons",
            "comic-a",
            "作品甲",
            "https://x/a.jpg",
            1,
            "第 1 话",
        );

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
        assert_eq!(a["title"], "作品甲");
        assert_eq!(a["cover"], "https://x/a.jpg");
        let b = scanned.iter().find(|v| v["comicId"] == "comic-b").unwrap();
        assert_eq!(b["title"], ""); // 没有元数据：空串，消费方回落到 comicId
        assert_eq!(b["cover"], "");
        let c = scanned.iter().find(|v| v["comicId"] == "comic-c").unwrap();
        assert_eq!(c["source"], "local");
        assert_eq!(c["chapterCount"], 1);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_comic_meta_returns_null_without_metadata() {
        let dir = temp_dir("meta-json");
        fs::create_dir_all(dir.join("webtoons").join("comic-a").join("chapter_1")).unwrap();
        assert_eq!(
            read_comic_meta(dir.to_str().unwrap(), "webtoons", "comic-a"),
            "null"
        );

        comic_meta::record_chapter(
            dir.to_str().unwrap(),
            "webtoons",
            "comic-a",
            "作品甲",
            "",
            7,
            "第 7 话",
        );
        let meta: Value = serde_json::from_str(&read_comic_meta(
            dir.to_str().unwrap(),
            "webtoons",
            "comic-a",
        ))
        .unwrap();
        assert_eq!(meta["title"], "作品甲");
        assert_eq!(meta["chapters"]["7"], "第 7 话");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_downloaded_resolves_namespace_and_flat() {
        let dir = temp_dir("list2");
        fs::create_dir_all(dir.join("webtoons").join("comic-a").join("chapter_1")).unwrap();
        fs::write(
            dir.join("webtoons")
                .join("comic-a")
                .join("chapter_1")
                .join("0.jpg"),
            b"x",
        )
        .unwrap();
        fs::create_dir_all(dir.join("comic-c").join("chapter_4")).unwrap();
        fs::write(dir.join("comic-c").join("chapter_4").join("0.webp"), b"y").unwrap();

        let listed: Value = serde_json::from_str(&list_downloaded(
            dir.to_str().unwrap(),
            "webtoons",
            "comic-a",
        ))
        .unwrap();
        // 新格式：[{ "url": "", "path": "chapter_1/0.jpg" }]
        assert_eq!(listed["1"].as_array().unwrap().len(), 1);
        assert_eq!(listed["1"][0]["path"], "chapter_1/0.jpg");
        // 命名空间下找不到扁平路径
        assert!(serde_json::from_str::<Value>(&list_downloaded(
            dir.to_str().unwrap(),
            "mangadex",
            "comic-a"
        ))
        .unwrap()
        .as_object()
        .unwrap()
        .is_empty());

        let flat: Value =
            serde_json::from_str(&list_downloaded(dir.to_str().unwrap(), "local", "comic-c"))
                .unwrap();
        assert_eq!(flat["4"].as_array().unwrap().len(), 1);
        assert_eq!(flat["4"][0]["path"], "chapter_4/0.webp");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_downloaded_removes_only_that_comic() {
        let dir = temp_dir("delete");
        let base = dir.to_str().unwrap();
        fs::create_dir_all(dir.join("webtoons").join("comic-a").join("chapter_1")).unwrap();
        fs::write(
            dir.join("webtoons")
                .join("comic-a")
                .join("chapter_1")
                .join("0.jpg"),
            b"x",
        )
        .unwrap();
        fs::create_dir_all(dir.join("webtoons").join("comic-b").join("chapter_1")).unwrap();
        fs::create_dir_all(dir.join("comic-c").join("chapter_4")).unwrap();

        assert_eq!(delete_downloaded(base, "webtoons", "comic-a"), Ok(true));
        assert!(!dir.join("webtoons").join("comic-a").exists());
        assert!(dir.join("webtoons").join("comic-b").exists());
        assert!(dir.join("comic-c").exists());
        // 已删过的目录再删一次：没有可删的东西，不是错误
        assert_eq!(delete_downloaded(base, "webtoons", "comic-a"), Ok(false));

        // 扁平条目（source = "local"）落在下载目录的下一层
        assert_eq!(delete_downloaded(base, "local", "comic-c"), Ok(true));
        assert!(!dir.join("comic-c").exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_downloaded_refuses_paths_outside_the_download_dir() {
        let dir = temp_dir("delete-guard");
        let base = dir.to_str().unwrap();
        fs::create_dir_all(&dir).unwrap();

        assert!(delete_downloaded(base, "webtoons", "").is_err());
        assert!(delete_downloaded(base, "", "comic-a").is_err());
        assert!(delete_downloaded("", "webtoons", "comic-a").is_err());
        assert!(dir.exists());

        let _ = fs::remove_dir_all(&dir);
    }

    /// 下载占用：命名空间与扁平两种布局的作品都算，字节数递归统计全部文件；
    /// 不含 `chapter_*` 的目录不算作品。
    #[test]
    fn download_usage_sums_bytes_and_counts_comics() {
        let dir = temp_dir("usage");
        fs::create_dir_all(dir.join("webtoons").join("comic-a").join("chapter_1")).unwrap();
        fs::write(
            dir.join("webtoons")
                .join("comic-a")
                .join("chapter_1")
                .join("0.jpg"),
            vec![0u8; 10],
        )
        .unwrap();
        fs::create_dir_all(dir.join("webtoons").join("comic-a").join("chapter_2")).unwrap();
        fs::write(
            dir.join("webtoons")
                .join("comic-a")
                .join("chapter_2")
                .join("0.jpg"),
            vec![0u8; 20],
        )
        .unwrap();
        fs::create_dir_all(dir.join("comic-b").join("chapter_1")).unwrap();
        fs::write(
            dir.join("comic-b").join("chapter_1").join("0.jpg"),
            vec![0u8; 5],
        )
        .unwrap();
        // 没有 chapter_* 的目录不算作品，它的文件也不计
        fs::create_dir_all(dir.join("mangadex").join("comic-c").join("misc")).unwrap();
        fs::write(
            dir.join("mangadex")
                .join("comic-c")
                .join("misc")
                .join("x.bin"),
            vec![0u8; 99],
        )
        .unwrap();

        assert_eq!(download_usage(dir.to_str().unwrap()), (35, 2));

        let _ = fs::remove_dir_all(&dir);
    }

    /// 按作品列出占用：字节数（递归，含页清单等元数据文件）、话数与页数都对；
    /// 标题与封面取自 `comic.json`；点开头的元数据文件不算页；没有 chapter_* 的目录不算作品。
    #[test]
    fn download_comics_lists_each_comic_with_its_occupancy() {
        let dir = temp_dir("comics");
        let base = dir.to_str().unwrap();
        let comic_a = dir.join("webtoons").join("comic-a");
        let chapter1 = comic_a.join("chapter_1");
        let chapter2 = comic_a.join("chapter_2");
        fs::create_dir_all(&chapter1).unwrap();
        fs::create_dir_all(&chapter2).unwrap();
        fs::write(chapter1.join("0.jpg"), vec![0u8; 10]).unwrap();
        fs::write(chapter1.join("1.jpg"), vec![0u8; 20]).unwrap();
        fs::write(chapter1.join(".pages.json"), vec![0u8; 7]).unwrap();
        fs::write(chapter2.join("0.jpg"), vec![0u8; 30]).unwrap();
        comic_meta::record_chapter(
            base,
            "webtoons",
            "comic-a",
            "作品甲",
            "https://x/a.jpg",
            1,
            "第 1 话",
        );

        // 扁平布局的旧下载：没有 comic.json，标题与封面为空串
        let flat = dir.join("comic-b").join("chapter_3");
        fs::create_dir_all(&flat).unwrap();
        fs::write(flat.join("0.webp"), vec![0u8; 5]).unwrap();

        // 没有 chapter_* 的目录不算作品，它的文件也不计
        fs::create_dir_all(dir.join("mangadex").join("comic-c").join("misc")).unwrap();
        fs::write(
            dir.join("mangadex")
                .join("comic-c")
                .join("misc")
                .join("x.bin"),
            vec![0u8; 99],
        )
        .unwrap();

        let listed: Vec<Value> = serde_json::from_str(&download_comics(base)).unwrap();
        let mut keys: Vec<String> = listed
            .iter()
            .map(|v| {
                format!(
                    "{}:{}",
                    v["source"].as_str().unwrap(),
                    v["comicId"].as_str().unwrap()
                )
            })
            .collect();
        keys.sort();
        assert_eq!(keys, vec!["local:comic-b", "webtoons:comic-a"]);

        // 期望字节数从磁盘上的实际文件算出（含写进作品目录的 comic.json）
        let expected_a: u64 = [
            "chapter_1/0.jpg",
            "chapter_1/1.jpg",
            "chapter_1/.pages.json",
            "chapter_2/0.jpg",
            "comic.json",
        ]
        .iter()
        .map(|rel| fs::metadata(comic_a.join(rel)).unwrap().len())
        .sum();

        let a = listed.iter().find(|v| v["comicId"] == "comic-a").unwrap();
        assert_eq!(a["title"], "作品甲");
        assert_eq!(a["cover"], "https://x/a.jpg");
        assert_eq!(a["chapters"], 2);
        assert_eq!(a["pages"], 3); // .pages.json 不算页
        assert_eq!(a["bytes"], expected_a);

        let b = listed.iter().find(|v| v["comicId"] == "comic-b").unwrap();
        assert_eq!(b["source"], "local");
        assert_eq!(b["title"], "");
        assert_eq!(b["cover"], "");
        assert_eq!(b["chapters"], 1);
        assert_eq!(b["pages"], 1);
        assert_eq!(b["bytes"], 5);

        let _ = fs::remove_dir_all(&dir);
    }

    /// 极简 HTTP 服务器：任何路径都返回同一份体与给定的 Content-Type。
    fn spawn_server(content_type: &'static str, body: &'static [u8]) -> u16 {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming().take(4) {
                let Ok(mut stream) = stream else { break };
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf);
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(body);
                let _ = stream.flush();
            }
        });
        port
    }

    #[test]
    fn download_image_rejects_a_non_image_content_type() {
        let port = spawn_server("text/html", b"<html>nope</html>");
        let dir = temp_dir("content-type");
        let base = dir.to_str().unwrap();
        let url = format!("http://127.0.0.1:{port}/0.jpg");

        let err = download_image(&url, base, "webtoons", "c1", 1, 0, "").unwrap_err();
        assert!(
            err.contains("text/html"),
            "错误原因要可读并带上 Content-Type：{err}"
        );
        // 磁盘上不能留下文件（更不能用 .jpg 的名字把错误页存下来）
        assert!(!dir
            .join("webtoons")
            .join("c1")
            .join("chapter_1")
            .join("0.jpg")
            .exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn download_image_accepts_an_octet_stream_content_type() {
        let port = spawn_server("application/octet-stream", b"bytes");
        let dir = temp_dir("octet");
        let base = dir.to_str().unwrap();
        let url = format!("http://127.0.0.1:{port}/0.jpg");

        assert_eq!(
            download_image(&url, base, "webtoons", "c1", 1, 0, ""),
            Ok(())
        );
        assert_eq!(
            fs::read(
                dir.join("webtoons")
                    .join("c1")
                    .join("chapter_1")
                    .join("0.jpg")
            )
            .unwrap(),
            b"bytes"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn chapter_downloaded_ignores_dot_files() {
        let dir = temp_dir("downloaded-dot");
        let base = dir.to_str().unwrap();
        let chapter = chapter_dir(base, "webtoons", "c1", 1);
        fs::create_dir_all(&chapter).unwrap();

        // 只有页清单：没有页，不算已下载
        fs::write(chapter.join(".pages.json"), b"{}").unwrap();
        assert!(!chapter_downloaded(base, "webtoons", "c1", 1));
        // 有一页 → 已下载
        fs::write(chapter.join("0.jpg"), b"x").unwrap();
        assert!(chapter_downloaded(base, "webtoons", "c1", 1));

        let _ = fs::remove_dir_all(&dir);
    }
}
