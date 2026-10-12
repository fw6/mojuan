//! 应用的真实配置要能被它声明的插件配置类型接受。
//!
//! tauri 在插件初始化时按 `Config` 反序列化 tauri.conf.json 里 `plugins.<插件名>` 那一段，
//! 类型不匹配会让应用启动即 panic（插件的配置类型默认是 `()`，配置里放一个对象就崩）。
//! 这份配置属于本 crate，断言写在这里，不必跨 crate 去读别人的文件。

use tauri_plugin_mojuan_update::{Config, PLUGIN_NAME};

#[test]
fn real_tauri_config_deserializes() {
    let conf =
        std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tauri.conf.json")).unwrap();
    let conf: serde_json::Value = serde_json::from_str(&conf).unwrap();
    let raw = conf["plugins"][PLUGIN_NAME].clone();
    let cfg: Config = serde_json::from_value(raw).unwrap();
    assert_eq!(cfg.endpoint, "https://mojuan.fengw.site/android.json");
}
