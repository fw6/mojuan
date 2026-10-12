// mojuan Android OTA 安装通道（Android 侧）。
//
// Rust 侧（tauri-plugin-mojuan-update 的 mobile.rs）经 JNI 调三个命令：
//   install(path)          把下载好的 APK 交给系统安装器
//   canInstall()           是否已获得「安装未知应用」授权
//   openInstallSettings()  跳到该授权页
//
// 安装走 PackageInstaller 会话而不是 ACTION_VIEW：会话能把结果（成功 / 失败原因）
// 回报给调用方，ACTION_VIEW 拉起安装器之后就断了。会话自己把字节写进安装器存储，
// 不需要 FileProvider 参与。
//
// 交出去之前先比一次签名：Android 只允许同签名的包覆盖安装，不先比，用户要在系统
// 安装器里走完才看到一句看不懂的失败。
//
// 结算只在主线程：命令从 tauri 的 ipc 线程进来，建会话（几十兆的拷贝）在后台线程，
// commit 与结果回调回到主线程。

package io.github.fw6.mojuan.update

import android.app.Activity
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import androidx.appcompat.app.AppCompatActivity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.security.MessageDigest

/** 安装请求（字段名与 Rust 侧 `InstallRequest` 的 camelCase 一致）。 */
@InvokeArg
class InstallArgs {
  lateinit var path: String
}

@TauriPlugin
class UpdatePlugin(private val activity: Activity) : Plugin(activity) {

  /** 主线程 Handler：startActivity 与 invoke 结算都在主线程。 */
  private val main = Handler(Looper.getMainLooper())

  /** 保护 [pending] 的取值与清空（命令线程与主线程都会碰）。 */
  private val lock = Any()

  /** 在途安装（单飞：一次只交一个会话给系统）。 */
  private var pending: PendingInstall? = null

  /** 一次安装的结算状态：invoke 只结算一次，超时计时与系统回调互不依赖。 */
  private class PendingInstall(val invoke: Invoke) {
    var settled = false
    var timeout: Runnable? = null
  }

  /** 交出去的安装包被拒绝时抛出的可读原因。 */
  private class Refused(message: String) : Exception(message)

  @Command
  fun install(invoke: Invoke) {
    val args = invoke.parseArgs(InstallArgs::class.java)
    val state = synchronized(lock) {
      if (pending != null) null else PendingInstall(invoke).also { pending = it }
    }
    if (state == null) {
      invoke.reject("已有安装在进行")
      return
    }
    // 建会话要把整个 APK 拷进安装器存储，几十兆的拷贝不能放主线程
    Thread {
      val session = try {
        prepare(args.path)
      } catch (ex: Refused) {
        main.post { finish(state, null, ex.message ?: "安装中止") }
        return@Thread
      } catch (ex: Exception) {
        main.post { finish(state, null, "建立安装会话失败：${ex.message}") }
        return@Thread
      }
      main.post { commit(state, session) }
    }.start()
  }

  @Command
  fun canInstall(invoke: Invoke) {
    main.post {
      val ret = JSObject()
      ret.put("allowed", isInstallAllowed())
      invoke.resolve(ret)
    }
  }

  @Command
  fun openInstallSettings(invoke: Invoke) {
    main.post {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val intent = Intent(
          Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
          Uri.parse("package:${activity.packageName}"),
        )
        try {
          activity.startActivity(intent)
        } catch (ex: Exception) {
          invoke.reject("无法打开「安装未知应用」设置页：${ex.message}")
          return@post
        }
      }
      val ret = JSObject()
      ret.put("ok", true)
      invoke.resolve(ret)
    }
  }

  /** 应用退出时中止在途安装（回调不会再到达）。 */
  override fun onDestroy(activity: AppCompatActivity) {
    InstallResultReceiver.current = null
    pending?.let { finish(it, null, "应用已退出，安装中止") }
  }

  // ---------- 建会话（后台线程） ----------

  /** 校验并建好待提交的安装会话。 */
  private fun prepare(path: String): PackageInstaller.Session {
    val apk = File(path)
    if (!apk.isFile) {
      throw Refused("安装包不存在：$path")
    }
    if (!isInstallAllowed()) {
      throw Refused("尚未允许安装未知应用：请先在系统设置里为本应用打开「安装未知应用」")
    }
    signerMismatch(apk)?.let { throw Refused(it) }
    return writeSession(apk)
  }

  private fun writeSession(apk: File): PackageInstaller.Session {
    val installer = activity.packageManager.packageInstaller
    val params =
      PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
    val session = installer.openSession(installer.createSession(params))
    try {
      session.openWrite(APK_NAME, 0, apk.length()).use { out ->
        apk.inputStream().use { input -> input.copyTo(out) }
        session.fsync(out)
      }
    } catch (ex: Exception) {
      session.abandon()
      throw ex
    }
    return session
  }

  // ---------- 提交与结算（主线程） ----------

  private fun commit(state: PendingInstall, session: PackageInstaller.Session) {
    // 超时先挂上：系统回报第一个状态通常紧跟 commit，没有回应就是出问题了
    val timeout = Runnable { finish(state, null, "系统安装器没有回应（${TIMEOUT_MS / 1000} 秒）") }
    state.timeout = timeout
    main.postDelayed(timeout, TIMEOUT_MS)

    InstallResultReceiver.current = { intent -> onStatus(state, intent) }
    val intent = Intent(activity, InstallResultReceiver::class.java)
    intent.setPackage(activity.packageName)
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
    val status = PendingIntent.getBroadcast(activity, 0, intent, flags)
    try {
      session.commit(status.intentSender)
    } catch (ex: Exception) {
      session.close()
      finish(state, null, "提交安装会话失败：${ex.message}")
      return
    }
    session.close()
  }

  /** 系统回报的状态：交出确认界面、报成功、报失败。 */
  private fun onStatus(state: PendingInstall, intent: Intent) {
    val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
    val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
    when (status) {
      PackageInstaller.STATUS_PENDING_USER_ACTION -> {
        @Suppress("DEPRECATION")
        val confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT) as? Intent
        if (confirm == null) {
          finish(state, null, "系统安装器没有给出确认界面")
          return
        }
        try {
          activity.startActivity(confirm)
        } catch (ex: Exception) {
          finish(state, null, "无法拉起系统安装确认界面：${ex.message}")
          return
        }
        finish(state, "confirming", null)
      }
      PackageInstaller.STATUS_SUCCESS -> finish(state, "installed", null)
      else -> finish(state, null, failureText(status, message))
    }
  }

  /** 结算一次：成功给状态，失败给原因；重复调用无效果。 */
  private fun finish(state: PendingInstall, status: String?, message: String?) {
    val invoke = synchronized(lock) {
      if (state.settled) return
      state.settled = true
      state.timeout?.let { main.removeCallbacks(it) }
      InstallResultReceiver.current = null
      pending = null
      state.invoke
    }
    if (message != null) {
      Log.w(TAG, message)
      invoke.reject(message)
      return
    }
    val ret = JSObject()
    ret.put("status", status)
    invoke.resolve(ret)
  }

  // ---------- 授权与签名判定 ----------

  /** 是否已获得「安装未知应用」授权（Android 8.0 以下没有这道开关）。 */
  private fun isInstallAllowed(): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||
      activity.packageManager.canRequestPackageInstalls()

  /**
   * 下载包的签名与已安装应用不一致时返回可读原因（一致返回 null）。
   *
   * 比的是 APK 内容的实际签名者（`apkContentsSigners`）：这正是系统在覆盖安装时
   * 用来判定的那组证书。
   */
  private fun signerMismatch(apk: File): String? {
    val pm = activity.packageManager
    val archive = archiveInfo(pm, apk.absolutePath)
      ?: return "无法读取安装包的签名信息：${apk.name}"
    val installed = try {
      installedInfo(pm)
    } catch (ex: Exception) {
      return "无法读取当前应用的签名信息：${ex.message}"
    }
    val theirs = signerDigests(archive)
    val ours = signerDigests(installed)
    if (theirs.isEmpty() || ours.isEmpty()) {
      return "读不到签名证书，无法确认安装包来源"
    }
    if (theirs == ours) {
      return null
    }
    return "安装包签名与当前安装的版本不一致：需要先卸载再安装"
  }

  private fun archiveInfo(pm: PackageManager, path: String): PackageInfo? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      pm.getPackageArchiveInfo(path, PackageManager.GET_SIGNING_CERTIFICATES)
    } else {
      @Suppress("DEPRECATION")
      pm.getPackageArchiveInfo(path, PackageManager.GET_SIGNATURES)
    }

  private fun installedInfo(pm: PackageManager): PackageInfo =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      pm.getPackageInfo(activity.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
    } else {
      @Suppress("DEPRECATION")
      pm.getPackageInfo(activity.packageName, PackageManager.GET_SIGNATURES)
    }

  /** 签名证书的 SHA-256 摘要集合（多签名时逐个取出）。 */
  private fun signerDigests(info: PackageInfo): Set<String> {
    val signatures = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      info.signingInfo?.apkContentsSigners ?: return emptySet()
    } else {
      @Suppress("DEPRECATION")
      info.signatures ?: return emptySet()
    }
    val digest = MessageDigest.getInstance("SHA-256")
    return signatures.map { signature ->
      digest.reset()
      digest.digest(signature.toByteArray()).joinToString("") { "%02x".format(it) }
    }.toSet()
  }

  /** 系统安装失败的状态码 → 可读原因（EXTRA_STATUS_MESSAGE 原文附在后面）。 */
  private fun failureText(status: Int, message: String?): String {
    val reason = when (status) {
      PackageInstaller.STATUS_FAILURE_BLOCKED -> "被系统或安全软件拦下"
      PackageInstaller.STATUS_FAILURE_ABORTED -> "安装已中止"
      PackageInstaller.STATUS_FAILURE_INVALID -> "安装包无效"
      PackageInstaller.STATUS_FAILURE_CONFLICT -> "与已安装的版本冲突（签名或版本号不一致）"
      PackageInstaller.STATUS_FAILURE_STORAGE -> "存储空间不足"
      PackageInstaller.STATUS_FAILURE_INCOMPATIBLE -> "与当前系统不兼容"
      else -> "未知原因"
    }
    return if (message.isNullOrBlank()) {
      "系统安装失败：$reason"
    } else {
      "系统安装失败：$reason（$message）"
    }
  }

  companion object {
    private const val TAG = "MojuanUpdate"

    /** 写入安装器会话的临时文件名（会话内名字，不落用户可见目录）。 */
    private const val APK_NAME = "mojuan.apk"

    /** 等系统回报第一个状态的上限：`STATUS_PENDING_USER_ACTION` 紧随 commit 到达。 */
    private const val TIMEOUT_MS = 30_000L
  }
}
