//! mojuan Android OTA 安装通道（自建 tauri 插件）。
//!
//! 更新清单、下载与 sha256 校验都在应用层（`src-tauri` 的 `ota` 模块）；这里只做
//! 「把下载好的 APK 交给系统安装器」这一步。安装会话、签名比对、「安装未知应用」
//! 授权判定全部是平台能力，Rust 侧经 `PluginHandle::run_mobile_plugin` 同步调用。
//!
//! 桌面端不用这条通道（Windows / Linux 走官方 tauri-plugin-updater），[`install`]
//! 在桌面端返回明确错误。
//!
//! 宿主在 setup 之外调用这三个入口即可，命令面为零：
//!
//! ```ignore
//! tauri_plugin_mojuan_update::install(&app, &apk_path)?;
//! ```

use tauri::{plugin::TauriPlugin, AppHandle, Runtime};

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

#[cfg(desktop)]
use desktop as platform;
#[cfg(mobile)]
use mobile as platform;

/// 插件名（原生侧的注册键，与 Kotlin / Swift 插件类一一对应）。
pub const PLUGIN_NAME: &str = "mojuan-update";

/// 插件配置（tauri.conf.json 的 `plugins.mojuan-update`）。
///
/// 类型必须声明出来：tauri 在插件初始化时按这个类型反序列化配置，默认类型是 `()`，
/// 配置里放一个对象就会让应用启动即 panic。
#[derive(Default, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    /// 更新通道的 Android 清单地址（如
    /// `https://mojuan.fengw.site/android.json`）。
    #[serde(default)]
    pub endpoint: String,
}

/// 安装请求（camelCase 字段名与原生侧一致：Kotlin `@InvokeArg InstallArgs`、
/// Swift `InstallArgs: Decodable`）。
#[cfg(any(mobile, test))]
#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstallRequest<'a> {
    /// APK 的绝对路径（应用缓存目录下的下载结果）。
    pub path: &'a str,
}

/// 原生侧 resolve 的结果。
#[cfg(any(mobile, test))]
#[derive(serde::Deserialize)]
pub(crate) struct InstallResponse {
    /// `confirming`：系统安装确认界面已拉起；`installed`：系统回报安装成功。
    pub status: String,
}

/// 「安装未知应用」授权查询的结果。
#[cfg(any(mobile, test))]
#[derive(serde::Deserialize)]
pub(crate) struct AllowedResponse {
    pub allowed: bool,
}

/// 无返回值命令的结果。
#[cfg(any(mobile, test))]
#[derive(serde::Deserialize)]
pub(crate) struct OkResponse {
    pub ok: bool,
}

/// 注册插件。桌面端为空实现。
pub fn init<R: Runtime>() -> TauriPlugin<R, Config> {
    tauri::plugin::Builder::<R, Config>::new(PLUGIN_NAME)
        .setup(platform::init)
        .build()
}

/// 把 APK 交给系统安装器，返回原生侧报告的状态。
///
/// 在阻塞线程上调用（同步等待原生侧结果，原生侧在系统回报第一个状态或超时后结算）。
pub fn install<R: Runtime>(app: &AppHandle<R>, path: &str) -> Result<String, String> {
    platform::install(app, path)
}

/// 是否已获得「安装未知应用」授权（Android 8.0 以下恒为 true）。
pub fn can_install<R: Runtime>(app: &AppHandle<R>) -> Result<bool, String> {
    platform::can_install(app)
}

/// 跳到系统的「安装未知应用」授权页。
pub fn open_install_settings<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    platform::open_install_settings(app)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 原生侧的字段名（Kotlin @InvokeArg / Swift Decodable）按字段名严格解析，
    /// 改字段名会静默打断桥接，这里把 wire 契约固定下来。
    #[test]
    fn wire_contract_field_names() {
        let request = InstallRequest {
            path: "/data/user/0/io.github.fw6.mojuan/cache/ota/mojuan-1.5.0.apk",
        };
        let json = serde_json::to_value(&request).unwrap();
        let mut keys: Vec<&str> =
            json.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["path"]);
        assert_eq!(
            json["path"],
            "/data/user/0/io.github.fw6.mojuan/cache/ota/mojuan-1.5.0.apk"
        );

        let response: InstallResponse =
            serde_json::from_str(r#"{"status":"confirming"}"#).unwrap();
        assert_eq!(response.status, "confirming");

        let allowed: AllowedResponse = serde_json::from_str(r#"{"allowed":true}"#).unwrap();
        assert!(allowed.allowed);

        let ok: OkResponse = serde_json::from_str(r#"{"ok":true}"#).unwrap();
        assert!(ok.ok);
    }

    #[test]
    fn config_reads_endpoint() {
        let cfg: Config = serde_json::from_str(
            r#"{"endpoint":"https://mojuan.fengw.site/android.json"}"#,
        )
        .unwrap();
        assert_eq!(cfg.endpoint, "https://mojuan.fengw.site/android.json");

        // 没有 endpoint 时留空串，由 ota 侧给出「没有配」的明确报错
        let cfg: Config = serde_json::from_str("{}").unwrap();
        assert!(cfg.endpoint.is_empty());
    }
}
