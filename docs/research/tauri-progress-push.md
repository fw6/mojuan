# 下载任务队列：Rust→前端实时进度推送方案调研（里程碑「下载任务队列」）

> **路径说明**（2026-10-12 布局改动）：本文里的 `desktop/` 现为 `apps/mojuan/`，`desktop/crates/` 现为 `crates/`，`updater/` 现为 `apps/updater/`，`npm`/`npx` 换成 `pnpm`。

背景：本仓库要把下载从 Reader 内联逐页串行升级为 **Rust 侧常驻任务队列 + 前端实时进度**。本调研基于 Tauri v2 官方一手资料（[tauri.app/llms.txt](https://tauri.app/llms.txt) 入口 + 相关 guide/API 页 + 本地 cargo registry 内 tauri **2.11.5** 源码，`@tauri-apps/api` **2.11.1**），回答三个问题：推送通道怎么选、Rust 常驻 worker 怎么写、与 AGENTS.md 坑 #1 怎么核对。所有论断均标注来源 URL（或本仓库/registry 源码路径）。

---

## 结论与推荐（TL;DR）

1. **推送通道：IPC `Channel`（`tauri::ipc::Channel` + 前端 `@tauri-apps/api/core` 的 `Channel`）为主**。官方文档把「download progress」直接列为 Channel 的典型用途（「Channels are designed to be fast and deliver ordered data. They are used internally for streaming operations such as download progress, child process output and WebSocket messages.」），并在 calling-rust 页称其为 streaming 的推荐机制。事件（`emit`/`listen`）是可接受的备选（官方自己的事件示例就是下载进度，但随后明确说「把下载示例改成用 Channel」）；**轮询不推荐**（每轮一次 IPC round-trip + 全量 JSON 序列化）。单主窗口下 Channel 绑定主窗口 webview，随窗口常驻，正好匹配常驻队列的生命周期。
2. **Worker 结构：队列放 `tauri::State`（`Mutex<...>` 包裹），`setup` 里 `tauri::async_runtime::spawn` 启动 worker 循环；worker 持有 `AppHandle` clone（官方称「deliberately cheap to clone」），跨线程改状态用 std `Mutex`（短临界区足够），推送用 State 里存的 `Channel` clone 或 `app.emit`。** 这是官方 State 文档给的「在命令外/线程内访问 State」的标准形态，也是官方插件（tauri-plugin-store）内部的实际写法。
3. **并发下载：每个下载项在 worker 内包一层 `tauri::async_runtime::spawn_blocking` 调 `mojuan_core::download_image`，用 `tokio::sync::Semaphore` 限并发。** AGENTS.md 坑 #1 的约束在后台任务里**同样成立**：`mojuan_core::download_image` 走 `reqwest::blocking`（自带内部 tokio 运行时），worker 是 tokio 异步任务，直接在任务体里同步调用会占死一个 tokio worker 线程、卡住同 runtime 上所有异步命令与其他任务，所以必须 `spawn_blocking`。每个进行中的下载占一个 blocking 池线程（Tokio 阻塞池自动扩容，默认上限 512）。

---

## 1. 推送通道对比

### 1.1 事件（Events）：`app.emit` + 前端 `listen`

Rust 侧 `AppHandle`（及 `WebviewWindow`）实现 `Emitter` trait，`app.emit("download-progress", progress)`；前端 `import { listen } from '@tauri-apps/api/event'`（React 官方示例见下）。

- **官方定性（来源：https://tauri.app/develop/calling-frontend/ ，Event System 段）**：
  - 「The event system was designed for situations where **small amounts of data** need to be streamed or you need to implement a **multi consumer multi producer** pattern (e.g. push notification system).」
  - 「The event system is **not designed for low latency or high throughput** situations. See the channels section for the implementation optimized for streaming data.」
  - 「events have **no strong type support**, event payloads are **always JSON strings** making them not suitable for bigger messages and there is no support of the capabilities system.」
  - 「Under the hood it directly evaluates JavaScript code so it might not be suitable to sending a large amount of data.」（事件底层是 webview eval）
- **作用域**：全局（`emit`，送到所有 listener）vs webview 定向（`emit_to(label, ...)` / `emit_filter`），见同页 Global Events / Webview Event 段。
- **前端 API 形态**（同页 Listening to Events 段的 React 示例）：`listen<T>('download-progress', cb)` 返回 `Promise<UnlistenFn>`，组件卸载时调 `unlisten()` 清理，避免内存泄漏与重复 handler；另有一次性 `once` 工具函数。
- **生命周期**：fire-and-forget。源码（registry `tauri-2.11.5/src/event/listener.rs` `emit_filter`/`emit_js`）显示 emit 按 webview label 查已注册的 JS listener，没有 listener（或 webview 已销毁）就不投递、也不报错——即**无感知丢失**。
- **序列化开销**：载荷经 serde 序列化成 JSON 字符串后 eval 注入。官方明说「不适合大消息」；高频小载荷（进度数字）可用，但官方不推荐用于 high throughput。

### 1.2 IPC Channel：`tauri::ipc::Channel` + 前端 `Channel`

Rust 命令参数接收 `on_event: Channel<DownloadEvent>`；前端 `new Channel<T>()` 设 `onmessage` 后随 invoke 传入。

- **官方定性（来源：https://tauri.app/develop/calling-frontend/ ，Channels 段）**：
  - 「Channels are designed to be **fast** and **deliver ordered data**. They are used internally for **streaming operations such as download progress**, child process output and WebSocket messages.」——「download progress」就是官方为 Channel 举的第一个用途。
  - 同页先给事件版下载示例（`download` 命令里 `app.emit("download-progress", progress)`），随后：「**Let's rewrite our download command example to use channels instead of the event system**」——即官方把 Channel 作为下载进度场景的升级/推荐形态。
- **calling-rust 页的推荐（来源：https://tauri.app/develop/calling-rust/ ，Commands > Channels 段）**：「The Tauri **channel is the recommended mechanism for streaming data** such as streamed HTTP responses to the frontend.」示例为 async 命令 `reader: tauri::ipc::Channel<&[u8]>` 逐 chunk `send`（也支持 `&[u8]` 二进制块）。
- **强类型**：`Channel<TSend>`，`TSend: IpcResponse`（serde `Serialize` 的 JSON，或原始字节）；命令参数里以 `#[serde(tag = "event", content = "data")]` 枚举做类型化消息（官方示例 `enum DownloadEvent { Started{..}, Progress{..}, Finished{..} }`）。
- **前端 API 形态**（本仓库 node_modules `@tauri-apps/api/core.d.ts`，2.11.1）：`export { Channel, ... }`；`declare class Channel<T = unknown> { id: number; constructor(onmessage?); set onmessage(handler); }`。即：
  ```ts
  import { Channel, invoke } from '@tauri-apps/api/core';
  const onEvent = new Channel<DownloadEvent>();
  onEvent.onmessage = (msg) => { /* msg.event === 'progress' ... */ };
  await invoke('start_download', { url, dir, onEvent });
  ```
- **生命周期（源码：registry `tauri-2.11.5/src/ipc/channel.rs`）**：
  - `Channel<TSend>` 是 `Arc<ChannelInner>`，`Clone` 廉价；`Send + Sync`（docs.rs Channel 页 Auto Trait 段：https://docs.rs/tauri/latest/tauri/ipc/struct.Channel.html），**可以存入 State / 跨线程共享给 worker**。
  - 从命令参数反序列化时（`CommandArg` → `JavaScriptChannelId::channel_on(webview)`），`on_message` 闭包**捕获发起该 invoke 的 `Webview`**；`send()` 实际是 `(on_message)(data.body()?)` → `webview.eval(...)`，返回 `crate::Result<()>`。**webview 销毁后 `send` 返回 Err**，调用方可据此感知「前端已不在」并停止推送——比事件多了显式的失败信号。
  - JS 侧创建、Rust 侧 Channel 全部 drop 时（`ChannelInner::drop` 的 `on_drop`），前端收到 `{ end: true, index }` 结束消息（`channel_on` 的 on_drop 逻辑）。
  - **结论**：Channel 随发起 invoke 的窗口存活。本场景单主窗口常驻 → 队列生命周期内 Channel 一直有效；窗口关闭（应用退出）后 send 报 Err，worker 据此收尾。
- **序列化开销（源码 channel.rs 常量）**：`<8192` 字节 JSON 走直接 eval 快路径，更大走 fetch API 通道（`MAX_JSON_DIRECT_EXECUTE_THRESHOLD`）；注释给出 WebView2/macOS 的实测（eval 快于 fetch）。进度小载荷落在快路径上，开销与事件同量级，但有序（ordered）且官方推荐 streaming。

### 1.3 轮询（前端定时调 command 读 State）

- 官方文档**没有**专门页面；形态即前端 `setInterval` + `invoke('download_status')` 读 `State` 里的队列快照。
- 优点：语义最简单、无推送通道生命周期问题、跨窗口通用。缺点：每轮一次 IPC round-trip + 整队列 JSON 序列化；进度延迟 = 轮询间隔；高频下浪费主线程 IPC。

### 1.4 对比与官方推荐汇总

| 维度 | 事件 `emit`/`listen` | IPC `Channel` | 轮询 |
|---|---|---|---|
| 官方定性 | 小数据量流式 / 多消费者通知；**非**低延迟高吞吐 | **fast + ordered**；官方点名「download progress」场景 | 无官方文档 |
| 类型安全 | 无，载荷恒为 JSON 字符串 | 强类型 `Channel<TSend>`（serde / `&[u8]`） | 命令返回值类型化 |
| 生命周期 | fire-and-forget，无 listener 即丢 | 绑定发起 invoke 的 webview；销毁后 `send` 返回 Err；Rust 侧全 drop 时前端收 `end` | 无状态概念 |
| 多窗口 | 全局广播 or `emit_to` 定向 | 绑定单一 webview | 天然全局 |
| 高频小载荷 | 可用但不推荐（官方：not for high throughput） | **推荐**（官方：streaming 优化实现） | 浪费 |
| 前端 API | `listen`/`once` from `@tauri-apps/api/event` | `new Channel()` from `@tauri-apps/api/core` | `invoke` + 定时器 |

**官方推荐结论**：文档没有一篇「选型指南」，但两处措辞非常明确——Channel 是 streaming / download progress 的推荐机制（calling-frontend Channels 段、calling-rust Channels 段）；事件用于小数据量/通知类推送（官方事件示例本身也是下载进度，随后被改写为 Channel 版）；轮询无官方背书。

---

## 2. Rust 侧常驻 worker 写法

### 2.1 队列放 `State`，用 `Mutex` 包裹

- **管理（来源：https://tauri.app/develop/state-management/ ）**：`app.manage(Mutex::new(...))`（在 `setup` 里），命令里 `State<'_, Mutex<DownloadQueue>>` 注入。跨线程改队列数据用 **interior mutability**——官方原话（Mutability 段）：「you can use the standard library's `Mutex` to wrap your state. This allows you to lock the value when you need to modify it, and unlock it when you are done.」
- **不需要 `Arc`**（同页 Do you need Arc? 段）：「you **don't need to use `Arc`** for things stored in `State` because Tauri will do this for you.」——`State` 内部已是 `Arc`。
- **命令外访问**（同页 Access state with the Manager trait 段）：`let state = app_handle.state::<Mutex<AppState>>();`；并给理由：「**AppHandles are deliberately cheap to clone** for use-cases like this」，「if you need to **move the state into a thread** where using an `AppHandle` is easier, or if you are not in a command context」。这正是 worker 线程拿队列的标准姿势。
- **std `Mutex` vs tokio `Mutex`**（同页 When to use an async mutex 段）：官方引用 Tokio 文档原话「it is ok and **often preferred to use the ordinary Mutex from the standard library in asynchronous code**」，唯一需要 async Mutex 的场景是「hold the `MutexGuard` across await points」。队列的「pop 一个任务 / 写一个进度」都是短临界区，**用 std `Mutex` 即可**（注意别在持锁时 await）。

### 2.2 启动：`setup` 里 `tauri::async_runtime::spawn`

- **`tauri::async_runtime` 模块（来源：https://docs.rs/tauri/latest/tauri/async_runtime/index.html ）**：`spawn`（Spawns a future onto the runtime）、`spawn_blocking`（Runs the provided function on an executor dedicated to blocking operations）、`block_on`、`channel`（bounded mpsc，带背压）、`handle`。这是 Tauri 内置的 tokio 运行时。
- **异步命令本身就跑在 `async_runtime::spawn` 上**（来源：https://tauri.app/develop/calling-rust/ ，Async Commands 段：「Async commands are executed on a separate async task using `async_runtime::spawn`. Commands without the _async_ keyword are executed on the main thread」）。
- **启动位置**：官方没有专页讲「后台常驻任务」，但 State 文档的 `setup(|app| { app.manage(...); Ok(()) })` 形态 + 官方插件源码就是样板——**官方插件 tauri-plugin-store 内部正是 `tauri::async_runtime::spawn(async move { ... })` 起后台任务**（registry `tauri-plugin-store-2.4.4/src/store.rs:582`）。在 `setup` 里一次性 `let handle = app.handle().clone(); tauri::async_runtime::spawn(async move { worker_loop(handle).await });` 符合「常驻队列」语义（不依赖任何前端调用）；在命令里 spawn 也可以，但需要命令先被调一次、且多窗口时重复 spawn。

### 2.3 状态变更跨线程通知前端的正确做法

- 推送二选一：
  - **Channel 存进 State**：`start_download` 命令把前端传入的 `Channel<DownloadEvent>` 存进 `State`（Channel `Send + Sync + Clone`），worker 每次进度 `let ch = state.lock().unwrap().progress_channel.clone()` 后 `ch.send(...)`。webview 没了时 `send` 返回 Err，worker 可停止。
  - **`AppHandle` clone + `emit`**：worker 持有 `app_handle.clone()`，`app.emit("download-progress", json)`（`Emitter` trait，来源：https://tauri.app/develop/calling-frontend/ ，Global Events 段）。无感知丢失，更简单。
- 共享状态本身：`State`（`Mutex<DownloadQueue>`）由 Tauri 提供线程安全访问，worker 经 `app_handle.state::<Mutex<DownloadQueue>>()` 取用（§2.1）。

---

## 3. 与 AGENTS.md 坑 #1 的核对：后台 worker 里跑阻塞 reqwest

**现状（本仓库）**：
- `desktop/src-tauri/src/lib.rs` 的 `download_image` 命令：`async fn` + `tauri::async_runtime::spawn_blocking(move || mojuan_core::download_image(...)).await`（AGENTS.md 坑 #1 的标准解法）。
- `mojuan_core::download_image`（`desktop/crates/mojuan-core/src/native/files.rs:49`）调 `http::get_bytes`；`crawler/http.rs` 用 `reqwest::blocking::Client`，文件头注释明确：「reqwest blocking 内部自带 tokio 运行时，可直接在方法层后台线程同步调用」——即它是**同步阻塞调用**（阻塞调用线程），但自带运行时，可从任意后台线程调用。

**约束在后台 worker 里怎么适用**：

- worker 是 `tauri::async_runtime::spawn` 起的 **tokio 异步任务**，跑在 tokio 的 async worker 线程上。若在任务体里**直接**同步调用 `mojuan_core::download_image`，会占住该 tokio worker 线程直到请求结束——同 runtime 上的**所有其他异步任务（含异步命令、其它 worker、Channel 分发）全部卡住**，与坑 #1 在主线程调用阻塞 reqwest 是同一类问题（只是把「主线程」换成了「tokio worker 线程」）。
- 因此**即使 worker 是后台任务，每个下载项仍必须包 `tauri::async_runtime::spawn_blocking`**：
  ```rust
  let out = tauri::async_runtime::spawn_blocking(move || {
      mojuan_core::download_image(&task.url, &task.dir, &task.source, &task.comic_id,
                                 task.chapter_index, task.page_index, &task.referer)
  }).await.unwrap_or_default();
  ```
- `spawn_blocking` 跑在 Tokio 专门的 **blocking 线程池**（自动扩容，默认上限 512 线程），每个进行中的下载独立占一个阻塞线程，互不阻塞 async 运行时，也天然获得真并行（`reqwest::blocking` 内部自带运行时，单次请求不共享连接池，各占一线程）。
- **并发限流**：worker 里给每个下载项 `spawn_blocking` + 用 `tokio::sync::Semaphore`（`acquire_owned`）限定同时在飞的下载数（如 4）；或直接 spawn 4 个 worker 循环任务，每个循环 pop 任务后 `spawn_blocking(...).await`。两者等价，前者把并发数集中一处更易调。

---

## 4. 推荐落地形态（代码骨架）

```rust
// ---------- 消息协议（Rust 侧强类型，serde tag/content 扁平化） ----------
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "event", content = "data")]
enum DownloadEvent {
    Started  { download_id: usize, total: usize },
    Progress { download_id: usize, done: usize, total: usize },
    Finished { download_id: usize },
    Failed   { download_id: usize, page_index: i64 },
}

// ---------- 队列 State ----------
#[derive(Default)]
struct DownloadQueue {
    tasks: std::collections::VecDeque<DownloadTask>,
    progress: std::collections::HashMap<usize, usize>, // download_id -> 已下载页数
    channel: Option<tauri::ipc::Channel<DownloadEvent>>,
}

// ---------- setup：manage + spawn 常驻 worker ----------
Builder::default()
    .manage(Mutex::new(DownloadQueue::default()))
    .setup(|app| {
        let handle = app.handle().clone();
        tauri::async_runtime::spawn(async move { worker_loop(handle).await });
        Ok(())
    })
    // ...

// ---------- worker：pop + spawn_blocking + Semaphore 限并发 ----------
async fn worker_loop(app: tauri::AppHandle) {
    let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(4)); // 并发 4
    loop {
        // 短临界区：只 pop，不持锁跨 await
        let task = app.state::<Mutex<DownloadQueue>>().lock().unwrap().tasks.pop_front();
        let Some(task) = task else {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            continue;
        };
        let permit = sem.clone().acquire_owned().await.unwrap();
        let app2 = app.clone();
        tauri::async_runtime::spawn(async move {
            let out = tauri::async_runtime::spawn_blocking(move || {
                mojuan_core::download_image(&task.url, &task.dir, &task.source,
                    &task.comic_id, task.chapter_index, task.page_index, &task.referer)
            }).await;
            // 进度/完成：优先走 State 里的 Channel；Channel 无/失效则回退 emit
            let mut q = app2.state::<Mutex<DownloadQueue>>().lock().unwrap();
            if let Some(ch) = &q.channel {
                let _ = ch.send(DownloadEvent::Progress { download_id: task.id, done: /* 计数 */, total: /* 计数 */ });
            } else {
                let _ = app2.emit("download-progress", /* json */);
            }
            drop(permit);
        });
    }
}

// ---------- 前端 ----------
import { Channel, invoke } from '@tauri-apps/api/core';
const onEvent = new Channel<DownloadEvent>();
onEvent.onmessage = (msg) => { /* msg.event: 'progress' | 'finished' | 'failed' */ };
await invoke('start_download', { url, dir, source, comicId, chapterIndex, pageIndex, onEvent });
```

要点：状态短临界区用 std `Mutex`（勿跨 await 持锁）；网络/IO 一律 `spawn_blocking`；推送首选 Channel（强类型、有序、官方点名的下载进度场景），事件作回退；单主窗口下 Channel 生命周期与队列一致。

---

## Sources

- Tauri 文档入口（必读）：https://tauri.app/llms.txt
- Calling the Frontend from Rust（Event System / Global Events / Webview Event / Listening to Events / Channels 各段，含「channels 用于 download progress」原话与事件版下载示例改写）：https://tauri.app/develop/calling-frontend/
- Calling Rust from the Frontend（Async Commands 段：async 命令跑在 `async_runtime::spawn`、borrowed 参数限制（issue https://github.com/tauri-apps/tauri/issues/2533）；Commands > Channels 段：Channel 是 streaming 推荐机制、`Channel<&[u8]>` 示例；Accessing Managed State 段）：https://tauri.app/develop/calling-rust/
- State Management（manage / Mutability / Do you need Arc? / When to use an async mutex / Access state with the Manager trait 各段，AppHandle「deliberately cheap to clone」）：https://tauri.app/develop/state-management/
- docs.rs `tauri::async_runtime`（spawn / spawn_blocking / block_on / channel / handle）：https://docs.rs/tauri/latest/tauri/async_runtime/index.html
- docs.rs `tauri::ipc::Channel`（Clone / Send / Sync 等）：https://docs.rs/tauri/latest/tauri/ipc/struct.Channel.html
- Tauri 2.11.5 源码（本地 cargo registry）：`~/.cargo/registry/src/rsproxy.cn-*/tauri-2.11.5/src/ipc/channel.rs`（Channel=Arc<ChannelInner>、send→webview.eval、`channel_on` 的 on_drop→前端 `{end:true}`、eval/fetch 阈值常量）；`src/event/listener.rs`（emit→按 webview 查 JS listener，无 listener 即不投递）
- 官方插件样板：`tauri-plugin-store-2.4.4/src/store.rs:582`（`tauri::async_runtime::spawn(async move { ... })` 起后台任务）
- 前端 API：本仓库 `desktop/node_modules/@tauri-apps/api/core.d.ts`（`Channel` class：`constructor(onmessage?)` / `set onmessage` / `toJSON`；`@tauri-apps/api` **2.11.1**）
- 本仓库代码：`desktop/src-tauri/src/lib.rs`（`download_image` 命令 = async + `spawn_blocking`）、`desktop/crates/mojuan-core/src/native/files.rs:49`（`download_image`）、`desktop/crates/mojuan-core/src/crawler/http.rs`（`reqwest::blocking::Client`，头注释「blocking 内部自带 tokio 运行时」）
