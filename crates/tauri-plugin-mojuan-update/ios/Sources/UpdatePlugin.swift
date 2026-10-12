// mojuan Android OTA 安装通道（iOS 侧）。
//
// Rust 侧（tauri-plugin-mojuan-update 的 mobile.rs）在 iOS 上注册这个类，三个命令的
// 回答都是「不支持」：iOS 的侧载安装必须由 Apple 开发者签名，应用没有自更新的手段。
// 入口与 Android 侧同名同参数，调用方不需要按平台分叉。

import SwiftRs
import Tauri
import UIKit

/// 安装请求（字段名与 Rust 侧 `InstallRequest` 的 camelCase 一致）。
struct InstallArgs: Decodable {
  let path: String
}

class UpdatePlugin: Plugin {

  @objc public func install(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(InstallArgs.self)
    Logger.error("拒绝安装 \(args.path)", category: "MojuanUpdate")
    invoke.reject("iOS 不支持自更新：侧载安装需要 Apple 开发者签名")
  }

  @objc public func canInstall(_ invoke: Invoke) throws {
    invoke.resolve(["allowed": false])
  }

  @objc public func openInstallSettings(_ invoke: Invoke) throws {
    invoke.reject("iOS 不支持自更新：没有可打开的安装授权设置")
  }
}

@_cdecl("init_plugin_mojuan_update")
func initPlugin() -> Plugin {
  return UpdatePlugin()
}
