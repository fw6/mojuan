# Roadmap（桌面 v1 之后）

wayfinder 地图「从 Lynx 迁移到 Tauri」(#2) 已关闭，桌面 v1 功能集与全部决策定案。
以下为 v1 后的后续里程碑；每个里程碑启动时另开独立 effort（新 wayfinder 地图）。

## 源运行时系统（v1 后首个里程碑，grilling #11 定）

> 本里程碑的 wayfinder 地图（[wayfinder: 源运行时系统](https://github.com/fw6/mojuan/issues/12)）已于 2026-08-15 定案关闭：源解析迁出 Rust、由运行时解释、经公开源仓库 [fw6/cimoc-sources](https://github.com/fw6/cimoc-sources)（`sources.json`）分发，crawl 接线（buildUrl → Rust 抓取 → parse）、Settings 源管理（检查更新/sha256 校验/应用）、Sources 错误行。
>
> **源的定义方式改过**（2026-10-12，[ADR-0002](adr/0002-source-definition-as-document.md)）：源 = 一份 JSON **源文档**，由一份共享的**源运行时**解释，运行时随源仓库分发并可远程更新；HTML 求值经纯计算的宿主绑定 `__host.select` 调用 app 侧已有的 `scraper`；需要真正算法的 op 用文档内嵌的 `script` 钩子。内置源只保留 webtoons 一个（格式的参考实现、首启可用的保证、默认源、可更新不可卸载），其余源由用户从源目录安装或手动导入。加源 = 提交一份文档到源仓库。

- 源 = 源文档（JSON），由源运行时在 Rust 核心的 rquickjs（QuickJS）沙箱里解释；
  网络/Referer/缓存/热链代理留在 Rust 原生层（webview fetch 设不了头，research #4）。
- 远程源仓库分发：一份源运行时 + 每源一份文档 + 版本 + sha256 校验、app 内手动检查更新；
  签名体系后置（社区化时再上）。
- 文档由 Rust 侧类型化结构体校验，`schemars` 生成 JSON Schema 供编辑器补全与仓库提交时检查。
- 测试面是 (fixture, 文档, 期望) 三元组的共享驱动，加每源一条经真 QuickJS 的端到端。

## 离线阅读（已下载/本地漫画的阅读）

> 已实现（2026-08-15，[wayfinder 地图 #18](https://github.com/fw6/mojuan/issues/18)）：下载目录改为 `<dir>/<source>/<comicId>/…` 命名空间；Library「下载/本地」tab 点漫画就地展开章节 → 本地阅读器（`/local`，Reader local 模式，图片经本机 HTTP 代理的本地文件模式渲染，全程无网络）；「本地」tab 兼容旧扁平导入（source 记 `"local"`）；进度与在线共用 (source, comicId) 键。
>
> 阅读器（`/reader`，「继续阅读」那条路径）也接了同一条离线链（2026-10-12）：章节表按「结果缓存 → 下载清单 → 联网」取，已下载的话直接读磁盘上的页，取图统一经代理先查下载索引——断网时两条入口都能读已下载的章节。

## 移动里程碑（桌面 v1 后，grilling #3/#6 定）

- 功能集 = 桌面 v1 同一套；验收 = 核心阅读路径真机跑通。
- FCM 推送 + 后台下载需自定义 Kotlin/Swift 插件（预算 2–4 周）。
- **骨架与 spike 完成**（2026-08-15，[wayfinder 地图 #28](https://github.com/fw6/mojuan/issues/28) 全关）：grilling #29 定案验收仅核心阅读路径（书源→详情→无限滚动→进度）、存储层平台切换（桌面 store / 移动 fs）、图片同一套、下载仅前台、复用现有前端；research #30（fs 替换可行、iOS scheme 零改动/Android 改 URL 形态、init 产物）；task #31——`tauri android/ios init` 骨架 + 三个构建修复（rquickjs 加 bindgen feature 支持 iOS 绑定、Android bindgen 注入 NDK sysroot、`src-tauri/tauri` 软链到 CLI）+ Android 模拟器 spike 验证（app 稳定、Tauri bridge 通、前端完整渲染）。**下一步是真机跑通核心阅读路径端到端**（搜索→详情→无限滚动→进度，storage-fs 平台切换已实现待真机确认）。
- **移动端渲染通道完成**（2026-10-08）：受防护源（baozimh / nnhanman）在移动端不再报「渲染通道未注册」——自建插件 `crates/tauri-plugin-mojuan-render` 经 `run_mobile_plugin` 接入，接法与设计见 `docs/agents/tauri-development.md` 的「隐藏 webview 渲染通道」。Android release APK 构建通过（插件类经 consumer rules 保留、Gradle 模块自动接入），Swift 包与 Rust 的 iOS 目标编译通过；**iOS 应用链接在本机 Xcode 27 下被上游 swift-rs 的符号可见性问题阻断（CI 的 Xcode 26 不受影响，见该文的坑 9）**。真机待确认：离屏 webview 里挑战页 JS 能否跑完（定时器节流）与两套内核的通过情况；验收口径与桌面一致，见 `docs/research/webview-render-channel.md`。
- **Android OTA 完成**（2026-10-08）：Android 端的应用内升级（官方 `tauri-plugin-updater` 在移动端是空实现，另建一条）——分层、签名前提与验证步骤见 `docs/agents/tauri-development.md` 的「Android OTA」一节。**已在模拟器上端到端验过**（API 37 arm64，用本地通道 + 构建期 `--config` 覆盖 endpoint）：设置页「检查新版本 → 下载 → 安装」把 1.4.0 升到 1.5.0，系统回报 installation completed；失败分支也各验一次——sha256 不符、签名不符、未授权「安装未知应用」都给出可读原因。真机与线上通道（Worker 部署 + 发布一个带 `android.json` 的版本）仍待确认。

## e2e（tauri-driver）

- v1 不建（grilling #10 定）；功能集稳定、回归频繁时评估引入。

## 下载任务队列（多任务下载进度管理界面）

> **已实现**（2026-08-15，[wayfinder 地图 #20](https://github.com/fw6/mojuan/issues/20)）：下载从 Reader 内联逐页串行升级为 **Rust 侧常驻队列 + IPC Channel 推送进度**（`Mutex<DownloadQueue>` 入 State，setup spawn 2 个 worker，每页 `spawn_blocking(mojuan_core::download_image)`）+ TopBar「下载」管理页。任务粒度 = 一话（taskId = `source/comicId/chapterIndex`）；全局 2 页并发、章内顺序；状态 queued/downloading/done/failed/cancelled，单页重试 2 次；去重 = 已在磁盘入队即 done；内存态不持久化；下载入口在详情页章节区（点「下载」进入多选模式，勾选多话逐话入队，已在磁盘的章节显示为已下载、不可勾选）。研究纪要：`docs/research/tauri-progress-push.md`。

## 其它后置项（grilling #6 定）

- WebDAV 备份/恢复（收藏/历史/进度；v1.1 起也是旧手机数据互通的通道）——**已实现**（2026-08-15，[wayfinder 地图 #24](https://github.com/fw6/mojuan/issues/24)）：设置页「WebDAV 备份」段（地址/账号/密码 + 备份/恢复 + 确认弹窗）；单文件 `mojuan-backup.json` 内聚 `{version:1, exportedAt, favorites, history, progress}`；恢复整体覆盖三域，version≠1 拒绝；复用 core `webdav_put/get`（Basic Auth）。自动定时备份、钥匙串加密后置。
- 发布强化：正式签名/公证（macOS Developer ID + notarytool）、自动更新（tauri-updater）——**已实现**（2026-08-15 接入，2026-10-08 补齐更新通道；[wayfinder 地图 #26](https://github.com/fw6/mojuan/issues/26)，**不发 macOS 端**）：设置页「检查更新 → 下载（进度）→ 重启安装」；`tauri signer` 密钥对（公钥入 tauri.conf.json `plugins.updater.pubkey`，私钥在 GitHub Actions secret `TAURI_SIGNING_PRIVATE_KEY`）；release.yml 注入私钥，产物含 .sig + latest.json。更新通道是 `updater/` 里的 Cloudflare Worker（`mojuan.fengw.site`）：tauri-action 写进清单的制品地址是 GitHub 的 API 资产地址（普通 GET 取回的是元数据而不是文件），且 `workers.dev` 在本机所在网络连不上，所以清单与制品都由 Worker 取回、换地址后经自有域名对外提供，只提供已发布的版本（`release.yml` 直接发布，workflow 跑完即对外）。运维步骤见 `updater/README.md`。macOS 签名/公证仍整体排除。
