//! 下载队列的命令面与进度出口（队列状态机与运行时在 mojuan-core 的 `native::download`）。
//!
//! 进度优先走 Channel（强类型/有序，绑定发起 subscribe 的 webview，随主窗口常驻；
//! research #21）；send 失败（webview 已销毁）则清掉并 emit 回退。

use mojuan_core::{DownloadProgress, DownloadRuntime, DownloadTask, ProgressSink, RepairOutcome};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tauri::{Emitter, Manager};

/// 进度推送事件名（grilling #22 #6 定案；Channel 失效时的 emit 回退）。
const DOWNLOAD_EVENT: &str = "download://progress";

/// 队列结构变化的事件名（有作品被整组移除时广播，下载页据此重取快照）。
const DOWNLOAD_CHANGED_EVENT: &str = "download://changed";

/// 进度出口：持有订阅的 Channel，运行时经它把进度交给前端。
pub struct DownloadSink {
    app: tauri::AppHandle,
    channel: Mutex<Option<Channel<DownloadProgress>>>,
}

impl DownloadSink {
    fn push(&self, progress: DownloadProgress) {
        let channel = self.channel.lock().unwrap().clone();
        if let Some(ch) = channel {
            if ch.send(progress.clone()).is_ok() {
                return;
            }
            self.channel.lock().unwrap().take();
        }
        let _ = self.app.emit(DOWNLOAD_EVENT, progress);
    }
}

/// 装配下载：建进度出口、注册运行时并起常驻 worker（setup 时调用一次）。
pub fn init(app: &tauri::AppHandle) {
    let sink = Arc::new(DownloadSink {
        app: app.clone(),
        channel: Mutex::new(None),
    });
    app.manage(sink.clone());
    let progress: ProgressSink = Box::new(move |p| sink.push(p));
    let runtime = DownloadRuntime::new(progress);
    runtime.start_workers(mojuan_core::DEFAULT_WORKERS);
    app.manage(runtime);
}

/// 前端订阅下载进度（Downloads 页挂载时调用；Channel 存 State 供 worker 长期持有）。
#[tauri::command]
pub fn subscribe_downloads(
    sink: tauri::State<'_, Arc<DownloadSink>>,
    channel: Channel<DownloadProgress>,
) {
    *sink.channel.lock().unwrap() = Some(channel);
}

/// 前端退订（Downloads 页卸载时清理，grilling #23 #6：组件生命周期清理）。
#[tauri::command]
pub fn unsubscribe_downloads(sink: tauri::State<'_, Arc<DownloadSink>>) {
    *sink.channel.lock().unwrap() = None;
}

/// 队列快照（Downloads 页初始加载；任务视图含展示字段）。
#[tauri::command]
pub fn get_downloads(runtime: tauri::State<'_, DownloadRuntime>) -> String {
    serde_json::to_string(&runtime.snapshot()).unwrap_or_else(|_| "[]".to_string())
}

/// 入队一话下载（grilling #22）：去重 = 已在磁盘标 done 不入队；taskId 已在队列 → AlreadyQueued。
/// 返回 JSON `{"result": "queued"|"alreadyDownloaded"|"alreadyQueued", "progress": {...}}`。
/// 作品封面与话名一并入队：下载页的卡片与章节行据此显示，不必回源。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn enqueue_download(
    runtime: tauri::State<'_, DownloadRuntime>,
    source: String,
    comic_id: String,
    comic_title: String,
    comic_cover: String,
    chapter_index: i64,
    chapter_title: String,
    dir: String,
    referer: String,
    urls: Vec<String>,
) -> Result<String, String> {
    let task = DownloadTask::new(
        &source,
        &comic_id,
        &comic_title,
        &comic_cover,
        chapter_index,
        &chapter_title,
        &dir,
        &referer,
        &urls,
    );
    let (result, progress) = runtime.enqueue(task);
    Ok(serde_json::json!({ "result": result.as_str(), "progress": progress }).to_string())
}

/// 取消任务（排队/下载中 → cancelled）。返回任务进度 JSON 或 `null`。
#[tauri::command]
pub fn cancel_download(runtime: tauri::State<'_, DownloadRuntime>, task_id: String) -> String {
    match runtime.cancel(&task_id) {
        Some(progress) => serde_json::to_string(&progress).unwrap_or_default(),
        None => "null".to_string(),
    }
}

/// 重试任务（failed/cancelled → 重新排队）。返回任务进度 JSON 或 `null`。
#[tauri::command]
pub fn retry_download(runtime: tauri::State<'_, DownloadRuntime>, task_id: String) -> String {
    match runtime.retry(&task_id) {
        Some(progress) => serde_json::to_string(&progress).unwrap_or_default(),
        None => "null".to_string(),
    }
}

/// 清空已完成（done/failed/cancelled），返回移除数量。
#[tauri::command]
pub fn clear_downloads(runtime: tauri::State<'_, DownloadRuntime>) -> usize {
    runtime.clear_finished()
}

/// 补下一话缺失或损坏的页（存储页的「重新下载缺失的页」）：有页清单的用清单里的页序，
/// 没有页清单的旧下载从源取一次这一话的页表再重建页序，只把不完整的页交给下载运行时入队。
/// 回源取页表与算要补的页都在 core 的运行时里（`DownloadRuntime::repair`），这里只把结果转成 JSON：
/// `{"result": "queued"|"alreadyQueued"|"nothingToRepair"|"noPageTable", "pages": <要补的页数>,
/// "progress": {...}|null, "reason": <noPageTable 时的原因>}`。
/// 取源页表会发网络请求，与算要补的页一起走阻塞线程。
#[tauri::command]
pub async fn repair_download(
    runtime: tauri::State<'_, DownloadRuntime>,
    dir: String,
    source: String,
    comic_id: String,
    chapter_index: i64,
    referer: String,
) -> Result<String, String> {
    let cache_dir = crate::APP_CACHE_DIR.get().cloned().unwrap_or_default();
    let runtime = (*runtime).clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        runtime.repair(
            &dir,
            &source,
            &comic_id,
            chapter_index,
            &referer,
            &cache_dir,
        )
    })
    .await
    .map_err(|e| format!("补下任务异常终止: {e}"))?;
    Ok(repair_json(outcome))
}

/// 把补下结果转成前端 JSON（四种结果各一条，`pages` 与 `progress` 各结果都在）。
fn repair_json(outcome: RepairOutcome) -> String {
    let value = match outcome {
        RepairOutcome::Queued { pages, progress } => serde_json::json!({
            "result": "queued",
            "pages": pages,
            "progress": progress,
        }),
        RepairOutcome::AlreadyQueued { pages, progress } => serde_json::json!({
            "result": "alreadyQueued",
            "pages": pages,
            "progress": progress,
        }),
        RepairOutcome::NothingToRepair => serde_json::json!({
            "result": "nothingToRepair",
            "pages": 0,
            "progress": serde_json::Value::Null,
        }),
        RepairOutcome::NoPageTable { reason } => serde_json::json!({
            "result": "noPageTable",
            "pages": 0,
            "progress": serde_json::Value::Null,
            "reason": reason,
        }),
    };
    value.to_string()
}

/// 删除某部作品的下载：先取消并移除该作品在下载队列里的任务（在途的页等它写完），
/// 再删磁盘上的整目录。队列被移除的记录经 `download://changed` 广播——进度通道
/// 只能表达单任务的状态变化，表达不了「这个作品整个没了」，下载页据此重取快照。
#[tauri::command]
pub async fn delete_downloaded(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, DownloadRuntime>,
    dir: String,
    source: String,
    comic_id: String,
) -> Result<(), String> {
    let runtime = (*runtime).clone();
    let (dropped, deleted) = tauri::async_runtime::spawn_blocking(move || {
        let dropped = runtime.drop_comic(&source, &comic_id);
        let deleted = mojuan_core::delete_downloaded(&dir, &source, &comic_id);
        (dropped, deleted)
    })
    .await
    .map_err(|e| format!("删除下载异常终止: {e}"))?;
    if dropped > 0 {
        let _ = app.emit(DOWNLOAD_CHANGED_EVENT, ());
    }
    deleted.map(|_| ())
}
