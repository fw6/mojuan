# 安装结果接收器的类名只出现在 manifest 与 PendingIntent 里，R8 看不到静态引用。
-keep class io.github.fw6.mojuan.update.InstallResultReceiver {
  public <init>(...);
  public void onReceive(android.content.Context, android.content.Intent);
}
