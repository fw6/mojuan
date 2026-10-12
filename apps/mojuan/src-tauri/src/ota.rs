//! Android OTA 更新（桌面端走官方 tauri-plugin-updater）。只在移动端编译。
//!
//! 五步状态机，由前端按顺序调用：
//!   ota_check                  拉更新通道的 Android 清单，与已安装版本比对，结果存进 state
//!   ota_download               下载清单里的 APK 到缓存目录，边下边报进度，落盘后校验 sha256
//!   ota_install                把下载结果交给系统安装器（插件 tauri-plugin-mojuan-update）
//!   ota_can_install            「安装未知应用」授权查询
//!   ota_open_install_settings  跳到该授权页
//!
//! 清单拉取、版本比对、下载与校验都在 mojuan-core 的 `native::ota`（与平台无关）；
//! 这里只做状态管理、通道地址读取与原生安装调用。
//!
//! 通道地址取自 tauri.conf.json 的 `plugins.mojuan-update.endpoint`，与桌面端
//! `plugins.updater.endpoints` 并列，都是 `updater/` 那个 Cloudflare Worker。

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::ipc::Channel;
use tauri::Manager;

/// 下载进度（`ota_download` 的 Channel 载荷）。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OtaProgress {
    /// `started` / `progress` / `finished`
    event: &'static str,
    done: u64,
    total: u64,
}

/// 已检查到的可用更新。
struct Pending {
    manifest: mojuan_core::native::ota::AndroidManifest,
    /// 下载目标（缓存目录下按版本命名）。
    target: PathBuf,
}

/// 已下载待安装的安装包。
struct Downloaded {
    path: PathBuf,
    version: String,
}

/// OTA 状态（`ota_check` / `ota_download` 依次填充，`ota_install` 读取）。
#[derive(Default)]
struct OtaState {
    pending: Option<Pending>,
    apk: Option<Downloaded>,
}

/// 注册 OTA 状态（setup 时调用一次）。
pub fn init(app: &tauri::AppHandle) {
    app.manage(Mutex::new(OtaState::default()));
}

/// 检查更新：拉通道清单，与已安装版本比对。
#[tauri::command]
pub async fn ota_check(app: tauri::AppHandle) -> Result<String, String> {
    let endpoint = endpoint(&app)?;
    // package_info 的版本就是 tauri.conf.json 的 version，与 Android 的 versionName 同源
    let current = app.package_info().version.to_string();
    let fetched = tauri::async_runtime::spawn_blocking(move || {
        mojuan_core::native::ota::fetch_manifest(&endpoint)
    })
    .await
    .map_err(|e| format!("检查更新无法调度到后台线程：{e}"))??;

    let available = match &fetched {
        Some(manifest) => mojuan_core::native::ota::is_newer(&manifest.version, &current)?,
        None => false,
    };

    let state = app.state::<Mutex<OtaState>>();
    let mut guard = state.lock().unwrap();
    guard.pending = None;
    guard.apk = None;

    let Some(manifest) = fetched else {
        return Ok(serde_json::json!({ "available": false, "current": current }).to_string());
    };
    let version = manifest.version.clone();
    if available {
        guard.pending = Some(Pending {
            target: apk_path(&app, &version)?,
            manifest,
        });
    }
    Ok(serde_json::json!({
        "available": available,
        "current": current,
        "version": version,
    })
    .to_string())
}

/// 下载清单里的安装包（进度经 Channel 推送），落盘后校验 sha256。
#[tauri::command]
pub async fn ota_download(
    app: tauri::AppHandle,
    channel: Channel<OtaProgress>,
) -> Result<String, String> {
    let (manifest, target) = {
        let state = app.state::<Mutex<OtaState>>();
        let guard = state.lock().unwrap();
        let pending = guard
            .pending
            .as_ref()
            .ok_or_else(|| "还没有可下载的版本：先检查更新".to_string())?;
        (pending.manifest.clone(), pending.target.clone())
    };

    let progress = channel.clone();
    let (url, sha256, path) = (manifest.url.clone(), manifest.sha256.clone(), target.clone());
    tauri::async_runtime::spawn_blocking(move || {
        mojuan_core::native::ota::download_apk(&url, &sha256, &path, |done, total| {
            let event = if done == 0 { "started" } else { "progress" };
            let _ = progress.send(OtaProgress { event, done, total });
        })
    })
    .await
    .map_err(|e| format!("下载无法调度到后台线程：{e}"))??;

    let done = std::fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
    let _ = channel.send(OtaProgress {
        event: "finished",
        done,
        total: done,
    });

    let version = manifest.version.clone();
    let state = app.state::<Mutex<OtaState>>();
    state.lock().unwrap().apk = Some(Downloaded {
        path: target.clone(),
        version: version.clone(),
    });
    Ok(serde_json::json!({
        "version": version,
        "path": target.to_string_lossy(),
    })
    .to_string())
}

/// 把下载好的安装包交给系统安装器。
///
/// 原生侧在系统回报第一个状态（确认界面已拉起 / 安装成功 / 失败原因）后结算；安装
/// 成功时系统会结束本进程，下一次启动就是新版本。返回 `{status, version}`。
#[tauri::command]
pub async fn ota_install(app: tauri::AppHandle) -> Result<String, String> {
    let (apk, version) = {
        let state = app.state::<Mutex<OtaState>>();
        let guard = state.lock().unwrap();
        let apk = guard
            .apk
            .as_ref()
            .ok_or_else(|| "还没有下载好的安装包：先检查并下载".to_string())?;
        (apk.path.clone(), apk.version.clone())
    };
    let handle = app.clone();
    let path = apk.to_string_lossy().into_owned();
    let status = tauri::async_runtime::spawn_blocking(move || {
        tauri_plugin_mojuan_update::install(&handle, &path)
    })
    .await
    .map_err(|e| format!("安装无法调度到后台线程：{e}"))??;
    Ok(serde_json::json!({ "status": status, "version": version }).to_string())
}

/// 是否已获得「安装未知应用」授权（前端据此决定先引导授权还是直接装）。
#[tauri::command]
pub async fn ota_can_install(app: tauri::AppHandle) -> Result<bool, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        tauri_plugin_mojuan_update::can_install(&handle)
    })
    .await
    .map_err(|e| format!("查询安装授权无法调度到后台线程：{e}"))?
}

/// 跳到系统的「安装未知应用」授权页。
#[tauri::command]
pub async fn ota_open_install_settings(app: tauri::AppHandle) -> Result<(), String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        tauri_plugin_mojuan_update::open_install_settings(&handle)
    })
    .await
    .map_err(|e| format!("打开安装授权页无法调度到后台线程：{e}"))?
}

/// 更新通道的 Android 清单地址（tauri.conf.json 的 `plugins.mojuan-update.endpoint`）。
///
/// 配置的形态由插件声明（`tauri_plugin_mojuan_update::Config`）——tauri 在插件初始化
/// 时按那个类型反序列化这段配置，这里读同一份原始 JSON 再解一次，两处不会走偏。
fn endpoint(app: &tauri::AppHandle) -> Result<String, String> {
    let name = tauri_plugin_mojuan_update::PLUGIN_NAME;
    let raw = app
        .config()
        .plugins
        .0
        .get(name)
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let cfg: tauri_plugin_mojuan_update::Config = serde_json::from_value(raw)
        .map_err(|e| format!("tauri.conf.json 的 plugins.{name} 无法解析：{e}"))?;
    if cfg.endpoint.is_empty() {
        return Err(format!("tauri.conf.json 里没有配 plugins.{name}.endpoint"));
    }
    Ok(cfg.endpoint)
}

/// 安装包的落盘位置：应用缓存目录下的 ota/，按版本命名。
fn apk_path(app: &tauri::AppHandle, version: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("取应用缓存目录失败：{e}"))?;
    Ok(dir.join("ota").join(format!("mojuan-{version}.apk")))
}
