//! 系统栏（状态栏与导航栏）的命令面：把阅读器的沉浸式状态交给原生侧。
//!
//! 桌面端没有系统栏，插件的桌面实现什么都不做——命令在两端都注册，前端不必按平台
//! 分叉（桌面窗口缩到移动端宽度也不会调到不存在的命令）。

/// 设置系统栏的显隐与图标明暗。
///
/// 同步等待原生侧结算，所以在后台线程上跑：同步命令在主线程执行，直接调用会等在
/// 主线程上，而原生侧要回主线程才能应用设置。
#[tauri::command]
pub async fn set_system_bars(
    app: tauri::AppHandle,
    hidden: bool,
    light_icons: bool,
) -> Result<(), String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        tauri_plugin_mojuan_system_bars::set_system_bars(&handle, hidden, light_icons)
    })
    .await
    .map_err(|e| format!("系统栏设置无法调度到后台线程：{e}"))?
}
