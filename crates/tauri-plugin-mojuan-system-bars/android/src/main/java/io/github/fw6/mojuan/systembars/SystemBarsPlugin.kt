// mojuan 移动端系统栏（Android 侧）。
//
// Rust 侧（tauri-plugin-mojuan-system-bars 的 mobile.rs）经 JNI 调 `setSystemBars` 命令：
//   hidden      是否隐藏系统栏（沉浸式全屏）
//   lightIcons  栏内图标是否取浅色（阅读画布是暗色）
//
// - 用 compat 层而不是平台的 WindowInsetsController：后者要 API 30，app 的 minSdk 是 24。
// - 命令从 tauri 的 ipc 线程进来，窗口与 insets 的操作必须在主线程，所以先切主线程。
// - 安全区不从这里给：前端用 `env(safe-area-inset-*)`（Android WebView 与 iOS 都提供，
//   实测 Android 17 上状态栏 49px、导航栏 24px，栏隐藏时底部那个自己变成 0），
//   全应用同一个来源，这里只管栏的显隐与图标明暗。
// - `enableEdgeToEdge()`（MainActivity 的 onCreate）已经把栏设为透明并让内容铺满整窗，
//   这里只改显隐与图标明暗，不动那条设置。

package io.github.fw6.mojuan.systembars

import android.app.Activity
import android.os.Handler
import android.os.Looper
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/** 系统栏设置请求（字段名与 Rust 侧 `SystemBarsRequest` 的 camelCase 一致）。 */
@InvokeArg
class SystemBarsArgs {
  var hidden: Boolean = false
  var lightIcons: Boolean = true
}

@TauriPlugin
class SystemBarsPlugin(private val activity: Activity) : Plugin(activity) {

  /** 主线程 Handler：命令从 tauri 的 ipc 线程进来。 */
  private val main = Handler(Looper.getMainLooper())

  @Command
  fun setSystemBars(invoke: Invoke) {
    val args = invoke.parseArgs(SystemBarsArgs::class.java)
    main.post { apply(invoke, args) }
  }

  private fun apply(invoke: Invoke, args: SystemBarsArgs) {
    val window = activity.window
    val controller = WindowCompat.getInsetsController(window, window.decorView)
    // 隐藏状态下从边缘滑入唤出的临时栏：沉浸阅读里这是重新看到系统栏的唯一方式
    controller.systemBarsBehavior =
      WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    // 图标明暗：暗画布上要浅色图标，否则浅色主题下时钟与手势条落在黑底上看不见
    controller.isAppearanceLightStatusBars = !args.lightIcons
    controller.isAppearanceLightNavigationBars = !args.lightIcons
    if (args.hidden) {
      controller.hide(WindowInsetsCompat.Type.systemBars())
    } else {
      controller.show(WindowInsetsCompat.Type.systemBars())
    }
    invoke.resolve(JSObject().put("ok", true))
  }
}

