//! 下载任务队列状态机（wayfinder #20/#22 定案）。
//!
//! 纯逻辑、无 Tauri 依赖：任务 = 一话（章内按页下载）；状态机
//! queued/downloading/done/failed/cancelled；去重 = 已在磁盘入队即 done；
//! 内存态不持久化（重启清空）。
//! 并发（全局 2 页、章内顺序）、重试、取消检查与进度推送在 `native::download` 的运行时。

use serde::Serialize;

/// 任务状态（grilling #22 #3）。
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Queued,
    Downloading,
    Done,
    Failed,
    Cancelled,
}

/// 进度事件载荷（grilling #22 #6 定案）：`{taskId, status, done, total, error?}`。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub task_id: String,
    pub status: TaskStatus,
    pub done: usize,
    pub total: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 任务快照（get_downloads）：进度 + 展示字段（下载页任务行需要标题/话数）。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadTaskView {
    pub task_id: String,
    pub source: String,
    pub comic_id: String,
    pub comic_title: String,
    pub chapter_index: i64,
    pub status: TaskStatus,
    pub done: usize,
    pub total: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 一个下载任务 = 一话（页 URL 入队时快照，之后不变）。
#[derive(Clone)]
pub struct DownloadTask {
    pub task_id: String,
    pub source: String,
    pub comic_id: String,
    pub comic_title: String,
    pub chapter_index: i64,
    pub dir: String,
    pub referer: String,
    pub urls: Vec<String>,
    pub done: usize,
    pub status: TaskStatus,
    pub error: Option<String>,
}

impl DownloadTask {
    /// 一话的下载任务：taskId 由 `source/comicId/chapterIndex` 派生，状态从 queued 起。
    pub fn new(
        source: &str,
        comic_id: &str,
        comic_title: &str,
        chapter_index: i64,
        dir: &str,
        referer: &str,
        urls: Vec<String>,
    ) -> Self {
        Self {
            task_id: task_id(source, comic_id, chapter_index),
            source: source.to_string(),
            comic_id: comic_id.to_string(),
            comic_title: comic_title.to_string(),
            chapter_index,
            dir: dir.to_string(),
            referer: referer.to_string(),
            urls,
            done: 0,
            status: TaskStatus::Queued,
            error: None,
        }
    }

    pub fn total(&self) -> usize {
        self.urls.len()
    }

    pub fn to_progress(&self) -> DownloadProgress {
        DownloadProgress {
            task_id: self.task_id.clone(),
            status: self.status,
            done: self.done,
            total: self.total(),
            error: self.error.clone(),
        }
    }

    pub fn to_view(&self) -> DownloadTaskView {
        DownloadTaskView {
            task_id: self.task_id.clone(),
            source: self.source.clone(),
            comic_id: self.comic_id.clone(),
            comic_title: self.comic_title.clone(),
            chapter_index: self.chapter_index,
            status: self.status,
            done: self.done,
            total: self.total(),
            error: self.error.clone(),
        }
    }
}

/// 确定性任务 id（grilling #22 #7）：`${source}/${comicId}/${chapterIndex}`，与去重键一致。
pub fn task_id(source: &str, comic_id: &str, chapter_index: i64) -> String {
    format!("{source}/{comic_id}/{chapter_index}")
}

/// 入队结果（grilling #22 #4/#5）。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum EnqueueResult {
    /// 正常入队（开始排队下载）。
    Queued,
    /// 该章节已在磁盘 → 标 done 不入队（去重，不重新抓）。
    AlreadyDownloaded,
    /// 同一 taskId 已在队列中（重复入队去重）。
    AlreadyQueued,
}

impl EnqueueResult {
    pub fn as_str(&self) -> &'static str {
        match self {
            EnqueueResult::Queued => "queued",
            EnqueueResult::AlreadyDownloaded => "alreadyDownloaded",
            EnqueueResult::AlreadyQueued => "alreadyQueued",
        }
    }
}

/// 任务队列：入队顺序保存，worker 按 FIFO 领取。
#[derive(Default)]
pub struct DownloadQueue {
    tasks: Vec<DownloadTask>,
}

impl DownloadQueue {
    pub fn new() -> Self {
        Self { tasks: Vec::new() }
    }

    /// 入队：taskId 已存在 → AlreadyQueued；`already_downloaded`（调用方查磁盘）
    /// → 标 done 不入队；否则 Queued。返回结果与任务当前进度。
    pub fn enqueue(
        &mut self,
        task: DownloadTask,
        already_downloaded: bool,
    ) -> (EnqueueResult, DownloadProgress) {
        if let Some(existing) = self.tasks.iter().find(|t| t.task_id == task.task_id) {
            return (EnqueueResult::AlreadyQueued, existing.to_progress());
        }
        if already_downloaded {
            let mut done = task;
            done.status = TaskStatus::Done;
            done.done = done.total();
            let p = done.to_progress();
            self.tasks.push(done);
            return (EnqueueResult::AlreadyDownloaded, p);
        }
        let p = task.to_progress();
        self.tasks.push(task);
        (EnqueueResult::Queued, p)
    }

    /// worker 领取下一个 queued 任务（标记 downloading），FIFO。无任务返回 None。
    pub fn next_queued(&mut self) -> Option<DownloadTask> {
        let idx = self
            .tasks
            .iter()
            .position(|t| t.status == TaskStatus::Queued)?;
        self.tasks[idx].status = TaskStatus::Downloading;
        Some(self.tasks[idx].clone())
    }

    /// 单页下载完成：done +1；达到 total → Done。
    pub fn mark_page_done(&mut self, task_id: &str) -> Option<DownloadProgress> {
        let task = self.tasks.iter_mut().find(|t| t.task_id == task_id)?;
        task.done += 1;
        if task.done >= task.total() {
            task.status = TaskStatus::Done;
        }
        Some(task.to_progress())
    }

    /// 整任务失败（单页重试耗尽）：标 failed + 错误信息。
    pub fn mark_failed(&mut self, task_id: &str, error: String) -> Option<DownloadProgress> {
        let task = self.tasks.iter_mut().find(|t| t.task_id == task_id)?;
        task.status = TaskStatus::Failed;
        task.error = Some(error);
        Some(task.to_progress())
    }

    /// 取消任务（排队/下载中 → cancelled；其余原样返回）。
    pub fn cancel(&mut self, task_id: &str) -> Option<DownloadProgress> {
        let task = self.tasks.iter_mut().find(|t| t.task_id == task_id)?;
        if matches!(
            task.status,
            TaskStatus::Queued | TaskStatus::Downloading
        ) {
            task.status = TaskStatus::Cancelled;
        }
        Some(task.to_progress())
    }

    /// 重试：failed/cancelled → 重置 done=0、清 error、回 queued（重新排队下载）。
    pub fn retry(&mut self, task_id: &str) -> Option<DownloadProgress> {
        let task = self.tasks.iter_mut().find(|t| t.task_id == task_id)?;
        if matches!(task.status, TaskStatus::Failed | TaskStatus::Cancelled) {
            task.status = TaskStatus::Queued;
            task.done = 0;
            task.error = None;
        }
        Some(task.to_progress())
    }

    /// 清空已完成（done/failed/cancelled），返回移除数量。
    pub fn clear_finished(&mut self) -> usize {
        let before = self.tasks.len();
        self.tasks.retain(|t| {
            matches!(t.status, TaskStatus::Queued | TaskStatus::Downloading)
        });
        before - self.tasks.len()
    }

    /// 任务是否已被取消（worker 每页前检查，取消则中止）。
    pub fn is_cancelled(&self, task_id: &str) -> bool {
        self.tasks
            .iter()
            .any(|t| t.task_id == task_id && t.status == TaskStatus::Cancelled)
    }

    /// 全量快照（下载页初始加载）。
    pub fn snapshot(&self) -> Vec<DownloadTaskView> {
        self.tasks.iter().map(|t| t.to_view()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(task_id: &str, pages: usize) -> DownloadTask {
        DownloadTask {
            task_id: task_id.to_string(),
            source: "webtoons".to_string(),
            comic_id: "c1".to_string(),
            comic_title: "标题".to_string(),
            chapter_index: 1,
            dir: "/tmp/dl".to_string(),
            referer: String::new(),
            urls: (0..pages).map(|i| format!("https://x/{i}.jpg")).collect(),
            done: 0,
            status: TaskStatus::Queued,
            error: None,
        }
    }

    #[test]
    fn enqueue_new_task_is_queued() {
        let mut q = DownloadQueue::new();
        let (result, p) = q.enqueue(task("a", 3), false);
        assert_eq!(result, EnqueueResult::Queued);
        assert_eq!(p.task_id, "a");
        assert_eq!(p.status, TaskStatus::Queued);
        assert_eq!(p.done, 0);
        assert_eq!(p.total, 3);
        assert!(p.error.is_none());
    }

    #[test]
    fn enqueue_duplicate_task_id_is_already_queued() {
        let mut q = DownloadQueue::new();
        q.enqueue(task("a", 2), false);
        let (result, p) = q.enqueue(task("a", 2), false);
        assert_eq!(result, EnqueueResult::AlreadyQueued);
        assert_eq!(p.status, TaskStatus::Queued);
        assert_eq!(q.snapshot().len(), 1);
    }

    #[test]
    fn enqueue_already_downloaded_marks_done() {
        let mut q = DownloadQueue::new();
        let (result, p) = q.enqueue(task("a", 3), true);
        assert_eq!(result, EnqueueResult::AlreadyDownloaded);
        assert_eq!(p.status, TaskStatus::Done);
        assert_eq!(p.done, 3);
        assert_eq!(p.total, 3);
    }

    #[test]
    fn next_queued_is_fifo_and_marks_downloading() {
        let mut q = DownloadQueue::new();
        q.enqueue(task("a", 2), false);
        q.enqueue(task("b", 2), false);
        let a = q.next_queued().unwrap();
        assert_eq!(a.task_id, "a");
        assert_eq!(a.status, TaskStatus::Downloading);
        let b = q.next_queued().unwrap();
        assert_eq!(b.task_id, "b");
        assert!(q.next_queued().is_none());
    }

    #[test]
    fn mark_page_done_completes_at_total() {
        let mut q = DownloadQueue::new();
        q.enqueue(task("a", 2), false);
        q.next_queued();
        let p = q.mark_page_done("a").unwrap();
        assert_eq!(p.done, 1);
        assert_eq!(p.status, TaskStatus::Downloading);
        let p = q.mark_page_done("a").unwrap();
        assert_eq!(p.done, 2);
        assert_eq!(p.status, TaskStatus::Done);
    }

    #[test]
    fn mark_failed_sets_error_and_status() {
        let mut q = DownloadQueue::new();
        q.enqueue(task("a", 2), false);
        q.next_queued();
        let p = q.mark_failed("a", "第 1 页下载失败".to_string()).unwrap();
        assert_eq!(p.status, TaskStatus::Failed);
        assert_eq!(p.error.as_deref(), Some("第 1 页下载失败"));
    }

    #[test]
    fn cancel_marks_cancelled_only_for_queued_or_downloading() {
        let mut q = DownloadQueue::new();
        q.enqueue(task("a", 2), false); // queued
        let p = q.cancel("a").unwrap();
        assert_eq!(p.status, TaskStatus::Cancelled);
        // done 任务不可取消（状态原样）
        q.enqueue(task("b", 2), true);
        let p = q.cancel("b").unwrap();
        assert_eq!(p.status, TaskStatus::Done);
    }

    #[test]
    fn retry_resets_failed_task_to_queued() {
        let mut q = DownloadQueue::new();
        q.enqueue(task("a", 2), false);
        q.next_queued();
        q.mark_page_done("a");
        q.mark_failed("a", "boom".to_string());
        let p = q.retry("a").unwrap();
        assert_eq!(p.status, TaskStatus::Queued);
        assert_eq!(p.done, 0);
        assert!(p.error.is_none());
        // 重试后可再次领取
        assert_eq!(q.next_queued().unwrap().task_id, "a");
    }

    #[test]
    fn clear_finished_removes_only_terminal_tasks() {
        let mut q = DownloadQueue::new();
        q.enqueue(task("done", 2), true); // done
        q.enqueue(task("failed", 2), false);
        q.next_queued();
        q.mark_failed("failed", "x".to_string());
        q.enqueue(task("cancel", 2), false);
        q.cancel("cancel");
        q.enqueue(task("queued", 2), false);
        q.enqueue(task("downloading", 2), false);
        q.next_queued();

        let removed = q.clear_finished();
        assert_eq!(removed, 3);
        let ids: Vec<String> = q.snapshot().iter().map(|v| v.task_id.clone()).collect();
        assert_eq!(ids, vec!["queued", "downloading"]);
    }

    #[test]
    fn is_cancelled_only_after_cancel() {
        let mut q = DownloadQueue::new();
        q.enqueue(task("a", 2), false);
        assert!(!q.is_cancelled("a"));
        q.cancel("a");
        assert!(q.is_cancelled("a"));
    }

    #[test]
    fn snapshot_includes_view_fields_in_fifo_order() {
        let mut q = DownloadQueue::new();
        q.enqueue(task("a", 2), false);
        q.enqueue(task("b", 2), true);
        let views = q.snapshot();
        assert_eq!(views.len(), 2);
        assert_eq!(views[0].task_id, "a");
        assert_eq!(views[0].comic_title, "标题");
        assert_eq!(views[0].chapter_index, 1);
        assert_eq!(views[1].status, TaskStatus::Done);
        assert_eq!(views[1].done, 2);
    }

    #[test]
    fn task_id_format_matches_grilling_decision() {
        assert_eq!(task_id("webtoons", "c1", 3), "webtoons/c1/3");
    }
}
