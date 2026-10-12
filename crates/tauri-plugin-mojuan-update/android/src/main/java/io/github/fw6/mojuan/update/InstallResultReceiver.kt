package io.github.fw6.mojuan.update

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * 安装会话的状态回调入口。
 *
 * `PackageInstaller.commit` 要一个 PendingIntent，系统把每次状态变化广播回来。这个类
 * 在插件 manifest 里声明（exported=false：广播由本应用自己创建的 PendingIntent 发出，
 * 带着本应用的身份），实际处理转交给 [current]——它由 [UpdatePlugin] 在提交会话前
 * 设置，结算后清空。
 */
class InstallResultReceiver : BroadcastReceiver() {

  override fun onReceive(context: Context, intent: Intent) {
    current?.invoke(intent)
  }

  companion object {
    /** 当前安装会话的结果处理（单飞：同一时刻只有一个安装在进行）。 */
    @Volatile
    var current: ((Intent) -> Unit)? = null
  }
}
