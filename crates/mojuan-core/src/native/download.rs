//! 下载运行时（wayfinder #20/#22 定案；2026-10-10 从 src-tauri 命令模块移入）。
//!
//! 队列状态机（`queue.rs`）与下载策略同处一层：常驻 worker、章内顺序、单页失败重试、
//! 取消检查、进度推送。宿主（src-tauri）只接两件事——页面下载与进度出口——都是构造时
//! 传入的闭包，所以运行时不认识 Tauri，也不需要 AppHandle：`cargo test` 里换一个假
//! downloader 就能跑同一份策略代码。

use crate::native::files;
use crate::native::queue::{
    DownloadProgress, DownloadQueue, DownloadTask, DownloadTaskView, EnqueueResult,
};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// 全局页并发（grilling #22 #2：全局 2 页并发、章内顺序）→ 起 2 个 worker。
pub const DEFAULT_WORKERS: usize = 2;

/// 单页最多尝试次数（grilling #22 #3：首次失败后重试 2 次）。
pub const DEFAULT_PAGE_ATTEMPTS: usize = 3;

/// 空队列时 worker 的轮询间隔。
const IDLE_POLL: Duration = Duration::from_millis(200);

/// 下载一页：成功返回 `Ok(())`，失败返回原因（HTTP 状态、写盘错误等）。
pub type PageDownloader = Box<dyn Fn(&DownloadTask, usize) -> Result<(), String> + Send + Sync>;

/// 进度出口：每次任务状态变化调用一次，宿主把它接到 IPC Channel 上。
pub type ProgressSink = Box<dyn Fn(DownloadProgress) + Send + Sync>;

struct Inner {
    queue: Mutex<DownloadQueue>,
    downloader: PageDownloader,
    page_attempts: usize,
    progress: ProgressSink,
}

/// 下载运行时：入队 / 取消 / 重试 / 清空 / 快照，状态变化经进度出口交出。
/// 内部是 `Arc`，可直接注册成宿主的 State 并交给 worker 线程。
#[derive(Clone)]
pub struct DownloadRuntime {
    inner: Arc<Inner>,
}

impl DownloadRuntime {
    /// 生产构造：页面下载走 core 的落盘实现（`files::download_image`）。
    pub fn new(progress: ProgressSink) -> Self {
        Self::with_downloader(Box::new(download_page), progress)
    }

    /// 替换页面下载实现（测试注入假实现，让页面下载的成败与耗时可控）。
    pub fn with_downloader(downloader: PageDownloader, progress: ProgressSink) -> Self {
        Self {
            inner: Arc::new(Inner {
                queue: Mutex::new(DownloadQueue::new()),
                downloader,
                page_attempts: DEFAULT_PAGE_ATTEMPTS,
                progress,
            }),
        }
    }

    /// 起常驻 worker（每个 worker 一次处理一话，FIFO 领取）。
    pub fn start_workers(&self, count: usize) {
        for _ in 0..count {
            let runtime = self.clone();
            std::thread::spawn(move || runtime.worker_loop());
        }
    }

    /// 入队一话：已在磁盘 → 标 done 不入队；taskId 已在队列 → 不重复入队。
    /// 返回入队结果与该任务此刻的进度。
    pub fn enqueue(&self, task: DownloadTask) -> (EnqueueResult, DownloadProgress) {
        let already =
            files::chapter_downloaded(&task.dir, &task.source, &task.comic_id, task.chapter_index);
        let (result, progress) = self.inner.queue.lock().unwrap().enqueue(task, already);
        self.emit(progress.clone());
        (result, progress)
    }

    /// 取消任务（排队/下载中 → cancelled），返回最新进度（任务不存在时 None）。
    pub fn cancel(&self, task_id: &str) -> Option<DownloadProgress> {
        let progress = self.inner.queue.lock().unwrap().cancel(task_id);
        self.emit_opt(progress.clone());
        progress
    }

    /// 重试任务（failed/cancelled → 重新排队），返回最新进度（任务不存在时 None）。
    pub fn retry(&self, task_id: &str) -> Option<DownloadProgress> {
        let progress = self.inner.queue.lock().unwrap().retry(task_id);
        self.emit_opt(progress.clone());
        progress
    }

    /// 清空已完成（done/failed/cancelled），返回移除数量。
    pub fn clear_finished(&self) -> usize {
        self.inner.queue.lock().unwrap().clear_finished()
    }

    /// 全量快照（下载页初始加载，含展示字段）。
    pub fn snapshot(&self) -> Vec<DownloadTaskView> {
        self.inner.queue.lock().unwrap().snapshot()
    }

    /// 常驻 worker：领任务并下载，空队列时轮询等待。
    fn worker_loop(&self) {
        loop {
            let task = self.inner.queue.lock().unwrap().next_queued();
            match task {
                Some(task) => self.run_task(task),
                None => std::thread::sleep(IDLE_POLL),
            }
        }
    }

    /// 一话的下载流程：章内按页顺序，单页失败重试 `page_attempts` 次；
    /// 每页开始前检查取消（取消由 cancel 置状态，worker 据此中止）。
    fn run_task(&self, task: DownloadTask) {
        let id = task.task_id.clone();
        self.emit(task.to_progress()); // downloading
        for (page, _) in task.urls.iter().enumerate() {
            if self.inner.queue.lock().unwrap().is_cancelled(&id) {
                return; // 已取消：状态已置 cancelled，不再下载后续页
            }
            let mut failure = String::new();
            let mut ok = false;
            for _ in 0..self.inner.page_attempts {
                match (self.inner.downloader)(&task, page) {
                    Ok(()) => {
                        ok = true;
                        break;
                    }
                    Err(e) => failure = e,
                }
            }
            let progress = if ok {
                self.inner.queue.lock().unwrap().mark_page_done(&id)
            } else {
                self.inner
                    .queue
                    .lock()
                    .unwrap()
                    .mark_failed(&id, format!("第 {} 页下载失败：{failure}", page + 1))
            };
            if let Some(progress) = progress {
                self.emit(progress);
            }
            if !ok {
                return;
            }
        }
    }

    /// 进度出口在不持队列锁时调用（回调会回到宿主的订阅状态里取 Channel）。
    fn emit(&self, progress: DownloadProgress) {
        (self.inner.progress)(progress);
    }

    fn emit_opt(&self, progress: Option<DownloadProgress>) {
        if let Some(progress) = progress {
            self.emit(progress);
        }
    }
}

/// 页面下载的生产实现：`<dir>/<source>/<comicId>/chapter_<n>/<page>.<ext>`。
fn download_page(task: &DownloadTask, page: usize) -> Result<(), String> {
    files::download_image(
        &task.urls[page],
        &task.dir,
        &task.source,
        &task.comic_id,
        task.chapter_index,
        page as i64,
        &task.referer,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native::queue::TaskStatus;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// 进度出口的收集器。
    fn collector() -> (Arc<Mutex<Vec<DownloadProgress>>>, ProgressSink) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink_seen = seen.clone();
        (seen, Box::new(move |p| sink_seen.lock().unwrap().push(p)))
    }

    fn task(pages: usize, dir: &str) -> DownloadTask {
        DownloadTask::new(
            "webtoons",
            "c1",
            "标题",
            1,
            dir,
            "",
            (0..pages).map(|i| format!("https://x/{i}.jpg")).collect(),
        )
    }

    /// 领下一个任务（worker 循环之外直接驱动 `run_task`，测试不需要线程与等待）。
    fn take_next(runtime: &DownloadRuntime) -> DownloadTask {
        runtime.inner.queue.lock().unwrap().next_queued().unwrap()
    }

    /// 页面下载依次记下页码；调用次数与页码序列是断言重试与顺序的依据。
    fn page_spy() -> (Arc<Mutex<Vec<usize>>>, PageDownloader) {
        let pages = Arc::new(Mutex::new(Vec::new()));
        let spy = pages.clone();
        (
            pages,
            Box::new(move |_task: &DownloadTask, page: usize| {
                spy.lock().unwrap().push(page);
                Ok(())
            }),
        )
    }

    #[test]
    fn runs_pages_in_order_until_done() {
        let (seen, sink) = collector();
        let (pages, downloader) = page_spy();
        let runtime = DownloadRuntime::with_downloader(downloader, sink);

        runtime.enqueue(task(3, "/nonexistent-mojuan-dir"));
        runtime.run_task(take_next(&runtime));

        assert_eq!(*pages.lock().unwrap(), vec![0, 1, 2]);
        let view = &runtime.snapshot()[0];
        assert_eq!(view.status, TaskStatus::Done);
        assert_eq!(view.done, 3);
        let progress: Vec<(TaskStatus, usize)> = seen
            .lock()
            .unwrap()
            .iter()
            .map(|p| (p.status, p.done))
            .collect();
        assert_eq!(
            progress,
            vec![
                (TaskStatus::Queued, 0),
                (TaskStatus::Downloading, 0),
                (TaskStatus::Downloading, 1),
                (TaskStatus::Downloading, 2),
                (TaskStatus::Done, 3),
            ]
        );
    }

    #[test]
    fn retries_a_failed_page_and_keeps_progress_quiet_until_it_succeeds() {
        let (seen, sink) = collector();
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        let runtime = DownloadRuntime::with_downloader(
            Box::new(move |_task: &DownloadTask, _page: usize| {
                if counter.fetch_add(1, Ordering::SeqCst) < 2 {
                    Err("HTTP 503".to_string())
                } else {
                    Ok(())
                }
            }),
            sink,
        );

        runtime.enqueue(task(1, "/nonexistent-mojuan-dir"));
        runtime.run_task(take_next(&runtime));

        assert_eq!(calls.load(Ordering::SeqCst), DEFAULT_PAGE_ATTEMPTS);
        assert_eq!(runtime.snapshot()[0].status, TaskStatus::Done);
        // 中间两次失败不外露：只有入队、开始与完成三条进度
        let progress: Vec<(TaskStatus, usize)> = seen
            .lock()
            .unwrap()
            .iter()
            .map(|p| (p.status, p.done))
            .collect();
        assert_eq!(
            progress,
            vec![
                (TaskStatus::Queued, 0),
                (TaskStatus::Downloading, 0),
                (TaskStatus::Done, 1),
            ]
        );
    }

    #[test]
    fn fails_the_task_with_reason_after_attempts_are_exhausted() {
        let (seen, sink) = collector();
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        let runtime = DownloadRuntime::with_downloader(
            Box::new(move |_task: &DownloadTask, _page: usize| {
                counter.fetch_add(1, Ordering::SeqCst);
                Err("HTTP 404".to_string())
            }),
            sink,
        );

        runtime.enqueue(task(2, "/nonexistent-mojuan-dir"));
        runtime.run_task(take_next(&runtime));

        // 第一页三次尝试后整话失败，第二页不再开始
        assert_eq!(calls.load(Ordering::SeqCst), DEFAULT_PAGE_ATTEMPTS);
        let view = &runtime.snapshot()[0];
        assert_eq!(view.status, TaskStatus::Failed);
        assert_eq!(view.done, 0);
        assert_eq!(view.error.as_deref(), Some("第 1 页下载失败：HTTP 404"));
        let last = seen.lock().unwrap().last().unwrap().clone();
        assert_eq!(last.status, TaskStatus::Failed);
        assert_eq!(last.error.as_deref(), Some("第 1 页下载失败：HTTP 404"));
    }

    #[test]
    fn cancel_stops_before_the_next_page() {
        let (_seen, sink) = collector();
        let pages = Arc::new(Mutex::new(Vec::new()));
        let spy = pages.clone();
        // 下载第一页的过程中用户点了取消：这一页照实落盘，下一页不再开始
        let slot: Arc<Mutex<Option<DownloadRuntime>>> = Arc::new(Mutex::new(None));
        let canceller = slot.clone();
        let runtime = DownloadRuntime::with_downloader(
            Box::new(move |task: &DownloadTask, page: usize| {
                spy.lock().unwrap().push(page);
                if let Some(runtime) = canceller.lock().unwrap().as_ref() {
                    runtime.cancel(&task.task_id);
                }
                Ok(())
            }),
            sink,
        );
        *slot.lock().unwrap() = Some(runtime.clone());

        runtime.enqueue(task(3, "/nonexistent-mojuan-dir"));
        runtime.run_task(take_next(&runtime));

        assert_eq!(*pages.lock().unwrap(), vec![0]);
        let view = &runtime.snapshot()[0];
        assert_eq!(view.status, TaskStatus::Cancelled);
        assert_eq!(view.done, 1);
    }

    #[test]
    fn enqueue_marks_a_chapter_already_on_disk_as_done() {
        let (_seen, sink) = collector();
        let dir = std::env::temp_dir().join(format!("mojuan-dl-{}", std::process::id()));
        let chapter = dir.join("webtoons").join("c1").join("chapter_1");
        std::fs::create_dir_all(&chapter).unwrap();
        std::fs::write(chapter.join("0.jpg"), b"x").unwrap();

        let runtime = DownloadRuntime::with_downloader(
            Box::new(|_task: &DownloadTask, _page: usize| panic!("已下载的话不应再下载")),
            sink,
        );
        let (result, _) = runtime.enqueue(task(1, dir.to_str().unwrap()));

        assert_eq!(result, EnqueueResult::AlreadyDownloaded);
        let view = &runtime.snapshot()[0];
        assert_eq!(view.status, TaskStatus::Done);
        assert_eq!(view.done, 1);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
