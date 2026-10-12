# Rust 核心 mojuan-core 约定

## 位置与职责

- `crates/mojuan-core/` — 跨端共享的爬虫引擎与 WebDAV/下载/本地文件 IO/图片缓存（`cache::fetch_image`）。
- `apps/mojuan/src-tauri` 经 tauri command 接线；核心本身无绑定层、不重写。
- 跨模块共用的小工具在 `src/util.rs`：有界 LRU（图片缓存与抓取结果缓存共用同一个 `util::Lru`，容量由调用点传入）、`hex`、`now_ms`；下载目录布局（`<dir>/<source>/<comicId>`，扁平布局 `<dir>/<comicId>`）在 `src/native/paths.rs`。

## 源文档与源运行时（2026-10-12 起，ADR-0002）

- 一个漫画源 = 一份 **JSON 源文档**，由一份共享的 **源运行时** 解释（`src/js/runtime.js`，
  rquickjs 执行）。文档格式的唯一定义处是 `src/crawler/doc.rs`：Rust 结构体既做校验
  （`deny_unknown_fields` 拒绝写错的键名），又经 `schemars` 生成 JSON Schema（`source_schema`
  命令给出，供编辑器补全与源仓库提交时检查）。
- 契约：运行时导出 `plan(req)` 与 `parse(req)`，参数与返回值都是 JSON 字符串；
  `req = {op, payload, ctx, responses}`，`responses` 是 `{步骤名: 响应体}`。
  `plan` 返回下一个请求步骤（`{name,url,headers,input}`）、`{done:true}`（请求已发完）或
  `{abort:true}`（模板求值为空，按空结果返回）。`parse` 返回
  `{"data": <crawl 协议值>, "hidden": [...]}`。
- **抓取留在 Rust**（`crawler/script.rs` 的 op 流程）：plan → 抓取 → plan → … → parse。
  运行时只做纯计算，所以引擎的 2 秒墙钟超时只覆盖计算，不覆盖网络往返。
- **一个 op 可以按顺序发多次请求**：后一步的 `url` 可以用 `vars` 里从前面步骤响应取出的值
  （mangadex / copymanga 的章节 id、dongman 的 viewer URL 都是这个形状）。
- **HTML 求值经宿主绑定** `__host.select(html, selector)`（`js/mod.rs`）：app 侧用已经作为依赖
  存在的 `scraper`（html5ever + CSS 选择器）求值，返回 `[{attrs, text, html}]` 的 JSON 字符串。
  运行时因此不必手写字符串扫描。
- **跨 op 携带的值**（webtoons 的系列 URL、baozimh 的章节中转链）由文档的 `hidden` 声明：
  运行时把它从输出剥掉、经 `parse` 的信封交出来，宿主按「漫画 id」或「漫画 id:章节号」记键存进
  该源的缓存，后续 op 经 `ctx.hidden` 取用（`cache_dump`/`cache_hydrate` 持久化它）。
- **需要真正算法的 op** 用文档内嵌的 `script` 钩子（「算法型源的出口」）。它只有两个位置，
  由 `doc.rs` 校验、写在别处一律报错：`ops.<op>.script` 给出该 op 的最终值（manhuagui 的
  `p.a.c.k.e.r` 解包，请求照常按 `request` 发出），`items` 上的 `script` 只给出单元列表、字段
  仍走声明式（hentara 的本地搜索）。同一处也不允许与会被忽略的键并存（整 op 钩子与
  `items`/`comic`/`url`/`hidden` 等，`items` 钩子与 `select`/`from`/`region`）。
- **钩子拿到的前导与选择器**：`api` 里有 `op` / `payload` / `ctx` / `responses` / `doc` / `root`，
  外加 `helpers`（`collapse`、`trim`、`stripTags`、`after`、`before`、`digitsAfter`、`param`、
  `absoluteUrl`、`isImageUrl`、`jsonPath`、`applyTransform`、`applyFilter` 等，与声明式层同一份
  实现）与 `select(html, selector)`。宿主绑定只经 `select` 暴露，钩子拿不到别的宿主能力。
- **沙箱挂 RegExp**（`js/mod.rs` 的 intrinsic 白名单）：钩子里的正则由 2 秒墙钟超时兜底——
  灾难性回溯会被 `set_interrupt_handler` 打断（`catastrophic_regex_backtracking_is_interrupted`
  钉住这条）。`MapSet` 未挂。

## 已装源的注册表（2026-10-12 起）

- `src/crawler/registry.rs` 维护「当前装了哪些源」与宿主侧状态（最近错误、隐藏值缓存）。
  取代了旧的「一个源一个 Rust 适配器 + 静态 `SOURCES` 表」。
- **内置源只有 webtoons**（`src/js/sources/webtoons.json`，`include_str!` 打包）：格式的参考实现
  与首启可用的保证，可被索引里版本更高的条目覆盖、不可卸载、恒排在最前。
- 前端经 `sync_sources` 命令同步：源运行时（可选，缺省用内置）+ 有序的源文档列表。
  同步时逐份解析校验，**坏文档不替换已装版本**并把原因写进该源的错误行；返回被接受的源的前端
  事实（显示名与热链对），前端据此填源清单与图片代理。
- 新增一个源 = 提交一份文档到源仓库（或在前端「漫画源」面板手动导入），不需要改 Rust。
- 仓库里的 9 份文档（`src/js/sources/*.json`）同时是回归数据：`source_doc_test.rs` 与 node 侧的
  `source-docs.test.js` 拿它们跑每源的端到端。改一份文档要**两处都改**——应用仓库这份供测试
  （webtoons 这份同时是内置源），源仓库 `sources/<id>.json` 那份才是发布出去的。

## 渲染源（隐藏 webview 通道，2026-09-30 起）

- **JS 挑战 / 客户端环境校验型防护的源**（当前 baozimh、nnhanman）在文档里声明
  `renderChannel: true`，整源改经隐藏 webview 渲染通道取页面；`script.rs::fetch` 按这个标志分流，
  宿主经 `render::set_fetcher` 注册实现（桌面 = src-tauri 的隐藏窗口，移动 =
  `tauri-plugin-mojuan-render` 的离屏 webview）；取回的渲染后 HTML 走与普通抓取相同的解析契约。
- 判据的唯一定义处也在 `crawler/render.rs`：`STATE_SCRIPT`（页面状态脚本）、`HTML_SCRIPT`、
  `is_clean` / `is_denied`、`POLL_INTERVAL`、`RENDER_TIMEOUT`；桌面宿主与移动端原生侧共用，挑战页
  形态变化只改这里（测试用 QuickJS + 页面桩覆盖各形态）。
- 未注册宿主（mojuan-core 单独跑测试）时 `fetch` 返回「渲染通道未注册」错误，由该源的错误行记录并
  呈现；`cargo test` 不依赖 webview。
- 真网验证用 `src-tauri/examples/render_probe.rs`（dump / crawl / chain 三种模式），设计细节与
  踩坑见 `docs/research/webview-render-channel.md`。

## 结果缓存（stale-while-revalidate，2026-10-08 起）

- `crawler/result_cache.rs`：列表/详情类 op（`categories | category | search | detail`）的**成功**
  结果缓存——内存 LRU + 磁盘 `<appCacheDir>/results/<sha256>.json`；`images` 不缓存（地址可能带
  时效参数），cache_dump/cache_hydrate 是缓存管理 op 本身。
- 缓存键 = (source, op, 规范化 payload, 源文档, 运行时版本标识) 的 sha256：文档或运行时变化即自然
  失效（解释器的缺陷修正不改变文档哈希，所以运行时的指纹也要入键）。
- 接线在 `crawler::crawl`：`script::run` 返回 `(结果, 是否成功)`，失败（含模板求值为空）不写入；
  `cache_dir` 参数为空串表示禁用缓存（测试与 render_probe 用）。
- 读取入口 `mojuan_core::cached_result`（命令 `crawl_cached`）：命中返回
  `{"data": ..., "fetchedAt": ms}` 并清除该源陈旧错误行，未命中返回 `null`。
- 条目保留期 7 天（src-tauri setup 启动时 `result_cache::prune` 清理）；新鲜度判定在前端
  （`fetchedAt` 与本地时钟比较），Rust 侧不设 TTL。

## 下载运行时（2026-10-10 起）

- `native/download.rs` 的 `DownloadRuntime`：队列状态机（`queue.rs`）与下载策略同处一层——
  常驻 worker（`std::thread`，数量 = 全局页并发 `DEFAULT_WORKERS`）、章内顺序、单页最多
  `DEFAULT_PAGE_ATTEMPTS` 次尝试、每页开始前检查取消、每次任务状态变化推一条进度。
- 宿主（src-tauri 的 `downloads`）只接两件事：页面下载（生产实现是 core 的
  `files::download_image`，`with_downloader` 是测试的替换口）与进度出口（构造时传入的回调，
  宿主把它接到 IPC Channel 上）。运行时不认识 Tauri：`cargo test` 里换一个假 downloader
  就能跑同一份策略代码，`run_task` 是测试面（worker 循环之外直接驱动，不依赖线程与等待）。
- 入队的磁盘去重（`files::chapter_downloaded`）在运行时内部；`enqueue` 返回入队结果与该任务
  此刻的进度，`cancel`/`retry` 返回最新进度。`DownloadTask::new` 由队列层派生 taskId。
- `files::download_image` 返回 `Result<(), String>`（失败原因来自 HTTP 状态与写盘错误）；
  整话失败时原因写进进度事件的 `error`（`第 N 页下载失败：<原因>`）。

## 命令 API 约定

- 公开函数接收 `&str`、返回 JSON 字符串，无 uniffi 包装。
- 命令层直接传 `&s` 或 `s.as_str()`，不要建 String 参数签名。

## 开发工作流与测试

- 改 Rust 核心：workspace 内直接编译，改完跑 `cargo test`（解析器有 fixture 测试）。
- 源码：直接读 `crates/mojuan-core/src/`（js/crawler/native/cache 模块），API 为 `&str` → JSON 字符串。
