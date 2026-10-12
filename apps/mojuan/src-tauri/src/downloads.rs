//! 下载队列的命令面与进度出口（队列状态机与运行时在 mojuan-core 的 `native::download`）。
//!
//! 进度优先走 Channel（强类型/有序，绑定发起 subscribe 的 webview，随主窗口常驻；
//! research #21）；send 失败（webview 已销毁）则清掉并 emit 回退。

use mojuan_core::{DownloadProgress, DownloadRuntime, DownloadTask, ProgressSink};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tauri::{Emitter, Manager};

/// 进度推送事件名（grilling #22 #6 定案；Channel 失效时的 emit 回退）。
const DOWNLOAD_EVENT: &str = "download://progress";

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
#[tauri::command]
pub async fn enqueue_download(
    runtime: tauri::State<'_, DownloadRuntime>,
    source: String,
    comic_id: String,
    comic_title: String,
    chapter_index: i64,
    dir: String,
    referer: String,
    urls: Vec<String>,
) -> Result<String, String> {
    let task = DownloadTask::new(
        &source,
        &comic_id,
        &comic_title,
        chapter_index,
        &dir,
        &referer,
        urls,
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
