// swift-tools-version:5.3
// mojuan 移动端系统栏（iOS 侧，包定义）。

import PackageDescription

let package = Package(
  name: "tauri-plugin-mojuan-system-bars",
  platforms: [
    .macOS(.v10_13),
    .iOS(.v13),
  ],
  products: [
    .library(
      name: "tauri-plugin-mojuan-system-bars",
      type: .static,
      targets: ["tauri-plugin-mojuan-system-bars"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-mojuan-system-bars",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
