//! 应用的真实配置要能被它声明的插件配置类型接受，且版本与 Cargo 侧一致。
//!
//! tauri 在插件初始化时按 `Config` 反序列化 tauri.conf.json 里 `plugins.<插件名>` 那一段，
//! 类型不匹配会让应用启动即 panic（插件的配置类型默认是 `()`，配置里放一个对象就崩）。
//! 这份配置属于本 crate，断言写在这里，不必跨 crate 去读别人的文件。

use serde_json::Value;
use tauri_plugin_mojuan_update::{Config, PLUGIN_NAME};

fn app_config() -> Value {
    let raw =
        std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tauri.conf.json")).unwrap();
    serde_json::from_str(&raw).unwrap()
}

#[test]
fn real_tauri_config_deserializes() {
    let conf = app_config();
    let raw = conf["plugins"][PLUGIN_NAME].clone();
    let cfg: Config = serde_json::from_value(raw).unwrap();
    assert_eq!(cfg.endpoint, "https://mojuan.fengw.site/android.json");
}

/// 版本的事实来源是配置里的 `version`（Android 的 versionName/versionCode 与 iOS 的
/// CFBundleShortVersionString 都从它取），Cargo 那份是跟着它写的副本——漂了就会让
/// 「装的是哪个版本」出现两个答案，所以在这里钉住。
#[test]
fn version_matches_the_cargo_package() {
    let conf = app_config();
    assert_eq!(
        conf["version"].as_str().unwrap(),
        env!("CARGO_PKG_VERSION"),
        "tauri.conf.json 的 version 与 Cargo 的包版本不一致"
    );
}
