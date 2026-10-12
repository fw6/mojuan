// mojuan 移动端隐藏 webview 渲染通道（iOS 侧）。
//
// Rust 侧（tauri-plugin-mojuan-render 的 mobile.rs）经 C FFI 调 `render` 命令，把目标
// URL 与判定脚本一起送进来；这里用一个「离屏 webview」加载页面，等 JS 挑战跑完、页面
// 稳定后取回 outerHTML，经 invoke.resolve 交回 Rust。
//
// - 判定与节奏全部来自 Rust 侧请求：状态脚本、取 HTML 的脚本、轮询间隔、整体超时
//   （mojuan_core::crawler::render），这里只负责「加载 → 按间隔评估 → 连续两次干净 →
//   取 HTML」，与桌面端 render.rs 同判据。
// - 单实例复用：验证 cookie（cf_clearance / gatekeeper ticket）由
//   WKWebsiteDataStore.default() 持久化，后续渲染与重启应用都能复用。
// - 不用导航回调做门控（桌面端实测跨站重定向会丢事件），页面就绪以轮询为准；导航失败
//   只记进诊断信息，随超时文案一起给出。
// - 状态只在主线程访问：命令本身跑在 tauri 的 ipc 队列上，进去第一件事就是切主线程。

import SwiftRs
import Tauri
import UIKit
import WebKit

/// 渲染请求（字段名与 Rust 侧 `RenderRequest` 的 camelCase 一致）。
struct RenderArgs: Decodable {
  let url: String
  let stateScript: String
  let htmlScript: String
  let pollMs: UInt64
  let timeoutMs: UInt64
}

class RenderPlugin: Plugin, WKNavigationDelegate {

  /// 离屏 webview（懒创建；应用生命周期内复用）。
  private var webView: WKWebView?

  /// 当前渲染（单飞：一次只渲染一个页面，与 Rust 侧互斥锁双重保护）。
  private var pending: PendingRender?

  /// 一次渲染的结算状态：invoke 只结算一次，超时计时与 webkit 回调互不依赖。
  private final class PendingRender {
    let invoke: Invoke
    let args: RenderArgs
    /// 目标 URL（已在 startRender 里校验过 http(s)）。
    let target: URL
    var settled = false
    var cleanStreak = 0
    var lastState = ""
    var lastNavigationError: String?

    init(invoke: Invoke, args: RenderArgs, target: URL) {
      self.invoke = invoke
      self.args = args
      self.target = target
    }
  }

  @objc public func render(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(RenderArgs.self)
    DispatchQueue.main.async {
      self.startRender(invoke, args)
    }
  }

  // MARK: - 导航回调（只做诊断记录）

  func webView(
    _ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
    withError error: Error
  ) {
    recordNavigationError(error)
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    recordNavigationError(error)
  }

  /// 记下导航失败（取消类错误除外：复位导航被目标导航接替是常态，不算失败）。
  private func recordNavigationError(_ error: Error) {
    let nsError = error as NSError
    if nsError.code == NSURLErrorCancelled {
      return
    }
    pending?.lastNavigationError = nsError.localizedDescription
  }

  // MARK: - 渲染流程

  private func startRender(_ invoke: Invoke, _ args: RenderArgs) {
    guard let target = URL(string: args.url),
      target.scheme == "http" || target.scheme == "https"
    else {
      invoke.reject("渲染通道只支持 http(s): \(args.url)")
      return
    }
    if pending != nil {
      invoke.reject("渲染通道忙：上一次渲染尚未结束")
      return
    }
    guard let view = ensureWebView() else {
      invoke.reject("渲染通道不可用：主窗口视图尚未就绪")
      return
    }
    let state = PendingRender(invoke: invoke, args: args, target: target)
    pending = state
    // 整体超时用独立的 asyncAfter：渲染进程卡死时 evaluateJavaScript 回调不会到达，
    // 结论只能由计时器给出；结算只认第一次（PendingRender.settled）。
    DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(Int(args.timeoutMs))) {
      let navigation = state.lastNavigationError.map { "；导航错误: \($0)" } ?? ""
      self.finishReject(
        state, "渲染超时（页面加载未完成或验证未通过）: \(args.url)；最后状态: \(state.lastState)\(navigation)")
    }
    // 复位到 about:blank：目标导航必为全新的跨文档加载，href 判定不受残留文档干扰
    view.load(URLRequest(url: URL(string: "about:blank")!))
    waitReset(view, state, deadline: Date().addingTimeInterval(Self.resetTimeout))
  }

  private func ensureWebView() -> WKWebView? {
    if let view = webView {
      return view
    }
    guard let host = manager.viewController?.view else {
      return nil
    }
    let config = WKWebViewConfiguration()
    // 与桌面 macOS 相同的持久化 cookie：验证通过后重启应用仍是已验证状态
    config.websiteDataStore = .default()
    let size = CGSize(width: Self.viewportWidth, height: Self.viewportHeight)
    let view = WKWebView(frame: CGRect(origin: .zero, size: size), configuration: config)
    view.navigationDelegate = self
    attachOffscreen(view, host: host, size: size)
    webView = view
    return view
  }

  /// 把离屏 webview 挂载到窗口里再移出可见区域。
  ///
  /// 不在窗口里的 WKWebView 会被 WebKit 当作不可见页面节流（定时器被拉开间隔，验证
  /// 挑战的 JS 可能跑不完），挂载到窗口里又不希望用户看到，所以整体位移到屏幕之外。视口
  /// 1280x800 CSS px（与桌面端隐藏窗口同一尺寸，目标站的响应式布局因此与桌面端接近）；
  /// UA 保持平台默认不伪装（Cloudflare 会比对 UA 与客户端提示，改 UA 反而更容易被判为
  /// 机器人，而通过验证是本通道的第一要务）。
  private func attachOffscreen(_ view: WKWebView, host: UIView, size: CGSize) {
    view.isUserInteractionEnabled = false
    view.frame = CGRect(
      x: -2 * size.width, y: -2 * size.height, width: size.width, height: size.height)
    host.insertSubview(view, at: 0)
  }

  /// 复位阶段：等 href 变成 about:blank（超时不报错，目标导航会覆盖旧文档）。
  private func waitReset(_ view: WKWebView, _ state: PendingRender, deadline: Date) {
    if state.settled {
      return
    }
    evalState(view, state) { snapshot in
      if state.settled {
        return
      }
      if snapshot?["href"] as? String == "about:blank" || Date() >= deadline {
        view.load(URLRequest(url: state.target))
        self.pollTarget(view, state)
      } else {
        self.afterMain(milliseconds: Self.resetPollMs) {
          self.waitReset(view, state, deadline: deadline)
        }
      }
    }
  }

  /// 目标页面轮询：拒绝页立即失败，连续两次「干净」后取 HTML，其余等下一轮。
  private func pollTarget(_ view: WKWebView, _ state: PendingRender) {
    if state.settled {
      return
    }
    evalState(view, state) { snapshot in
      if state.settled {
        return
      }
      if let snapshot = snapshot {
        if snapshot["denied"] as? Bool == true {
          self.finishReject(state, "Cloudflare 拒绝访问（错误页/访问被拒）: \(state.args.url)")
          return
        }
        if snapshot["clean"] as? Bool == true {
          // 连续两次干净才算稳定（挑战页跳转瞬间防误提取，与桌面端判据一致）
          state.cleanStreak += 1
          if state.cleanStreak >= Self.cleanChecks {
            self.extractHtml(view, state)
            return
          }
        } else {
          state.cleanStreak = 0
        }
      } else {
        // 文档切换瞬间 / 页面脚本繁忙：按未就绪继续轮询，整体超时兜底
        state.cleanStreak = 0
      }
      self.afterMain(milliseconds: state.args.pollMs) {
        self.pollTarget(view, state)
      }
    }
  }

  private func extractHtml(_ view: WKWebView, _ state: PendingRender) {
    view.evaluateJavaScript(state.args.htmlScript) { result, _ in
      if state.settled {
        return
      }
      if let html = result as? String,
        !html.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      {
        self.finishResolve(state, html)
      } else {
        self.finishReject(state, "渲染结果提取失败: \(state.args.url)")
      }
    }
  }

  /// 评估状态脚本，把状态对象（`{rs, href, ch, denied, clean}`）交给回调；解析不出算未就绪。
  private func evalState(
    _ view: WKWebView, _ state: PendingRender, _ then: @escaping ([String: Any]?) -> Void
  ) {
    view.evaluateJavaScript(state.args.stateScript) { result, _ in
      let snapshot = result as? [String: Any]
      if let snapshot = snapshot {
        state.lastState = "\(snapshot)"
        Logger.debug("状态: \(snapshot)", category: "MojuanRender")
      }
      then(snapshot)
    }
  }

  private func finishResolve(_ state: PendingRender, _ html: String) {
    if state.settled {
      return
    }
    state.settled = true
    pending = nil
    state.invoke.resolve(["html": html])
  }

  private func finishReject(_ state: PendingRender, _ message: String) {
    if state.settled {
      return
    }
    state.settled = true
    pending = nil
    Logger.error(message, category: "MojuanRender")
    state.invoke.reject(message)
  }

  private func afterMain(milliseconds: UInt64, _ work: @escaping () -> Void) {
    DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(Int(milliseconds)), execute: work)
  }

  /// 离屏 webview 的布局视口（CSS px）。
  private static let viewportWidth = 1280.0
  private static let viewportHeight = 800.0
  /// 复位 about:blank 的等待上限与轮询间隔（毫秒）。
  private static let resetTimeout = 5.0
  private static let resetPollMs: UInt64 = 100
  /// 连续两次「干净」才算稳定。
  private static let cleanChecks = 2
}

@_cdecl("init_plugin_mojuan_render")
func initPlugin() -> Plugin {
  return RenderPlugin()
}
