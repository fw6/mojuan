// mojuan 移动端隐藏 webview 渲染通道（Android 侧）。
//
// Rust 侧（tauri-plugin-mojuan-render 的 mobile.rs）经 JNI 调 `render` 命令，把目标 URL
// 与判定脚本一起送进来；这里用一个「离屏 webview」加载页面，等 JS 挑战跑完、页面稳定
// 后取回 outerHTML，经 invoke.resolve 交回 Rust。
//
// - 判定与节奏全部来自 Rust 侧请求：状态脚本、取 HTML 的脚本、轮询间隔、整体超时
//   （mojuan_core::crawler::render），这里只负责「加载 → 按间隔评估 → 连续两次干净 →
//   取 HTML」，与桌面端 render.rs 同判据。
// - 单实例复用：验证 cookie（cf_clearance / gatekeeper ticket）由 WebView 的持久化
//   cookie 存储保留，后续渲染与重启应用都能复用。
// - 不用导航回调做门控（桌面端实测跨站重定向会丢事件），页面就绪以轮询为准。

package io.github.fw6.mojuan.render

import android.annotation.SuppressLint
import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONException
import org.json.JSONObject
import org.json.JSONTokener

/** 渲染请求（字段名与 Rust 侧 `RenderRequest` 的 camelCase 一致）。 */
@InvokeArg
class RenderArgs {
  lateinit var url: String
  lateinit var stateScript: String
  lateinit var htmlScript: String
  var pollMs: Long = 500
  var timeoutMs: Long = 60000
}

@TauriPlugin
class RenderPlugin(private val activity: Activity) : Plugin(activity) {

  /** 主线程 Handler：命令可能在任意线程进来，而 WebView 的一切操作都必须在主线程。 */
  private val main = Handler(Looper.getMainLooper())

  /** 离屏 webview（懒创建；渲染进程崩溃后置空，下次渲染重建）。 */
  private var webView: WebView? = null

  /** 当前渲染（单飞：一次只渲染一个页面，与 Rust 侧互斥锁双重保护）。 */
  private var pending: PendingRender? = null

  /** 一次渲染的结算状态：invoke 只结算一次，超时计时与 webview 回调互不依赖。 */
  private class PendingRender(val invoke: Invoke, val args: RenderArgs) {
    var settled = false
    var cleanStreak = 0
    var lastState = ""
    var lastNavigationError: String? = null
  }

  @Command
  fun render(invoke: Invoke) {
    val args = invoke.parseArgs(RenderArgs::class.java)
    main.post { startRender(invoke, args) }
  }

  /** 应用退出时释放 webview；在途渲染立即失败（回调不会再到达）。 */
  override fun onDestroy(activity: AppCompatActivity) {
    webView?.let { destroyWebView(it) }
    webView = null
    pending?.let { finishReject(it, "应用已退出，渲染中止") }
  }

  private fun startRender(invoke: Invoke, args: RenderArgs) {
    if (!args.url.startsWith("http://") && !args.url.startsWith("https://")) {
      invoke.reject("渲染通道只支持 http(s): ${args.url}")
      return
    }
    if (pending != null) {
      invoke.reject("渲染通道忙：上一次渲染尚未结束")
      return
    }
    val view = ensureWebView()
    val state = PendingRender(invoke, args)
    pending = state
    // 整体超时用独立的 postDelayed：渲染进程卡死时 evaluateJavascript 回调不会到达，
    // 结论只能由计时器给出；结算只认第一次（PendingRender.settled）。
    main.postDelayed({
      val navigation = state.lastNavigationError?.let { "；导航错误: $it" } ?: ""
      finishReject(
        state,
        "渲染超时（页面加载未完成或验证未通过）: ${args.url}；最后状态: ${state.lastState}$navigation"
      )
    }, args.timeoutMs)
    // 复位到 about:blank：目标导航必为全新的跨文档加载，href 判定不受残留文档干扰
    view.loadUrl("about:blank")
    waitReset(view, state, System.currentTimeMillis() + RESET_TIMEOUT_MS)
  }

  @SuppressLint("SetJavaScriptEnabled")
  private fun ensureWebView(): WebView {
    webView?.let { return it }
    val view = WebView(activity)
    view.settings.javaScriptEnabled = true
    view.settings.domStorageEnabled = true
    view.webViewClient = object : WebViewClient() {
      override fun onReceivedError(
        view: WebView,
        request: WebResourceRequest,
        error: WebResourceError
      ) {
        // 只记主文档的失败（子资源失败不影响解析）；ERR_ABORTED 是复位导航被目标导航
        // 接替时的常态，不算失败。门控仍以轮询为准，这里只做诊断。
        if (request.isForMainFrame && error.errorCode != ERR_ABORTED) {
          pending?.lastNavigationError = "code=${error.errorCode} ${error.description}"
        }
      }

      override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
        // 返回 true 表示已处理：应用不跟着崩溃，当前渲染立即失败，实例丢弃重建
        if (webView === view) {
          webView = null
        }
        pending?.let { finishReject(it, "webview 渲染进程已崩溃: ${it.args.url}") }
        destroyWebView(view)
        return true
      }
    }
    attachOffscreen(view)
    webView = view
    return view
  }

  /** 销毁 webview：必须先移出视图树（还在树上的 `destroy()` 会报警告并留下悬挂引用）。 */
  private fun destroyWebView(view: WebView) {
    (view.parent as? ViewGroup)?.removeView(view)
    view.destroy()
  }

  /**
   * 把离屏 webview 挂载到窗口里再移出可见区域。
   *
   * 不进视图树的 WebView 会被当作不可见页面节流（定时器被拉开间隔，验证挑战的 JS
   * 可能跑不完），所以这里把它加进 decorView 并整体位移到屏幕之外：对系统而言它是
   * 「已显示」的普通子视图，对用户不可见。布局视口按 1280x800 CSS px（device
   * independent px，即物理尺寸乘 density）——桌面端隐藏窗口用的是同一视口尺寸，
   * 目标站的响应式布局因此与桌面端接近；UA 保持平台默认不伪装（Cloudflare 会比对
   * UA 与客户端提示，改 UA 反而更容易被判定为机器人，而通过验证是本通道的第一要务）。
   */
  private fun attachOffscreen(view: WebView) {
    val density = activity.resources.displayMetrics.density
    val width = (VIEWPORT_WIDTH * density).toInt()
    val height = (VIEWPORT_HEIGHT * density).toInt()
    val decor = activity.window.decorView as ViewGroup
    decor.addView(view, ViewGroup.LayoutParams(width, height))
    view.translationX = -2f * width
    view.translationY = -2f * height
    view.isClickable = false
    view.isFocusable = false
    view.isFocusableInTouchMode = false
  }

  /** 复位阶段：等 href 变成 about:blank（超时不报错，目标导航会覆盖旧文档）。 */
  private fun waitReset(view: WebView, state: PendingRender, deadline: Long) {
    if (state.settled) return
    evalState(view, state) { snapshot ->
      if (state.settled) return@evalState
      if (snapshot?.optString("href") == "about:blank" || System.currentTimeMillis() >= deadline) {
        view.loadUrl(state.args.url)
        pollTarget(view, state)
      } else {
        main.postDelayed({ waitReset(view, state, deadline) }, RESET_POLL_MS)
      }
    }
  }

  /** 目标页面轮询：拒绝页立即失败，连续两次「干净」后取 HTML，其余等下一轮。 */
  private fun pollTarget(view: WebView, state: PendingRender) {
    if (state.settled) return
    evalState(view, state) { snapshot ->
      if (state.settled) return@evalState
      when {
        // 文档切换瞬间 / 页面脚本繁忙：按未就绪继续轮询，整体超时兜底
        snapshot == null -> state.cleanStreak = 0
        snapshot.optBoolean("denied") -> {
          finishReject(state, "Cloudflare 拒绝访问（错误页/访问被拒）: ${state.args.url}")
          return@evalState
        }
        snapshot.optBoolean("clean") -> {
          // 连续两次干净才算稳定（挑战页跳转瞬间防误提取，与桌面端判据一致）
          state.cleanStreak += 1
          if (state.cleanStreak >= CLEAN_CHECKS) {
            extractHtml(view, state)
            return@evalState
          }
        }
        else -> state.cleanStreak = 0
      }
      main.postDelayed({ pollTarget(view, state) }, state.args.pollMs)
    }
  }

  private fun extractHtml(view: WebView, state: PendingRender) {
    view.evaluateJavascript(state.args.htmlScript) { value ->
      if (state.settled) return@evaluateJavascript
      val html = parseJson(value) as? String
      if (html.isNullOrBlank()) {
        finishReject(state, "渲染结果提取失败: ${state.args.url}")
      } else {
        finishResolve(state, html)
      }
    }
  }

  /** 评估状态脚本，把状态对象（`{rs, href, ch, denied, clean}`）交给回调；解析不出算未就绪。 */
  private fun evalState(view: WebView, state: PendingRender, then: (JSONObject?) -> Unit) {
    view.evaluateJavascript(state.args.stateScript) { value ->
      val snapshot = parseJson(value) as? JSONObject
      if (snapshot != null) {
        state.lastState = snapshot.toString()
        if (Log.isLoggable(TAG, Log.DEBUG)) {
          Log.d(TAG, "状态: $snapshot")
        }
      }
      then(snapshot)
    }
  }

  private fun finishResolve(state: PendingRender, html: String) {
    if (state.settled) return
    state.settled = true
    pending = null
    // 验证 cookie 写入磁盘：重启应用后仍是已验证状态
    CookieManager.getInstance().flush()
    val ret = JSObject()
    ret.put("html", html)
    state.invoke.resolve(ret)
  }

  private fun finishReject(state: PendingRender, message: String) {
    if (state.settled) return
    state.settled = true
    pending = null
    Log.w(TAG, message)
    state.invoke.reject(message)
  }

  /** evaluateJavascript 的回调值是 JSON 文本（字符串结果带引号与转义），解回 Kotlin 值。 */
  private fun parseJson(value: String?): Any? {
    if (value == null || value == "null") return null
    return try {
      JSONTokener(value).nextValue()
    } catch (ex: JSONException) {
      null
    }
  }

  companion object {
    private const val TAG = "MojuanRender"

    /** net::ERR_ABORTED：复位导航被目标导航接替时的常态错误码，不算失败。 */
    private const val ERR_ABORTED = -3

    /** 离屏 webview 的布局视口（CSS px；物理尺寸按屏幕 density 换算）。 */
    private const val VIEWPORT_WIDTH = 1280
    private const val VIEWPORT_HEIGHT = 800

    /** 复位 about:blank 的等待上限与轮询间隔。 */
    private const val RESET_TIMEOUT_MS = 5000L
    private const val RESET_POLL_MS = 100L

    /** 连续两次「干净」才算稳定。 */
    private const val CLEAN_CHECKS = 2
  }
}
