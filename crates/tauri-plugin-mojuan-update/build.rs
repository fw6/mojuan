//! 插件构建脚本：把 android/ 与 ios/ 原生工程注册进移动构建。
//!
//! `android_path` / `ios_path` 让 `tauri-plugin` 在移动构建时把 tauri-api 拷进插件
//! 目录（android/.tauri、.tauri）并输出 `cargo:android_library_path`，app 的
//! build.rs（tauri-build）据此把插件写进 `gen/android/tauri.settings.gradle`；
//! iOS 侧经 `link_apple_library` 把 ios/ 的 Swift package 链进 Xcode 工程。
//!
//! 命令列表为空：安装入口只由 Rust 侧调用（`PluginHandle::run_mobile_plugin`），
//! 不对远程页面开放，也就不需要任何 capability / 权限定义。

const COMMANDS: &[&str] = &[];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .build();
}
