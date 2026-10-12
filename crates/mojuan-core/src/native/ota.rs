//! Android OTA 更新通道的客户端侧：清单拉取、版本比对、安装包下载与 sha256 校验。
//!
//! 通道是 `updater/` 的 Cloudflare Worker（桌面端 tauri-plugin-updater 也走它）。
//! 这里只负责把 APK 拿到本地并确认内容完整；安装包的签名由系统在覆盖安装时校验，
//! 客户端在交出去之前另比一次（见 `tauri-plugin-mojuan-update` 的签名比对）。
//!
//! 与平台无关，也不依赖 Tauri：应用层（src-tauri 的 ota 模块）传入通道地址与落盘
//! 路径，拿到结果后再交给系统安装器。

use crate::util::hex;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;

/// 单次请求的超时（安装包几十兆，给足时间）。
const TIMEOUT: Duration = Duration::from_secs(600);

/// 连接超时（与 crawler 的共享客户端一致）。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// 读安装包的分块大小。
const CHUNK: usize = 64 * 1024;

/// 更新通道给出的 Android 清单（`GET <endpoint>`）。
#[derive(Clone, Debug, Deserialize)]
pub struct AndroidManifest {
    /// 最新已发布版本的版本号（semver）。
    pub version: String,
    /// 该版本 APK 的下载地址（通道已改写成自己的 /dl 路径）。
    pub url: String,
    /// APK 的 sha256（十六进制，大小写不敏感）。
    pub sha256: String,
}

/// 拉清单。通道没有 Android 制品时回 204，按「没有更新」返回 `Ok(None)`。
pub fn fetch_manifest(endpoint: &str) -> Result<Option<AndroidManifest>, String> {
    let res = client()?
        .get(endpoint)
        .send()
        .map_err(|e| format!("连接更新通道失败：{e}"))?;
    if res.status().as_u16() == 204 {
        return Ok(None);
    }
    if !res.status().is_success() {
        return Err(format!("更新通道返回 {}（{endpoint}）", res.status()));
    }
    let body = res.text().map_err(|e| format!("读取更新清单失败：{e}"))?;
    let manifest: AndroidManifest = serde_json::from_str(&body)
        .map_err(|e| format!("更新清单无法解析：{e}；通道返回的内容：{}", body.trim()))?;
    Ok(Some(manifest))
}

/// 清单版本是否比已安装版本新。
///
/// 两边都按 semver 解析；解析失败说明通道数据有问题，直接报出来——当成「没有更新」
/// 会让问题永远看不见。
pub fn is_newer(candidate: &str, current: &str) -> Result<bool, String> {
    let candidate = semver::Version::parse(candidate)
        .map_err(|e| format!("更新通道给出的版本号无法解析：{candidate}（{e}）"))?;
    let current = semver::Version::parse(current)
        .map_err(|e| format!("当前安装的版本号无法解析：{current}（{e}）"))?;
    Ok(candidate > current)
}

/// 下载安装包到 `target` 并校验 sha256。
///
/// `on_progress(done, total)` 在下载过程中被反复调用（`total` 为 0 表示上游没给长度）。
/// 任何失败都删掉落盘的文件：留一个坏包在磁盘上只会在安装时变成更难懂的失败。
pub fn download_apk(
    url: &str,
    sha256: &str,
    target: &Path,
    on_progress: impl FnMut(u64, u64),
) -> Result<(), String> {
    match download(url, target, on_progress) {
        Ok(actual) if actual.eq_ignore_ascii_case(sha256) => Ok(()),
        Ok(actual) => {
            let _ = std::fs::remove_file(target);
            Err(format!(
                "安装包校验失败：sha256 不一致（通道给出 {sha256}，实际 {actual}）"
            ))
        }
        Err(e) => {
            let _ = std::fs::remove_file(target);
            Err(e)
        }
    }
}

/// 下载并返回实际内容的 sha256（清理交给调用方）。
fn download(
    url: &str,
    target: &Path,
    mut on_progress: impl FnMut(u64, u64),
) -> Result<String, String> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建安装包目录失败：{e}"))?;
    }
    let mut res = client()?
        .get(url)
        .send()
        .map_err(|e| format!("下载安装包失败：{e}（{url}）"))?;
    if !res.status().is_success() {
        return Err(format!(
            "下载安装包失败：更新通道返回 {}（{url}）",
            res.status()
        ));
    }
    let total = res.content_length().unwrap_or(0);
    on_progress(0, total);

    let mut file = File::create(target).map_err(|e| format!("创建安装包文件失败：{e}"))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; CHUNK];
    let mut done: u64 = 0;
    loop {
        let read = res.read(&mut buf).map_err(|e| format!("下载中断：{e}"))?;
        if read == 0 {
            break;
        }
        file.write_all(&buf[..read])
            .map_err(|e| format!("写入安装包失败：{e}"))?;
        hasher.update(&buf[..read]);
        done += read as u64;
        on_progress(done, total);
    }
    file.sync_all()
        .map_err(|e| format!("安装包写入磁盘失败：{e}"))?;
    drop(file);
    Ok(hex(&hasher.finalize()))
}

/// 专用的阻塞客户端：安装包比抓取结果大得多，共享客户端的 60 秒总超时不够用。
fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| format!("HTTP 客户端创建失败：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_newer_compares_semver() {
        assert!(is_newer("1.5.0", "1.4.0").unwrap());
        assert!(is_newer("1.4.1", "1.4.0").unwrap());
        assert!(is_newer("2.0.0", "1.9.9").unwrap());
        assert!(!is_newer("1.4.0", "1.4.0").unwrap());
        assert!(!is_newer("1.3.9", "1.4.0").unwrap());
    }

    #[test]
    fn is_newer_reports_unparsable_versions() {
        assert!(is_newer("v1.5.0", "1.4.0").unwrap_err().contains("无法解析"));
        assert!(is_newer("1.5.0", "1.4").unwrap_err().contains("无法解析"));
    }

    #[test]
    fn manifest_parses_channel_shape() {
        let manifest: AndroidManifest = serde_json::from_str(
            r#"{"version":"1.5.0","url":"https://mojuan.fengw.site/dl/app-v1.5.0/mojuan-1.5.0-android.apk","sha256":"AB12"}"#,
        )
        .unwrap();
        assert_eq!(manifest.version, "1.5.0");
        assert_eq!(manifest.sha256, "AB12");
        assert!(manifest.url.ends_with("mojuan-1.5.0-android.apk"));
    }
}
