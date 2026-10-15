//! 下载运行时（wayfinder #20/#22 定案；2026-10-10 从 src-tauri 命令模块移入）。
//!
//! 队列状态机（`queue.rs`）与下载策略同处一层：常驻 worker、章内顺序、单页失败重试、
//! 取消检查、进度推送。宿主（src-tauri）只接两件事——页面下载与进度出口——都是构造时
//! 传入的闭包，所以运行时不认识 Tauri，也不需要 AppHandle：`cargo test` 里换一个假
//! downloader 就能跑同一份策略代码。

use crate::native::comic_meta;
use crate::native::download_index;
use crate::native::files;
use crate::native::queue::{
    DownloadProgress, DownloadQueue, DownloadTask, DownloadTaskView, EnqueueResult,
};
use std::collections::HashSet;
use std::sync::{Arc, Condvar, Mutex};
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
    /// 正在 worker 手里的任务 id（`run_task` 进入时登记、退出时清除）。
    in_flight: Mutex<HashSet<String>>,
    /// `in_flight` 变化的通知：删除整部作品要等页写完，才能删磁盘上的目录。
    drained: Condvar,
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
                in_flight: Mutex::new(HashSet::new()),
                drained: Condvar::new(),
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
    /// 顺带把作品标题、封面与这一话的话名记进下载目录的作品元数据（书架列表据此显示）。
    pub fn enqueue(&self, task: DownloadTask) -> (EnqueueResult, DownloadProgress) {
        comic_meta::record_chapter(
            &task.dir,
            &task.source,
            &task.comic_id,
            &task.comic_title,
            &task.comic_cover,
            task.chapter_index,
            &task.chapter_title,
        );
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

    /// 移除某部作品的全部下载记录：在途任务发取消信号，等 worker 从当前页退出后返回。
    /// 返回后调用方才可以删磁盘上的目录——早一步的话，worker 会把刚删掉的章节写回来。
    pub fn drop_comic(&self, source: &str, comic_id: &str) -> usize {
        let removed = self
            .inner
            .queue
            .lock()
            .unwrap()
            .remove_comic(source, comic_id);
        let mut in_flight = self.inner.in_flight.lock().unwrap();
        while in_flight.iter().any(|id| removed.contains(id)) {
            in_flight = self.inner.drained.wait(in_flight).unwrap();
        }
        removed.len()
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
    /// 每页开始前检查取消（取消由 cancel 或删除整部作品置位，worker 据此中止）。
    /// 下载索引在整话结束时一次写入（`downloaded`）：逐页写的话两个 worker 的
    /// 读—改—写会互相覆盖，落下的条目会让那一页在线读时回落到联网取图。
    fn run_task(&self, task: DownloadTask) {
        let id = task.task_id.clone();
        self.inner.in_flight.lock().unwrap().insert(id.clone());
        self.emit(task.to_progress()); // downloading
        let mut downloaded: Vec<(String, String)> = Vec::new();
        for (page, url) in task.urls.iter().enumerate() {
            if self.inner.queue.lock().unwrap().is_cancelled(&id) {
                break; // 已取消：状态已置 cancelled，不再下载后续页
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
            if ok {
                downloaded.push((
                    url.clone(),
                    files::page_rel_path(task.chapter_index, page as i64, url),
                ));
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
                break;
            }
        }
        // 落下的页记进索引。写在清在途标记之前：删除整部作品要等这个标记，
        // 索引不会在目录删掉之后又被写回来。
        if !downloaded.is_empty() {
            let _ = download_index::record_downloads(
                &task.dir,
                &task.source,
                &task.comic_id,
                &downloaded,
            );
        }
        // 退出：清在途标记并唤醒等待者（删除整部作品的调用靠它确认页已写完）
        let mut in_flight = self.inner.in_flight.lock().unwrap();
        in_flight.remove(&id);
        self.inner.drained.notify_all();
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
            "https://x/cover.jpg",
            1,
            "第 1 话",
            dir,
            "",
            (0..pages).map(|i| format!("https://x/{i}.jpg")).collect(),
        )
    }

    /// 指定话号的下载任务（索引竞争用例要两话并行，url 按话号区分开）。
    fn task_in_chapter(chapter: i64, pages: usize, dir: &str) -> DownloadTask {
        DownloadTask::new(
            "webtoons",
            "c1",
            "标题",
            "https://x/cover.jpg",
            chapter,
            "第 1 话",
            dir,
            "",
            (0..pages)
                .map(|i| format!("https://x/{chapter}/{i}.jpg"))
                .collect(),
        )
    }

    /// 临时的下载目录（每部作品一个子目录，用例结束自行清理）。
    fn temp_download_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mojuan-dl-index-{}-{}",
            tag,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
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

    #[test]
    fn enqueue_records_the_comic_metadata_on_disk() {
        let (_seen, sink) = collector();
        let dir = std::env::temp_dir().join(format!("mojuan-dl-meta-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let runtime = DownloadRuntime::with_downloader(
            Box::new(|_task: &DownloadTask, _page: usize| Ok(())),
            sink,
        );

        runtime.enqueue(task(1, dir.to_str().unwrap()));

        let meta = crate::native::comic_meta::read(dir.to_str().unwrap(), "webtoons", "c1").unwrap();
        assert_eq!(meta.title, "标题");
        assert_eq!(meta.cover, "https://x/cover.jpg");
        assert_eq!(meta.chapters.get("1").map(String::as_str), Some("第 1 话"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn drop_comic_waits_for_the_in_flight_page_before_returning() {
        let (_seen, sink) = collector();
        let (started_tx, started_rx) = std::sync::mpsc::channel::<()>();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let release_rx = Mutex::new(release_rx);
        let runtime = DownloadRuntime::with_downloader(
            Box::new(move |_task: &DownloadTask, page: usize| {
                if page == 0 {
                    started_tx.send(()).unwrap();
                    release_rx.lock().unwrap().recv().unwrap();
                }
                Ok(())
            }),
            sink,
        );

        runtime.enqueue(task(2, "/nonexistent-mojuan-dir"));
        let worker = {
            let runtime = runtime.clone();
            std::thread::spawn(move || runtime.run_task(take_next(&runtime)))
        };
        started_rx.recv().unwrap(); // 第一页正在下载

        let dropper = {
            let runtime = runtime.clone();
            std::thread::spawn(move || runtime.drop_comic("webtoons", "c1"))
        };
        std::thread::sleep(Duration::from_millis(50));
        assert!(
            !dropper.is_finished(),
            "drop_comic 在第一页写完前就返回了：调用方会删掉 worker 马上要写回的章节"
        );

        release_tx.send(()).unwrap();
        assert_eq!(dropper.join().unwrap(), 1);
        assert!(runtime.snapshot().is_empty());
        worker.join().unwrap();
    }

    /// 索引在整话结束时一次写入：下载过程中查不到这一话的页。
    /// 逐页写的话两个 worker 的读—改—写会互相覆盖，落下的条目让那一页在线读时
    /// 回落到联网取图（实测丢过 chapter_2/3.jpg）。
    #[test]
    fn index_is_written_once_when_the_chapter_finishes() {
        let dir = temp_download_dir("once");
        let (_seen, sink) = collector();
        let seen_index = Arc::new(Mutex::new(Vec::new()));
        let probe = seen_index.clone();
        let runtime = DownloadRuntime::with_downloader(
            Box::new(move |task: &DownloadTask, page: usize| {
                // 每下载一页时查一次索引：这一话的第一页在不在
                let found = download_index::find_downloaded_file(
                    &task.dir,
                    &task.source,
                    &task.comic_id,
                    &task.urls[0],
                )
                .is_some();
                probe.lock().unwrap().push((page, found));
                Ok(())
            }),
            sink,
        );

        runtime.enqueue(task_in_chapter(1, 3, dir.to_str().unwrap()));
        runtime.run_task(take_next(&runtime));

        assert_eq!(
            *seen_index.lock().unwrap(),
            vec![(0, false), (1, false), (2, false)],
            "下载过程中索引就已经写入了"
        );
        for (url, rel) in [
            ("https://x/1/0.jpg", "chapter_1/0.jpg"),
            ("https://x/1/1.jpg", "chapter_1/1.jpg"),
            ("https://x/1/2.jpg", "chapter_1/2.jpg"),
        ] {
            assert_eq!(
                download_index::find_downloaded_file(dir.to_str().unwrap(), "webtoons", "c1", url),
                Some(dir.join("webtoons").join("c1").join(rel)),
                "{url} 没有记进索引"
            );
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 两个 worker 同时结束各自的一话：两次写入串行，两话的条目都要在。
    #[test]
    fn concurrent_chapters_keep_both_index_entries() {
        let dir = temp_download_dir("concurrent");
        let (_seen, sink) = collector();
        let runtime = DownloadRuntime::with_downloader(
            Box::new(|task: &DownloadTask, page: usize| {
                // 按生产实现的命名落一个占位文件，顺带核对相对路径的算法一致
                let rel = files::page_rel_path(task.chapter_index, page as i64, &task.urls[page]);
                let file = std::path::Path::new(&task.dir)
                    .join(&task.source)
                    .join(&task.comic_id)
                    .join(rel);
                std::fs::create_dir_all(file.parent().unwrap()).unwrap();
                std::fs::write(&file, b"x").unwrap();
                Ok(())
            }),
            sink,
        );

        let first = task_in_chapter(1, 6, dir.to_str().unwrap());
        let second = task_in_chapter(2, 6, dir.to_str().unwrap());
        std::thread::scope(|scope| {
            scope.spawn(|| runtime.run_task(first.clone()));
            scope.spawn(|| runtime.run_task(second.clone()));
        });

        for task in [&first, &second] {
            for url in &task.urls {
                assert!(
                    download_index::find_downloaded_file(
                        dir.to_str().unwrap(),
                        "webtoons",
                        "c1",
                        url
                    )
                    .is_some(),
                    "{url} 的条目被另一话的写入覆盖了"
                );
            }
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 极简图片服务器：记录收到的请求行，任何路径都返回同一份图片体。
    fn spawn_image_server() -> (u16, Arc<Mutex<Vec<String>>>) {
        use std::io::{Read, Write};
        const BODY: &[u8] = b"real-jpg-bytes";
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let seen = requests.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().take(4) {
                let Ok(mut stream) = stream else { break };
                let mut buf = [0u8; 2048];
                let n = stream.read(&mut buf).unwrap_or(0);
                seen.lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&buf[..n]).to_string());
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    BODY.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(BODY);
                let _ = stream.flush();
            }
        });
        (port, requests)
    }

    /// 真实下载路径端到端：文件按 `chapter_<n>/<页号>.<扩展名>` 落盘，索引里每个 url
    /// 都指到那个文件（下载器与索引两处的命名必须一致）。
    #[test]
    fn real_download_writes_files_and_the_index() {
        let (port, requests) = spawn_image_server();
        let dir = temp_download_dir("real");
        let (_seen, sink) = collector();
        let runtime = DownloadRuntime::new(sink);
        let urls: Vec<String> = (0..2).map(|i| format!("http://127.0.0.1:{port}/{i}.jpg")).collect();

        runtime.enqueue(DownloadTask::new(
            "webtoons",
            "c1",
            "标题",
            "",
            1,
            "第 1 话",
            dir.to_str().unwrap(),
            "",
            urls.clone(),
        ));
        runtime.run_task(take_next(&runtime));

        assert_eq!(requests.lock().unwrap().len(), 2);
        assert_eq!(runtime.snapshot()[0].status, TaskStatus::Done);
        for (url, rel) in urls.iter().zip(["chapter_1/0.jpg", "chapter_1/1.jpg"]) {
            let file = dir.join("webtoons").join("c1").join(rel);
            assert_eq!(std::fs::read(&file).unwrap(), b"real-jpg-bytes", "{rel}");
            assert_eq!(
                download_index::find_downloaded_file(dir.to_str().unwrap(), "webtoons", "c1", url),
                Some(file),
                "{url} 的索引条目"
            );
        }

        let _ = std::fs::remove_dir_all(&dir);
    }
}
