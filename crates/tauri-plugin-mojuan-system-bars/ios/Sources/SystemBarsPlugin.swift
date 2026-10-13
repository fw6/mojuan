// mojuan 移动端系统栏（iOS 侧）。
//
// Rust 侧（tauri-plugin-mojuan-system-bars 的 mobile.rs）经这个插件类调 `setSystemBars`：
//   hidden      是否隐藏状态栏
//   lightIcons  状态栏图标是否取浅色（阅读画布是暗色）
//
// iOS 的状态栏外观由视图控制器的 `prefersStatusBarHidden` / `preferredStatusBarStyle`
// 决定，两个属性都是只读的，运行时改不了实例上的值。所以这里把 `UIViewController`
// 这两个方法的实现换成本文件里的版本，读一份全局状态——tauri 的根控制器没有覆写
// 它们，换掉基类实现即可生效。
//
// 安全区不从这里给：前端用 `env(safe-area-inset-*)`（iOS 一直提供），全应用同一个来源。
// iOS 也没有导航栏（底部是自动隐藏的 home indicator），所以只有状态栏一项。

import ObjectiveC
import SwiftRs
import Tauri
import UIKit

/// 状态栏设置请求（字段名与 Rust 侧 `SystemBarsRequest` 的 camelCase 一致）。
struct SystemBarsArgs: Decodable {
  let hidden: Bool
  let lightIcons: Bool
}

/// 状态栏外观的全局状态（被换掉实现的那两个方法读它）。
final class StatusBarAppearance {
  static var hidden = false
  static var lightIcons = false
  private static var swizzled = false

  /// 换掉 `UIViewController` 的状态栏求值；只换一次。
  static func swizzle() {
    guard !swizzled else { return }
    swizzled = true
    let swaps: [(Selector, Selector)] = [
      (
        #selector(getter: UIViewController.prefersStatusBarHidden),
        #selector(UIViewController.mojuan_prefersStatusBarHidden)
      ),
      (
        #selector(getter: UIViewController.preferredStatusBarStyle),
        #selector(UIViewController.mojuan_preferredStatusBarStyle)
      ),
    ]
    for (original, replacement) in swaps {
      guard
        let from = class_getInstanceMethod(UIViewController.self, original),
        let to = class_getInstanceMethod(UIViewController.self, replacement)
      else { continue }
      method_exchangeImplementations(from, to)
    }
  }
}

extension UIViewController {
  @objc func mojuan_prefersStatusBarHidden() -> Bool {
    StatusBarAppearance.hidden
  }

  @objc func mojuan_preferredStatusBarStyle() -> UIStatusBarStyle {
    StatusBarAppearance.lightIcons ? .lightContent : .darkContent
  }
}

class SystemBarsPlugin: Plugin {

  @objc public func setSystemBars(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SystemBarsArgs.self)
    // 状态栏挂在窗口的根控制器上，一律在主线程读写
    DispatchQueue.main.async {
      StatusBarAppearance.swizzle()
      StatusBarAppearance.hidden = args.hidden
      StatusBarAppearance.lightIcons = args.lightIcons
      SystemBarsPlugin.keyWindow()?.rootViewController?.setNeedsStatusBarAppearanceUpdate()
      invoke.resolve(["ok": true])
    }
  }

  /// 当前 key window。
  private static func keyWindow() -> UIWindow? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    return scenes.flatMap { $0.windows }.first { $0.isKeyWindow }
  }
}

@_cdecl("init_plugin_mojuan_system_bars")
func initPlugin() -> Plugin {
  return SystemBarsPlugin()
}

