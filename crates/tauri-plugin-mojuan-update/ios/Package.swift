// swift-tools-version:5.3
// mojuan Android OTA 安装通道（iOS 侧，包定义）。
//
// iOS 侧不实现安装：侧载安装的包需要 Apple 开发者签名，没有自更新可言。这里只提供
// 与 Android 同名的插件类与命令，让 Rust 侧在两端拿到同一组入口，调用时得到明确的
// 「不支持」而不是链接错误。

import PackageDescription

let package = Package(
  name: "tauri-plugin-mojuan-update",
  platforms: [
    .macOS(.v10_13),
    .iOS(.v13),
  ],
  products: [
    .library(
      name: "tauri-plugin-mojuan-update",
      type: .static,
      targets: ["tauri-plugin-mojuan-update"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-mojuan-update",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
