//! 下载任务队列状态机（wayfinder #20/#22 定案）。
//!
//! 纯逻辑、无 Tauri 依赖：任务 = 一话（章内按页下载）；状态机
//! queued/downloading/done/failed/cancelled；去重 = 已在磁盘入队即 done；
//! 内存态不持久化（重启清空）。
//! 并发（全局 2 页、章内顺序）、重试、取消检查与进度推送在 `native::download` 的运行时。

use crate::native::page_manifest::PageEntry;
use serde::Serialize;
use std::collections::HashSet;

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
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub task_id: String,
    pub status: TaskStatus,
    pub done: usize,
    pub total: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 任务快照（get_downloads）：进度 + 展示字段（下载页任务行需要标题/封面/话名）。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadTaskView {
    pub task_id: String,
    pub source: String,
    pub comic_id: String,
    pub comic_title: String,
    pub comic_cover: String,
    pub chapter_index: i64,
    /// 章节标题（源给的，如「第 12 话」）；话序号只是源内部的 id，不能当名字显示。
    pub chapter_title: String,
    pub status: TaskStatus,
    pub done: usize,
    pub total: usize,
    /// 这是补下任务（只下不完整的页）：下载页据此在那一行显示「补下」。
    pub repair: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 一个下载任务 = 一话。`pages` 是这一话完整的页序（写页清单用）；`pending` 是本次要下载
/// 的页在 `pages` 里的下标——普通入队是全部、修复入队只含不完整的页。
#[derive(Clone, Debug)]
pub struct DownloadTask {
    pub task_id: String,
    pub source: String,
    pub comic_id: String,
    pub comic_title: String,
    pub comic_cover: String,
    pub chapter_index: i64,
    pub chapter_title: String,
    pub dir: String,
    pub referer: String,
    pub pages: Vec<PageEntry>,
    pub pending: Vec<usize>,
    pub repair: bool,
    pub done: usize,
    pub status: TaskStatus,
    pub error: Option<String>,
}

impl DownloadTask {
    /// 一话的普通下载任务：下全部页。页序就是 URL 数组的下标（0 基，与 `page_rel_path`
    /// 的页号一致）。taskId 由 `source/comicId/chapterIndex` 派生，状态从 queued 起。
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        source: &str,
        comic_id: &str,
        comic_title: &str,
        comic_cover: &str,
        chapter_index: i64,
        chapter_title: &str,
        dir: &str,
        referer: &str,
        urls: &[String],
    ) -> Self {
        Self::with_pages(
            source,
            comic_id,
            comic_title,
            comic_cover,
            chapter_index,
            chapter_title,
            dir,
            referer,
            PageEntry::from_urls(urls),
        )
    }

    /// 核心内部构造：页序由调用方给出（修复路径从页清单取这一话完整的页序）。
    /// 宿主一律走 `new`（它只给一串页 URL）。
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn with_pages(
        source: &str,
        comic_id: &str,
        comic_title: &str,
        comic_cover: &str,
        chapter_index: i64,
        chapter_title: &str,
        dir: &str,
        referer: &str,
        pages: Vec<PageEntry>,
    ) -> Self {
        let pending = (0..pages.len()).collect();
        Self {
            task_id: task_id(source, comic_id, chapter_index),
            source: source.to_string(),
            comic_id: comic_id.to_string(),
            comic_title: comic_title.to_string(),
            comic_cover: comic_cover.to_string(),
            chapter_index,
            chapter_title: chapter_title.to_string(),
            dir: dir.to_string(),
            referer: referer.to_string(),
            pages,
            pending,
            repair: false,
            done: 0,
            status: TaskStatus::Queued,
            error: None,
        }
    }

    /// 转成修复任务：`pages` 仍是这一话完整的页序（写页清单用），只下 `pending` 里的页
    /// （`pages` 的下标，由调用方按「这一页是否完整」算出来）。只有核心的补下路径用它。
    pub(crate) fn into_repair(mut self, pending: Vec<usize>) -> Self {
        self.pending = pending;
        self.repair = true;
        self
    }

    pub fn total(&self) -> usize {
        self.pending.len()
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
            comic_cover: self.comic_cover.clone(),
            chapter_index: self.chapter_index,
            chapter_title: self.chapter_title.clone(),
            status: self.status,
            done: self.done,
            total: self.total(),
            repair: self.repair,
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
    /// 已请求取消的 taskId。删除整部作品时任务记录随即消失，而 worker 还要在下一页边界
    /// 停下，所以取消信号存在任务记录之外；重试或重新入队同一话时清掉。
    cancelled: HashSet<String>,
}

impl DownloadQueue {
    pub fn new() -> Self {
        Self {
            tasks: Vec::new(),
            cancelled: HashSet::new(),
        }
    }

    /// 入队：taskId 已存在 → AlreadyQueued；`already_downloaded`（调用方查磁盘）
    /// → 标 done 不入队；否则 Queued。返回结果与任务当前进度。
    /// 修复入队（`task.repair`）顶掉同一话已有的终态记录：否则同一个 taskId 会被判成
    /// 重复入队而什么都不做。
    pub fn enqueue(
        &mut self,
        task: DownloadTask,
        already_downloaded: bool,
    ) -> (EnqueueResult, DownloadProgress) {
        if let Some(pos) = self.tasks.iter().position(|t| t.task_id == task.task_id) {
            let terminal = matches!(
                self.tasks[pos].status,
                TaskStatus::Done | TaskStatus::Failed | TaskStatus::Cancelled
            );
            if !(task.repair && terminal) {
                let existing = &self.tasks[pos];
                return (EnqueueResult::AlreadyQueued, existing.to_progress());
            }
            self.tasks.remove(pos);
        }
        self.cancelled.remove(&task.task_id);
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
        if matches!(task.status, TaskStatus::Queued | TaskStatus::Downloading) {
            task.status = TaskStatus::Cancelled;
            self.cancelled.insert(task_id.to_string());
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
            self.cancelled.remove(task_id);
        }
        Some(task.to_progress())
    }

    /// 清空已完成（done/failed/cancelled），返回移除数量。
    pub fn clear_finished(&mut self) -> usize {
        let before = self.tasks.len();
        self.tasks
            .retain(|t| matches!(t.status, TaskStatus::Queued | TaskStatus::Downloading));
        before - self.tasks.len()
    }

    /// 移除某部作品的全部任务（删除已下载漫画时同步清掉队列记录），返回被移除的 taskId。
    /// 排队/下载中的任务先记下取消信号：记录随即消失，信号要留住，worker 才会在下一页边界停下。
    pub fn remove_comic(&mut self, source: &str, comic_id: &str) -> Vec<String> {
        let mut removed = Vec::new();
        for task in &self.tasks {
            if task.source == source && task.comic_id == comic_id {
                if matches!(task.status, TaskStatus::Queued | TaskStatus::Downloading) {
                    self.cancelled.insert(task.task_id.clone());
                }
                removed.push(task.task_id.clone());
            }
        }
        self.tasks
            .retain(|t| !(t.source == source && t.comic_id == comic_id));
        removed
    }

    /// 任务是否已被取消（worker 每页前检查，取消则中止）。
    pub fn is_cancelled(&self, task_id: &str) -> bool {
        self.cancelled.contains(task_id)
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
            comic_cover: "https://x/cover.jpg".to_string(),
            chapter_index: 1,
            chapter_title: "第 1 话".to_string(),
            dir: "/tmp/dl".to_string(),
            referer: String::new(),
            pages: PageEntry::from_urls(
                &(0..pages)
                    .map(|i| format!("https://x/{i}.jpg"))
                    .collect::<Vec<_>>(),
            ),
            pending: (0..pages).collect(),
            repair: false,
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
    fn repair_enqueue_replaces_a_terminal_record() {
        let mut q = DownloadQueue::new();
        q.enqueue(task("a", 2), true); // 已完成（done）的记录

        // 普通入队：同一 taskId 仍在 → 重复入队，什么都不做
        let (result, _) = q.enqueue(task("a", 2), false);
        assert_eq!(result, EnqueueResult::AlreadyQueued);

        // 修复入队：顶掉终态记录，重新排队，只下不完整的那一页
        let (result, p) = q.enqueue(task("a", 2).into_repair(vec![1]), false);
        assert_eq!(result, EnqueueResult::Queued);
        assert_eq!(p.status, TaskStatus::Queued);
        assert_eq!(p.total, 1);
        assert_eq!(q.snapshot().len(), 1);
        assert_eq!(q.next_queued().unwrap().task_id, "a");
    }

    #[test]
    fn repair_enqueue_keeps_an_in_flight_record() {
        let mut q = DownloadQueue::new();
        q.enqueue(task("a", 2), false); // queued

        let (result, p) = q.enqueue(task("a", 2).into_repair(vec![0]), false);
        assert_eq!(result, EnqueueResult::AlreadyQueued);
        assert_eq!(p.status, TaskStatus::Queued);
        assert_eq!(q.snapshot().len(), 1);
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
    fn remove_comic_drops_its_tasks_and_keeps_the_cancel_signal() {
        let mut q = DownloadQueue::new();
        q.enqueue(task("a", 2), false);
        q.next_queued(); // a 正在下载
        let mut other = task("b", 2);
        other.comic_id = "c2".to_string();
        q.enqueue(other, false);
        q.enqueue(task("c", 2), true); // 已完成的任务记录

        let removed = q.remove_comic("webtoons", "c1");
        assert_eq!(removed, vec!["a".to_string(), "c".to_string()]);
        let ids: Vec<String> = q.snapshot().iter().map(|v| v.task_id.clone()).collect();
        assert_eq!(ids, vec!["b"]);
        // 记录没了，取消信号还在：worker 手里那份任务要在下一页边界停下
        assert!(q.is_cancelled("a"));
        assert!(!q.is_cancelled("b"));
    }

    #[test]
    fn reenqueueing_a_removed_chapter_clears_the_cancel_signal() {
        let mut q = DownloadQueue::new();
        q.enqueue(task("a", 2), false);
        q.remove_comic("webtoons", "c1");
        assert!(q.is_cancelled("a"));

        q.enqueue(task("a", 2), false);
        assert!(!q.is_cancelled("a"));
        assert_eq!(q.next_queued().unwrap().task_id, "a");
    }

    #[test]
    fn retry_clears_the_cancel_signal() {
        let mut q = DownloadQueue::new();
        q.enqueue(task("a", 2), false);
        q.cancel("a");
        assert!(q.is_cancelled("a"));
        q.retry("a");
        assert!(!q.is_cancelled("a"));
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
        assert_eq!(views[0].comic_cover, "https://x/cover.jpg");
        assert_eq!(views[0].chapter_index, 1);
        assert_eq!(views[0].chapter_title, "第 1 话");
        assert_eq!(views[1].status, TaskStatus::Done);
        assert_eq!(views[1].done, 2);
    }

    #[test]
    fn task_id_format_matches_grilling_decision() {
        assert_eq!(task_id("webtoons", "c1", 3), "webtoons/c1/3");
    }

    /// 补下任务在任务视图里带修复标记（下载页据此在那一行显示「补下」）。
    #[test]
    fn a_repair_task_is_marked_in_the_view() {
        let mut q = DownloadQueue::new();
        q.enqueue(task("plain", 2), false);
        q.enqueue(task("fix", 2).into_repair(vec![0]), false);

        let views = q.snapshot();
        assert!(!views[0].repair);
        assert!(views[1].repair);
    }
}
