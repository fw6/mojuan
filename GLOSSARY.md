# GLOSSARY.md — 墨卷

墨卷 漫画阅读器的领域术语表。桌面 v1（Tauri v2 + React）先落地，移动端（iOS/Android）为后置里程碑，术语跨端共享。术语来源：原 Lynx 产品的 墨卷 约定 + wayfinder grilling #6 / #11 定案（2026-08-15）。

## 术语

- **漫画源（source）**：提供漫画内容的站点（如 webtoons、mangadex、copymanga、dongman、manhuagui、baozimh、nnhanman、kxmanhua、hentara）。每个源 = 一个运行时加载的爬虫脚本模块（执行于 Rust 核心的嵌入 JS 运行时），定义 URL 构造与解析规则，以 sourceId 标识，经源仓库分发更新（grilling #11 定案）。
- **源适配器（source adapter）**：一个源在 Rust 侧的全部知识，收在 `crawler/sources/` 的一个文件里：网络请求头、ctx 派生（交给脚本的缓存/网络派生值）、Rust 直连的 op、隐藏字段提取、是否走渲染通道、默认脚本、图片热链对、最近错误。以 sourceId 注册进注册表（顺序即前端源清单的显示顺序，首个为默认源）；新增一个源 = 加一个文件 + 在注册表里加一行。
- **渲染源（render source）**：带 JS 挑战 / 客户端环境校验防护、普通 HTTP 客户端过不去的源（baozimh —— Cloudflare 防护；nnhanman —— 整站 TLS 连接被重置）。页面经**渲染通道（render channel）**取：宿主（桌面端 src-tauri）用不可见 webview 加载目标 URL，等验证自动完成后取回渲染好的 HTML，再走与普通源完全相同的 parse 契约；无 webview 宿主（core 测试）下渲染源返回「渲染通道未注册」。设计见 `docs/research/webview-render-channel.md`。
- **源仓库（source repository）**：分发源脚本的公开远程索引——单一 index.json，每个源条目内嵌脚本源码 + 元数据 + 递增整数版本 + sha256 校验；app 内手动检查更新（版本对比、sha256 校验通过后原子替换已装源）。签名体系后置（grilling #16 定案）。
- **已装源（installed source）**：app 内已安装、可用的源；内置源（webtoons/mangadex/copymanga/dongman/manhuagui/baozimh/nnhanman/kxmanhua/hentara）随 app 内置，版本独立于 app 版本，经源仓库手动更新。源管理入口在设置（列表 / 检查更新 / 应用更新；grilling #16 定案）。
- **爬虫（crawl）**：按源规则抓取列表 / 详情 / 章节 / 图片的引擎。网络取数（文本/JSON/字节，带 Referer/UA）、磁盘缓存与热链图片代理驻留 Rust 核心（mojuan-core）；解析规则在源脚本中（v1 后按 grilling #11 迁移，v1 期间解析暂留 Rust）。
- **结果缓存（result cache）**：列表 / 详情类抓取（categories / category / search / detail）成功结果的缓存——内存 LRU + 磁盘（`<appCacheDir>/results/`），键含源脚本哈希（源脚本更新即自然失效），失败结果不写入；前端加载先渲染缓存、再拉最新（stale-while-revalidate），新鲜窗口（2 分钟）内切换源 / 分类不发请求。图片地址（images）不缓存。
- **漫画（comic）**：一部作品，以（source, comicId）唯一标识。
- **章节（chapter）**：漫画的一个话。源内以序号 chapterIndex 标识；同一作品的章节按章序排列。
- **外链章节（external chapter）**：images 为空、内容托管在站外的章节（如 MangaDex 上指向 MangaPlus 的章节）。一律过滤：不出现在章节列表，也不进入「下一话」；只有外链章节的书显示空态。桌面 v1 不做跳浏览器等任何外链处理。
- **无限滚动（infinite scroll，又称卷纸流）**：阅读器的唯一阅读形态——章节内连续滚动，滚到话末自动加载下一话，跨话连续阅读。
- **阅读模式（reading mode）**：已无此概念。翻页模式自桌面 v1 起废弃，不存在模式切换；「默认阅读模式」设置项随之删除。
- **进度（progress）**：读者的阅读位置，由应用自动记录（当前章节 + 话内第几张图 + 图内位置，按视口中心算），阅读时静默落盘，重进阅读器恢复。不提供手动保存。
- **收藏（favorites）**：用户收藏的漫画列表。
- **历史（history）**：最近阅读记录。
- **下载（download）**：把章节图片保存到本地，目录约定为「下载目录/<source>/<comic>/<chapter>/<page>」（wayfinder #19 命名空间，跨源同 id 不撞目录）；入口在漫画详情页的章节区：点「下载」进入多选模式，勾选的章节逐话**入队**（wayfinder #20/#22），由 **下载运行时**按章内顺序、全局 2 页并发下载，进度经 IPC Channel 推送（`download://progress`）。已下载漫画离线可读：Library「下载/本地」tab 进 `/local` 本地阅读器，详情页的「继续阅读」在取不到详情时也退回下载目录（两条入口的图片都经本机 HTTP 代理先查**下载索引**读本地文件）。
- **下载任务（download task）**：多任务下载队列（wayfinder #20 已实现）：一话一个任务，taskId = `source/comicId/chapterIndex`；状态 queued/downloading/done/failed/cancelled；单页失败重试 2 次（共 3 次尝试）；去重 = 已在磁盘入队即 done；内存态不持久化；TopBar「下载」页管理（进度条/取消/重试/清空已完成）。
- **下载运行时（download runtime）**：下载任务的队列状态机与下载策略（常驻 worker、章内顺序、单页重试、取消检查、进度推送）同处一层，在 mojuan-core 的 `native::download`；宿主只接页面下载与进度出口两件事（见 `docs/agents/mojuan-core.md` 的「下载运行时」）。
- **本地扫描（local scan）**：用户选择一个文件夹，导入其中已下载的漫画（Library「本地」入口）。
- **自动更新（auto-update）**：Windows/Linux 的 tauri-updater 自动更新（wayfinder #26 已实现；**不发 macOS 端**）：设置页「检查更新」→ 下载（进度）→「重启安装」；tauri signer 密钥对（公钥在 tauri.conf.json `plugins.updater.pubkey`，私钥在 CI secret `TAURI_SIGNING_PRIVATE_KEY`）；发布走 release.yml（tag 推上去直接发布，不停在 draft）。
- **更新通道（update channel）**：给更新器提供清单与制品的服务（`updater/`，Cloudflare Worker，域名 `mojuan.fengw.site`，运维步骤见 `updater/README.md`）。仓库私有、GitHub Releases 对未登录客户端返回 404，所以清单与制品都由这个 Worker 用 `GITHUB_TOKEN` 从 GitHub Releases 取回后对外提供；只提供 GitHub 判定的「最新已发布版本」，草稿与预发布版本不对外。
- **Android OTA 更新（in-app update）**：Android 端的应用内升级。官方 `tauri-plugin-updater` 声明 `support.android = none`（移动端 `install_inner` 是空实现），桌面那条路在 Android 上不可用，所以另建一条：设置页「软件更新」→ 检查新版本（拉更新通道的 `android.json`，与已安装版本按 semver 比对）→ 下载（进度 + sha256 校验）→ 交给系统安装器（`PackageInstaller` 会话，系统弹安装确认，用户确认后装上）。清单拉取、版本比对、下载与校验在 mojuan-core 的 `native::ota`；安装通道是自建插件 `tauri-plugin-mojuan-update`（Android 侧 Kotlin，iOS 侧明确回「不支持」）。Android 只允许同签名的包覆盖安装，所以 CI 用固定的发布密钥签名（secret `ANDROID_KEYSTORE_BASE64`），客户端在交出去之前先比一次签名，把失败提前成可读的原因。
- **WebDAV 备份（backup）**：收藏 / 历史 / 进度的 WebDAV 备份与恢复（wayfinder #24 已实现；也是日后旧手机数据互通的通道）：单文件 `mojuan-backup.json` 内聚 `{version, exportedAt, favorites, history, progress}`，设置页「WebDAV 备份」段配置地址/账号/密码（明文存 settings，钥匙串后置）；恢复整体覆盖三域、version≠1 拒绝；传输复用 core `webdav_put/get`（Basic Auth）。
