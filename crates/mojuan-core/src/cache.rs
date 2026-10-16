//! 热链图片代理缓存：URL 维度内存 LRU + 磁盘持久化。
//!
//! 桌面 webview 无法为 `<img>` 注入 Referer（research #4），热链域图片经本机 HTTP 代理
//! （`img_proxy` 的 127.0.0.1 /img 端点）进入这里：带 Referer 取图（复用 `crawler::http`
//! 的共享 reqwest 客户端），按 URL 哈希落盘，并维持一个有界内存 LRU，避免重复网络请求。
//! 代理响应不经过 webview HTTP 缓存，命中/落盘语义由本模块自行承担。
//!
//! 磁盘层有容量上限：每次取图（内存命中与磁盘命中都算）把该条目 `.img` 的修改时间更新为
//! 现在，淘汰时按它从旧到新删；`.img` 与配对的 `.meta` 一起删。

use crate::crawler::http;
use crate::util::{self, Lru};
use base64::Engine;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::SystemTime;

/// 内存 LRU 上限（条数级；逐出后下次回落到磁盘缓存）。
const LRU_CAP: usize = 128;

type Entry = (Vec<u8>, String); // (bytes, content_type)

static LRU: LazyLock<Lru<String, Entry>> = LazyLock::new(|| Lru::new(LRU_CAP));

/// 并发去重槽 + 在途表：同一 URL 的下载只发起一次，其余调用方（并发请求 / 前端
/// 失败重试）在槽上等待同一结果。移动端 webview 对慢速自定义 scheme 请求有硬性
/// 超时/取消（研究 #31），重试若各自再下载会重复拉取大图、且更难在拦截超时窗口
/// 内返回；共享下载让后续请求在首次落盘后立即拿到缓存结果。
type Slot = Arc<Mutex<Option<Result<Entry, String>>>>;
static IN_FLIGHT: LazyLock<Mutex<HashMap<String, Slot>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 磁盘容量上限（字节；0 表示不限制）。前端启动时推入，设置页改动时更新。
static LIMIT: AtomicU64 = AtomicU64::new(0);

/// 上次整理之后又写入了多少字节。累计超过上限的 5% 就跑一次整理（`set_limit` 与每次
/// 整理之后归零）。上限为 0 时这个计数器没有意义，不会被读取。
static WRITTEN: AtomicU64 = AtomicU64::new(0);

/// 热链图片取图：内存 LRU → 磁盘缓存 → 网络（带 Referer），命中网络后写回缓存。
/// 内存命中与磁盘命中都刷新该条目磁盘文件的修改时间（淘汰按它排序）。
pub fn fetch_image(url: &str, referer: &str, cache_dir: &str) -> Result<Entry, String> {
    let (img_path, meta_path) = cache_paths(cache_dir, url);
    if let Some(entry) = LRU.get(url) {
        touch(&img_path);
        return Ok(entry);
    }
    if let (Ok(bytes), Ok(content_type)) = (
        std::fs::read(&img_path),
        std::fs::read_to_string(&meta_path),
    ) {
        touch(&img_path);
        let entry = (bytes, content_type);
        LRU.put(url.to_string(), entry.clone());
        return Ok(entry);
    }
    let slot = {
        let mut inflight = IN_FLIGHT.lock().unwrap();
        match inflight.get(url) {
            Some(existing) => Arc::clone(existing),
            None => {
                let slot: Slot = Arc::new(Mutex::new(None));
                inflight.insert(url.to_string(), Arc::clone(&slot));
                slot
            }
        }
    };
    // 下载方持槽锁直到落盘，其余调用方在此等待同一结果，不重复下载。
    let mut guard = slot.lock().unwrap();
    let entry = match guard.as_ref() {
        Some(result) => result.clone(),
        None => {
            let result = download_and_cache(url, referer, &img_path, &meta_path);
            *guard = Some(result.clone());
            result
        }
    };
    drop(guard);
    IN_FLIGHT.lock().unwrap().remove(url);
    entry
}

/// 网络取图（带 Referer）→ 落盘（磁盘 + LRU），并按写入量决定要不要整理磁盘。
fn download_and_cache(
    url: &str,
    referer: &str,
    img_path: &Path,
    meta_path: &Path,
) -> Result<Entry, String> {
    let entry = http::get_bytes_with_type(url, &[("Referer", referer)])?;
    if let Some(dir) = img_path.parent() {
        let _ = std::fs::create_dir_all(dir);
        let _ = std::fs::write(img_path, &entry.0);
        let _ = std::fs::write(meta_path, &entry.1);
        account_write(dir, entry.0.len() as u64);
    }
    LRU.put(url.to_string(), entry.clone());
    Ok(entry)
}

/// 记一次写入；自上次整理以来累计写入超过上限的 5% 就跑一次整理。
fn account_write(imgs_dir: &Path, bytes: u64) {
    let written = WRITTEN.fetch_add(bytes, Ordering::Relaxed) + bytes;
    let limit = LIMIT.load(Ordering::Relaxed);
    if limit > 0 && written > limit / 20 {
        compact(imgs_dir, limit);
        WRITTEN.store(0, Ordering::Relaxed);
    }
}

/// 把条目的磁盘文件修改时间更新为现在（淘汰按它排序）；文件不在或更新失败都忽略。
fn touch(img_path: &Path) {
    if let Ok(file) = std::fs::OpenOptions::new().write(true).open(img_path) {
        let _ = file.set_modified(SystemTime::now());
    }
}

/// 设置图片缓存上限（字节；0 表示不限制）并就地跑一次整理。
pub fn set_limit(cache_dir: &str, limit: u64) {
    LIMIT.store(limit, Ordering::Relaxed);
    if limit > 0 {
        compact(&imgs_dir(cache_dir), limit);
    }
    WRITTEN.store(0, Ordering::Relaxed);
}

/// 图片缓存占用：`.img` 的字节数与张数（`.meta` 不计）。
pub fn usage(cache_dir: &str) -> (u64, usize) {
    util::dir_usage(&imgs_dir(cache_dir), "img")
}

/// 清空图片缓存：删掉 `imgs` 下的全部文件并清空内存表。
pub fn clear(cache_dir: &str) {
    util::clear_dir(&imgs_dir(cache_dir));
    LRU.clear();
    WRITTEN.store(0, Ordering::Relaxed);
}

/// 扫 `imgs`、按修改时间从旧到新删到上限以内；`.img` 与配对的 `.meta` 一起删。
/// 只统计 `.img`。内存里的表不动：它持有的字节仍然有效，删除只影响下次回落到磁盘。
fn compact(imgs_dir: &Path, limit: u64) {
    let Ok(entries) = std::fs::read_dir(imgs_dir) else {
        return;
    };
    let mut files: Vec<(SystemTime, u64, PathBuf)> = Vec::new();
    let mut total = 0u64;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("img") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        files.push((modified, meta.len(), path));
        total += meta.len();
    }
    if total <= limit {
        return;
    }
    files.sort_by_key(|(modified, _, _)| *modified);
    for (_, size, path) in files {
        if total <= limit {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(size);
        }
        let _ = std::fs::remove_file(path.with_extension("meta"));
    }
}

fn imgs_dir(cache_dir: &str) -> PathBuf {
    Path::new(cache_dir).join("imgs")
}

fn cache_paths(cache_dir: &str, url: &str) -> (PathBuf, PathBuf) {
    let mut hasher = Sha256::new();
    hasher.update(url.as_bytes());
    let key = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(hasher.finalize());
    let dir = imgs_dir(cache_dir);
    (
        dir.join(format!("{key}.img")),
        dir.join(format!("{key}.meta")),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    /// 取得全进程共用的测试锁，并把上限与写入计数器复位到「不限制」，
    /// 避免上一个用例留下的上限影响这一个。
    fn lock() -> std::sync::MutexGuard<'static, ()> {
        let guard = crate::util::test_lock();
        LIMIT.store(0, Ordering::Relaxed);
        WRITTEN.store(0, Ordering::Relaxed);
        guard
    }

    fn temp_cache_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("mojuan-cache-test-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    /// 极简本地 HTTP 服务器：记录收到的原始请求头，返回固定图片体。
    fn spawn_server(
        body: &'static [u8],
        content_type: &'static str,
    ) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let addr = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(Vec::<String>::new()));
        let reqs = Arc::clone(&requests);
        std::thread::spawn(move || {
            for stream in listener.incoming().take(10) {
                let Ok(mut stream) = stream else { break };
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap_or(0);
                reqs.lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&buf[..n]).to_string());
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    content_type,
                    body.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(body);
                let _ = stream.flush();
            }
        });
        (format!("http://{addr}/img.webp"), requests)
    }

    /// 目录里指定扩展名的第一个文件（缓存文件按 URL 哈希命名，用例不关心具体名字）。
    fn only_file(dir: &Path, ext: &str) -> PathBuf {
        std::fs::read_dir(dir)
            .expect("缓存目录存在")
            .flatten()
            .map(|e| e.path())
            .find(|p| p.extension().and_then(|e| e.to_str()) == Some(ext))
            .expect("缓存文件存在")
    }

    fn set_mtime(path: &Path, at: SystemTime) {
        std::fs::OpenOptions::new()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(at)
            .unwrap();
    }

    /// 直接摆一对磁盘条目（`.img` + `.meta`），并把 `.img` 的修改时间设到指定时刻。
    fn write_pair(imgs: &Path, key: &str, bytes: usize, at: SystemTime) {
        let img = imgs.join(format!("{key}.img"));
        std::fs::write(&img, vec![0u8; bytes]).unwrap();
        std::fs::write(imgs.join(format!("{key}.meta")), "image/png").unwrap();
        set_mtime(&img, at);
    }

    #[test]
    fn cold_fetch_goes_to_network_with_referer_and_persists() {
        let _guard = lock();
        const BODY: &[u8] = b"fake-webp-bytes";
        let (url, requests) = spawn_server(BODY, "image/webp");
        let dir = temp_cache_dir("cold");
        let (bytes, content_type) =
            fetch_image(&url, "https://www.webtoons.com/", dir.to_str().unwrap()).unwrap();
        assert_eq!(bytes, BODY);
        assert_eq!(content_type, "image/webp");
        // reqwest 可能以小写 header 名发送，断言大小写不敏感
        let head = requests.lock().unwrap()[0].to_lowercase();
        assert!(head.contains("referer: https://www.webtoons.com/"));
        // 磁盘缓存：img + meta 两个文件落盘
        assert_eq!(std::fs::read_dir(dir.join("imgs")).unwrap().count(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn repeat_fetch_served_from_lru_without_network() {
        let _guard = lock();
        const BODY: &[u8] = b"lru-bytes";
        let (url, requests) = spawn_server(BODY, "image/png");
        let dir = temp_cache_dir("lru");
        for _ in 0..2 {
            let (bytes, _) = fetch_image(&url, "ref", dir.to_str().unwrap()).unwrap();
            assert_eq!(bytes, BODY);
        }
        assert_eq!(requests.lock().unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn disk_hit_after_lru_clear_avoids_network() {
        let _guard = lock();
        const BODY: &[u8] = b"disk-bytes";
        let (url, requests) = spawn_server(BODY, "image/jpeg");
        let dir = temp_cache_dir("disk");
        fetch_image(&url, "ref", dir.to_str().unwrap()).unwrap();
        // 清空进程内 LRU，验证回落到磁盘缓存而不走网络
        LRU.clear();
        let (bytes, _) = fetch_image(&url, "ref", dir.to_str().unwrap()).unwrap();
        assert_eq!(bytes, BODY);
        assert_eq!(requests.lock().unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 并发/重试同一 URL：只发一次网络请求，其余调用方共享同一下载结果
    /// （研究 #31：移动端 webview 拦截超时后前端重试，需避免重复拉取大图）。
    #[test]
    fn concurrent_fetch_same_url_single_network_request() {
        let _guard = lock();
        const BODY: &[u8] = b"single-flight-bytes";
        // 服务器延迟响应，保证两个调用方同时在途
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let addr = listener.local_addr().unwrap();
        let hits = Arc::new(Mutex::new(0usize));
        let hits2 = Arc::clone(&hits);
        std::thread::spawn(move || {
            for stream in listener.incoming().take(10) {
                let Ok(mut stream) = stream else { break };
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf);
                *hits2.lock().unwrap() += 1;
                std::thread::sleep(std::time::Duration::from_millis(200));
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    BODY.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(BODY);
                let _ = stream.flush();
            }
        });
        let url = format!("http://{addr}/img.png");
        let dir = temp_cache_dir("singleflight");
        let (u1, u2) = (url.clone(), url);
        let (d1, d2) = (
            dir.to_str().unwrap().to_string(),
            dir.to_str().unwrap().to_string(),
        );
        let h1 = std::thread::spawn(move || fetch_image(&u1, "ref", &d1));
        let h2 = std::thread::spawn(move || fetch_image(&u2, "ref", &d2));
        let r1 = h1.join().unwrap().unwrap();
        let r2 = h2.join().unwrap().unwrap();
        assert_eq!(r1.0, BODY);
        assert_eq!(r2.0, BODY);
        assert_eq!(*hits.lock().unwrap(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 磁盘命中之后该条目的修改时间变新（淘汰按它排序，不刷新的话最近看过的也会被删）。
    #[test]
    fn disk_hit_refreshes_mtime() {
        let _guard = lock();
        const BODY: &[u8] = b"touch-bytes";
        let (url, _requests) = spawn_server(BODY, "image/png");
        let dir = temp_cache_dir("touch");
        let d = dir.to_str().unwrap();
        fetch_image(&url, "ref", d).unwrap();

        let img = only_file(&dir.join("imgs"), "img");
        set_mtime(&img, SystemTime::now() - Duration::from_secs(3600));
        let before = std::fs::metadata(&img).unwrap().modified().unwrap();

        LRU.clear(); // 强制走磁盘命中那条路
        fetch_image(&url, "ref", d).unwrap();

        let after = std::fs::metadata(&img).unwrap().modified().unwrap();
        assert!(after > before, "磁盘命中后修改时间应变新");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 占用只统计 `.img` 的字节（`.meta` 不计）。
    #[test]
    fn usage_counts_only_img_bytes() {
        let _guard = lock();
        let dir = temp_cache_dir("usage");
        let imgs = dir.join("imgs");
        std::fs::create_dir_all(&imgs).unwrap();
        std::fs::write(imgs.join("a.img"), vec![0u8; 7]).unwrap();
        std::fs::write(imgs.join("a.meta"), "image/png-这一串不算进占用").unwrap();

        assert_eq!(usage(dir.to_str().unwrap()), (7, 1));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 上限小于当前占用时就地整理：删掉最久没看过的条目，留下最近用的，`.img` 与 `.meta` 成对删。
    #[test]
    fn set_limit_evicts_oldest_until_within_limit() {
        let _guard = lock();
        let dir = temp_cache_dir("evict");
        let imgs = dir.join("imgs");
        std::fs::create_dir_all(&imgs).unwrap();
        let now = SystemTime::now();
        write_pair(&imgs, "oldest", 100, now - Duration::from_secs(3000));
        write_pair(&imgs, "middle", 100, now - Duration::from_secs(2000));
        write_pair(&imgs, "newest", 100, now - Duration::from_secs(1000));

        set_limit(dir.to_str().unwrap(), 150);

        let (bytes, count) = usage(dir.to_str().unwrap());
        assert!(bytes <= 150, "占用应降到上限以内，实际 {bytes}");
        assert_eq!(count, 1, "只留下最近用的那一条");
        assert!(imgs.join("newest.img").exists(), "最近用的条目应留下");
        assert!(!imgs.join("oldest.img").exists(), "最久没看过的应先删");
        assert!(!imgs.join("oldest.meta").exists(), ".img 与 .meta 成对删除");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 写入量累计超过上限的 5% 就整理一次：一直写下去占用不会超过上限。
    #[test]
    fn writes_beyond_the_limit_trigger_compaction() {
        let _guard = lock();
        const BODY: &[u8] = b"0123456789"; // 10 字节
        let (url, _requests) = spawn_server(BODY, "image/png");
        let dir = temp_cache_dir("threshold");
        let d = dir.to_str().unwrap();
        // 上限 30 字节：每次写入 10 字节都超过 5%（1 字节），每次都整理
        set_limit(d, 30);
        for i in 0..4 {
            fetch_image(&format!("{url}?{i}"), "ref", d).unwrap();
        }

        let (bytes, count) = usage(d);
        assert!(bytes <= 30, "超过上限后应整理到上限以内，实际 {bytes}");
        assert!(count < 4, "最久没写的条目应被淘汰");
        set_limit(d, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 清空之后目录为空、内存表也空：再取同一张图要走网络并重新落盘。
    #[test]
    fn clear_empties_disk_and_memory() {
        let _guard = lock();
        const BODY: &[u8] = b"clear-bytes";
        let (url, requests) = spawn_server(BODY, "image/png");
        let dir = temp_cache_dir("clear");
        let d = dir.to_str().unwrap();
        fetch_image(&url, "ref", d).unwrap();
        assert_eq!(requests.lock().unwrap().len(), 1);

        clear(d);
        assert_eq!(usage(d), (0, 0), "清空后目录为空");

        let (bytes, _) = fetch_image(&url, "ref", d).unwrap();
        assert_eq!(bytes, BODY);
        assert_eq!(
            requests.lock().unwrap().len(),
            2,
            "内存表已清空，应重新走网络"
        );
        assert_eq!(usage(d).1, 1, "重新取到的图片重新写入磁盘");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
