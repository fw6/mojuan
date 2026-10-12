// swift-tools-version:5.3
// mojuan 移动端隐藏 webview 渲染通道（iOS 侧，包定义）。

import PackageDescription

let package = Package(
  name: "tauri-plugin-mojuan-render",
  platforms: [
    .macOS(.v10_13),
    .iOS(.v13),
  ],
  products: [
    .library(
      name: "tauri-plugin-mojuan-render",
      type: .static,
      targets: ["tauri-plugin-mojuan-render"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-mojuan-render",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
