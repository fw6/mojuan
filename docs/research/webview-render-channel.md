# 隐藏 webview 渲染通道（Cloudflare / 自建验证防护源，2026-09-30）

> **路径说明**（2026-10-12 布局改动）：本文里的 `desktop/` 现为 `apps/mojuan/`，`desktop/crates/` 现为 `crates/`，`updater/` 现为 `apps/updater/`，`npm`/`npx` 换成 `pnpm`。

背景：包子漫画（baozimh）在 2026-08 的加源调研里被放弃——`cn.baozimh.com` 的 search/classify/详情
301 到 `tw.baozimh.com`，普通 HTTP 客户端过不了验证页。本次为这类「JS 挑战 / 客户端环境校验」
防护源新增**隐藏 webview 渲染通道**：不可见 webview 加载目标 URL，等验证自动完成、页面渲染好后
取回完整 HTML，交给与普通抓取完全相同的源脚本 parse 契约。

## 方案

- **mojuan-core**（`crawler/render.rs`）：注册式渲染钩子 + 判据的唯一定义处。渲染源由各自的
  源适配器（`crawler/sources/*.rs` 的 `render_channel()`）声明（当前 baozimh / nnhanman）；
  `script.rs::fetch` 对渲染源整源改经 `render::fetch`。宿主未注册时返回「渲染通道未注册」错误，
  由该源 adapter 的错误存放处记录并呈现到前端错误行（mojuan-core 单独跑测试不依赖 webview）。
  判据与节奏都在这里：`STATE_SCRIPT`（状态探测脚本，返回
  `{rs, href, ch, denied, clean}`）、`HTML_SCRIPT`（取 `document.documentElement.outerHTML`）、
  `is_clean` / `is_denied`、`POLL_INTERVAL`（500ms）、`RENDER_TIMEOUT`（60s）。挑战页容器与标题
  随站点改版变动，改这一处两端（桌面 / 移动）同时生效。
- **src-tauri**（`src/render.rs`）：桌面端隐藏 webview 渲染服务，setup 时经 `render::init` 注册进
  mojuan-core。
  - 单例不可见窗口（label `render`，1280x800，`visible(false)`），懒创建；主窗口销毁时连带销毁，
    保持「关掉全部窗口即退出」的原有行为。
  - 每次渲染先导航回 `about:blank` 再导航目标：目标加载恒为全新跨文档导航，页面就绪判定用
    `location.href` + `document.readyState`（`eval_with_callback` 取回，远程页面零 IPC 权限，
    capability 不覆盖 render 窗口）。
  - 验证页等待：按 `POLL_INTERVAL` 探测 `STATE_SCRIPT`，Challenge 页（Cloudflare「Just a moment」/
    turnstile 容器，以及 baozimh tw 域自建的 proof-of-work `__gatekeeper_challenge`）等其自动跳转；
    Cloudflare 1020 拒绝页立即报错；连续两次干净检查后取 `HTML_SCRIPT`。
  - 诊断：`MOJUAN_RENDER_TRACE=1` 环境变量把每轮状态与 eval 结果打到 stderr。
- **探针**（`src-tauri/examples/render_probe.rs`）：live 验证与 fixture 采集。
  - `dump <url> <outfile>` 渲染单页写文件；
  - `crawl <source> <op> <payload>` 走 crawl 全链路；
  - `chain <source> <comicId> <chapterIndex>` 同进程 detail → images（验证进程内缓存）。

## 关键实现要点（踩过的坑）

1. **macOS 上 `on_page_load` 事件在跨站重定向时会丢**：`cn.baozimh.com → tw → 镜像域` 的纯 302 链
   一条 Finished 事件都不发（带 JS 挑战的多文档流程正常）。导航就绪判定不能依赖该事件，改用
   `location.href` 变化 + `about:blank` 复位。
2. **`readyState` 可能永远不到 `complete`**：阅读器页有挂起的统计/广告子资源。判据接受
   `interactive`（主文档解析完成，outerHTML 已含全部内容，解析 HTML 只需标记结构）。
3. **`eval` 在未提交的文档上会延迟执行**：早期「给旧文档打 stale 标记再导航」的做法里，标记
   迟到落到了新文档上，永远清不掉。复位 + href 判定替代此方案。
4. **爬虫侧的两类验证页**：Cloudflare 挑战（多语言标题 + `#challenge-form`/turnstile 容器）与
   包子漫画 tw 域自建 PoW（`__gatekeeper_challenge` 资源 + 「正在验证浏览器」标题）。验证通过后的
   票据 cookie（cf_clearance / gatekeeper）由 WKWebView 持久化数据存储保留，重启应用仍有效。
5. **baozimh 的实际链路**：搜索/详情/分类在 `cn.baozimh.com` 直接可得；章节阅读页要经
   `/user/page_direct?comic_id={站内id}&section_slot=&chapter_slot=` 中转（站内 id 带随机后缀，
   公开 slug 推不出来）→ 302 到镜像域（twmanga/twbzmg 等轮换）→ 自建验证 → 阅读页。

## baozimh 源接入（首个消费源）

- 页面是 AMP 服务端渲染：卡片 = `comics-card__poster` 锚（封面 amp-img）+ `comics-card__info`
  锚（标题 h3 / 作者 small.tags）；详情 = `h1.comics-detail__title` + `h2.comics-detail__author` +
  tag-list（首个 span 为状态）+ `p.comics-detail__desc` + 「最新：<a>」；章节锚
  `comics-chapters__item`（可见区最新 24 话与 `chapters_other_list` 全量重复，去重后按槽位升序，
  index = 1 起序号）；阅读页图片 = `amp-img id="chapter-img-{s}-{n}"` 的 src。
- 章节中转链 URL 由 detail 解析输出隐藏字段 `pageUrl`，Rust `post_process` 提取入进程内缓存
  （`crawler/baozimh.rs`）并剥离字段；images 的 `build_ctx` 从缓存取（同 webtoons seriesUrl /
  dongman viewerUrl 形状）。缓存驻留进程内，重启后首次进详情页重建。
- 图片 CDN（`s1.bzcdn.net` / `s1.baozimh.com`）无热链保护，前端不需加 Referer 表项。

## 验证（真网，本机数据中心 IP）

```bash
cd desktop/src-tauri
cargo run --example render_probe -- crawl baozimh search '{"keyword":"海贼"}'   # 77 条结果
cargo run --example render_probe -- crawl baozimh category '{"label":"热血"}'   # 37 条结果
cargo run --example render_probe -- chain baozimh baozimh-haizeiwang-weitianrongyilang 1187
# detail: 1187 章、pageUrl 不泄漏；images: 18 张（末章）／50 张（第 1 章）
```

离线侧：fixture 双轨（`tests/source_script_test.rs` + `baozimh.test.js`），fixture 从真网转储裁剪
（只去 AMP sizer/svg 展示噪音），另有 `crawl("search","baozimh",…)` 在无渲染通道宿主下报
「渲染通道未注册」并返回空结果的接线测试。

## 移动端（Android / iOS，2026-10-08）

tauri/wry 的 `WebviewWindow` 在移动端做不到「隐藏 webview」：Android 每个 activity 只有一个受
wry 记账的 webview（新建即 `setContentView` 替换整个界面），iOS 创建窗口即显示。所以移动端由
**自建 tauri 插件**（`desktop/crates/tauri-plugin-mojuan-render/`）自带原生代码实现：

- **Rust 侧**（`src/{lib,mobile,desktop}.rs`）：`init()` 注册插件（Android 经
  `register_android_plugin("io.github.fw6.mojuan.render", "RenderPlugin")`，iOS 经 `register_ios_plugin`
  绑定 Swift 的 `init_plugin_mojuan_render`）；`render(app, url)` 走 `run_mobile_plugin("render", ..)`
  同步调用（调用方是 `crawl` 命令的 `spawn_blocking` 线程），static `FLIGHT` 互斥串行化。
  宿主 setup 里 `init_fetcher(app.handle())` 把它注册给 mojuan-core。
- **请求/响应**：请求 `{url, stateScript, htmlScript, pollMs, timeoutMs}`（camelCase，与 Kotlin
  `@InvokeArg` / Swift `Decodable` 字段名严格对齐，`lib.rs` 的 `wire_contract_field_names` 测试固定
  契约）；响应 `{html}`；失败 `reject(可读文案)`，Rust 侧原样呈现。
- **原生侧**（`android/src/main/java/io/github/fw6/mojuan/render/RenderPlugin.kt`、
  `ios/Sources/RenderPlugin.swift`）：只做「加载 → 按 `pollMs` 评估 `stateScript` → 拒绝页立即
  reject → 连续两次 `clean` 后取 `htmlScript` → 超时 reject」。挑战页的选择器与标题正则只存在于
  mojuan-core 的 `STATE_SCRIPT`，原生侧不含任何站点知识；平台差异只留循环细节（复位 about:blank
  的等待上限、连续两次干净的次数、视口尺寸）。
  - 离屏 webview 懒创建、单例复用：Android `WebView(activity)` 加进 decorView 后整体位移出可见
    区域；iOS `WKWebView` 插到主视图最底层并位移。**完全不进视图树/窗口的 webview 会被系统当作
    不可见页面节流**（定时器被拉开间隔，验证挑战的 JS 可能跑不完），所以两端都是「在树里但看不见」，
    这也是相对「不加入视图树」方案的取舍：宁可多一个不可见子视图，也不要赌挑战页的 JS 在节流下
    60 秒内跑完。
  - 等待与超时都用主线程计时器（Android `Handler.postDelayed`、iOS
    `DispatchQueue.main.asyncAfter`），没有协程 / 后台队列：每一步都是异步回调，主线程不阻塞；
    WebView 实例与渲染状态因此只在主线程访问，不必上锁。
  - 视口 1280x800 CSS px（Android 按 density 换算物理尺寸），与桌面隐藏窗口同一尺寸，目标站的
    响应式布局因此与桌面端接近；UA 保持平台默认**不伪装**（Cloudflare 会比对 UA 与客户端提示，
    伪装反而更容易被判定为机器人，而通过验证是第一要务）。
  - 超时用独立计时器：渲染进程卡死时 `evaluateJavascript` 回调不会到达（Android 另有
    `onRenderProcessGone` 立即失败），结论由计时器给出；结算只认第一次（settled 标记）。
  - 导航回调只记诊断（两端都记主文档的加载失败，取消类错误除外），门控一律以轮询为准——桌面端
    实测跨站重定向会丢导航事件；超时文案里带上最后状态与导航错误。
  - 验证 cookie 随平台持久化存储保留（Android `CookieManager` + `flush()`，iOS
    `WKWebsiteDataStore.default()`），重启应用后仍是已验证状态。
- **Android 接入细节**：插件 `build.rs` 的 `android_path("android")` 让构建脚本输出
  `cargo:android_library_path`，app 的 `tauri-build` 据此重新生成
  `gen/android/tauri.settings.gradle`（`include ':tauri-plugin-mojuan-render'`）与
  `app/tauri.build.gradle.kts`，无需手工改 Gradle。release 混淆下插件类能存活是因为
  tauri-android 的 consumer rules 里 `-keep @app.tauri.annotation.TauriPlugin public class *`
  与 `@InvokeArg` 两条（R8 mapping 可核对：`io.github.fw6.mojuan.render.RenderPlugin` 保留原名）。

## 待真机确认（移动端）

- 离屏 webview 里 Cloudflare / 自建 PoW 挑战能否跑完（定时器节流、Android System WebView 与
  iOS WKWebView 两套内核的通过情况）。
- 挂载式离屏视图的尺寸风险：Android 按 density 换算出 1280 CSS px 的物理尺寸（3x 屏 = 3840px 宽），
  真机上要确认没有内存或绘制上的副作用；渲染进程崩溃与超时都有明确 reject 文案可对照。
- 验收口径与桌面一致：baozimh 搜索 / 分类 / 详情 / 章节图片全通，nnhanman 首话图片可取；
  日志过滤（Android `adb logcat -s MojuanRender`）可看到每轮状态与 reject 文案。

## 维护注意

- 镜像域轮换（cn.baozimh.com → twmanga.com / cn.twbzmg.com 等）由 `page_direct` 中转自动跟随，
  脚本里不硬编码镜像域；只有 `cn.baozimh.com` 是稳定入口。
- 站点改版时优先跑探针 dump 重新核对结构（搜索卡片 / 详情信息区 / 章节锚 / 阅读页 amp-img）。
- 验证页形态变化（新挑战标记）时更新 mojuan-core `crawler/render.rs` 的 `STATE_SCRIPT`（桌面与
  移动端共用；`crawler/render.rs` 的 QuickJS 测试用页面桩覆盖各形态）；桌面端
  `MOJUAN_RENDER_TRACE=1` 可看到每轮状态，移动端看 logcat / os_log 的 `MojuanRender` 标签。
- 渲染通道是单飞（一次一个页面）：crawl 并发调用在互斥锁排队，整体超时 60 秒。
