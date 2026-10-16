import { invoke, Channel } from "@tauri-apps/api/core";
import { hotlinkRefererFor, type SourceFacts } from "./lib/sources";

export interface Comic {
    id: string;
    source: string;
    sourceTitle: string;
    title: string;
    author: string;
    intro: string;
    cover: string;
    status: string;
    updateTime: string;
    lastChapter: string;
    tags: string[];
    lastReadChapter: number;
    lastReadTime: number;
}

export interface Chapter {
    index: number;
    title: string;
    pages: string[];
    /** 外链章节（内容托管站外，如 MangaPlus）：列表与「下一话」一律过滤（grilling #6） */
    external: boolean;
    downloaded: boolean;
    read: boolean;
}

/** 下载目录里的漫画条目（wayfinder #19：带 source，旧扁平布局为 "local"）。
 * 标题与封面来自下载目录里的作品元数据（`comic.json`）；旧下载没有这份元数据，
 * 两个字段是空串，展示时回落到 comicId。 */
export interface LocalComic {
    source: string;
    comicId: string;
    chapterCount: number;
    title: string;
    cover: string;
}

/** 扁平布局（旧下载）的作品 source：它们不在任何源里，没有在线作品页。 */
export const FLAT_SOURCE = "local";

/** 一部已下载作品的元数据（`read_comic_meta`）；没有这份元数据返回 null。 */
export interface ComicMeta {
    source: string;
    comicId: string;
    title: string;
    cover: string;
    /** 话序号（字符串形式，与 `chapter_<n>` 目录名一致）→ 章节标题 */
    chapters: Record<string, string>;
}

/** 调 Rust crawl 命令：payload 编码为 JSON 字符串，返回解析后的 JSON。
 * 成功结果由 Rust 侧写入结果缓存，供 crawlCached 读取（stale-while-revalidate）。 */
export function crawl<T>(op: string, source: string, payload: unknown): Promise<T> {
    return invoke<string>("crawl", { op, source, payload: JSON.stringify(payload) }).then(
        (json) => JSON.parse(json) as T,
    );
}

/** 缓存命中的抓取结果（stale-while-revalidate 的 stale 一侧）。 */
export interface CachedCrawl<T> {
    data: T;
    /** 抓取时刻（unix 毫秒），前端据此判断新鲜度。 */
    fetchedAt: number;
}

/** 读取抓取结果缓存（不触发网络）：先渲染它、再调 crawl 拉最新。
 * 未命中或缓存通道异常均返回 null（按未命中降级，不影响 crawl 主路径）。 */
export function crawlCached<T>(
    op: string,
    source: string,
    payload: unknown,
): Promise<CachedCrawl<T> | null> {
    return invoke<string>("crawl_cached", { op, source, payload: JSON.stringify(payload) })
        .then((json) => (JSON.parse(json) as CachedCrawl<T> | null) ?? null)
        .catch(() => null);
}

/** 调试运行记录里的一步。`validate` 是文档校验（失败时它是唯一一步、不发起请求）；
 * `plan` 是运行时求出的 URL 与请求头；`fetch` 是响应体（超 512 KB 截断并置 truncated，
 * 抓取失败时带 error 而不带 body）；`parse` 是解析输出与本次运行产出的隐藏值。 */
export type DebugStep =
    | { stage: "validate"; ok: boolean; error?: string }
    | { stage: "plan"; name: string; url: string; headers: Record<string, string> }
    | {
          stage: "fetch";
          name: string;
          url: string;
          body?: string;
          truncated?: boolean;
          error?: string;
      }
    | { stage: "parse"; data: unknown; hidden: DebugHiddenEntry[] };

/** parse 步骤里运行时交出的隐藏值（本次运行产出的，键是漫画 id）。 */
export interface DebugHiddenEntry {
    name: string;
    key: string;
    value: string;
}

/** 调试会话的隐藏值快照：名 → 键 → 值（入参与返回值同形，由前端持有并往返）。 */
export type DebugHidden = Record<string, Record<string, string>>;

/** 一次调试运行的记录。`data` 是 parse 的输出（未走到 parse 为 null）。 */
export interface DebugRun {
    ok: boolean;
    data: unknown;
    hidden: DebugHidden;
    steps: DebugStep[];
    error: { stage: string; message: string } | null;
}

/** 调试台跑一次取数：文档原文 + op + payload + 会话隐藏值快照。
 * 走真实网络、请求头与渲染通道，与线上取数是同一条路；不做重试、不写结果缓存、
 * 不碰任何已装源（调试台里的文档与已装源完全隔离）。 */
export function crawlDebug(
    document: string,
    op: string,
    payload: unknown,
    hidden: DebugHidden,
): Promise<DebugRun> {
    return invoke<string>("crawl_debug", {
        document,
        op,
        payload: JSON.stringify(payload),
        hidden: JSON.stringify(hidden),
    }).then((json) => JSON.parse(json) as DebugRun);
}

export const mojuanVersion = () => invoke<string>("mojuan_version");

/** 设置移动端系统栏（状态栏与导航栏）的显隐与图标明暗。
 * 桌面端没有系统栏，调用什么都不做——命令在两端都注册，调用方不必按平台分叉。
 * 安全区不从这里取：用 CSS 的 `env(safe-area-inset-*)`，与外壳其余页面同一个来源。 */
export const setSystemBars = (opts: { hidden: boolean; lightIcons: boolean }) =>
    invoke<void>("set_system_bars", opts);

/** 扫描下载目录：`[{source, comicId, chapterCount, title, cover}]`。 */
export const scanLocal = (dir: string) =>
    invoke<string>("scan_local", { dir }).then(
        (json) => JSON.parse(json) as LocalComic[],
    );

/** 一部已下载作品的元数据（标题、封面、各话标题）；没有这份元数据返回 null。 */
export const readComicMeta = (dir: string, source: string, comicId: string) =>
    invoke<string>("read_comic_meta", { dir, source, comicId }).then(
        (json) => (JSON.parse(json) as ComicMeta | null) ?? null,
    );

/** 已下载章节条目：`{url: string, path: string}`（path 为相对路径 chapter_<n>/<file>）。 */
export interface DownloadedPage {
    url: string;
    path: string;
}

/** 某漫画已下载章节：`{chapterIndex: DownloadedPage[]}`（wayfinder #31：离线也传 url，含 source/comicId）。 */
export const listDownloaded = (dir: string, source: string, comicId: string) =>
    invoke<string>("list_downloaded", { dir, source, comicId }).then(
        (json) => JSON.parse(json) as Record<string, DownloadedPage[]>,
    );

/** 某源最近一次错误（wayfinder #17：Sources 错误行 / Settings 源区）。 */

// ---------- 下载任务队列（wayfinder #20/#22/#23） ----------

export type DownloadStatus = "queued" | "downloading" | "done" | "failed" | "cancelled";

/** 进度事件载荷（grilling #22 #6）：`{taskId, status, done, total, error?}`。 */
export interface DownloadProgress {
    taskId: string;
    status: DownloadStatus;
    done: number;
    total: number;
    error?: string;
}

/** 队列快照里的任务视图（进度 + 展示字段，Downloads 页任务行）。 */
export interface DownloadTaskView extends DownloadProgress {
    source: string;
    comicId: string;
    comicTitle: string;
    comicCover: string;
    chapterIndex: number;
    /** 章节标题（源给的，如「第 12 话」）；话序号只是源内部的 id，不能当名字显示。 */
    chapterTitle: string;
}

/** 入队结果（grilling #22 #4/#5 去重语义）。 */
export type EnqueueResult = "queued" | "alreadyDownloaded" | "alreadyQueued";

export interface EnqueueOutcome {
    result: EnqueueResult;
    progress: DownloadProgress;
}

/** 订阅下载进度（Downloads 页挂载时调用；Channel 存 Rust State 供 worker 推送）。 */
export const subscribeDownloads = (channel: Channel<DownloadProgress>) =>
    invoke("subscribe_downloads", { channel });

/** 退订（组件卸载时清理订阅，grilling #23 #6）。 */
export const unsubscribeDownloads = () => invoke("unsubscribe_downloads");

/** 队列快照（任务视图数组，含展示字段）。 */
export const getDownloads = () =>
    invoke<string>("get_downloads").then((json) => JSON.parse(json) as DownloadTaskView[]);

/** 入队一话下载（已在磁盘 → alreadyDownloaded 不入队；重复入队 → alreadyQueued）。
 * 封面与话名一并入队：下载页的卡片与章节行据此显示，不必回源抓取。 */
export const enqueueDownload = (params: {
    source: string;
    comicId: string;
    comicTitle: string;
    comicCover: string;
    chapterIndex: number;
    chapterTitle: string;
    dir: string;
    referer: string;
    urls: string[];
}): Promise<EnqueueOutcome> =>
    invoke<string>("enqueue_download", params).then((json) => JSON.parse(json) as EnqueueOutcome);

/** 取消任务（排队/下载中 → cancelled）。返回最新进度或 null。 */
export const cancelDownload = (taskId: string): Promise<DownloadProgress | null> =>
    invoke<string>("cancel_download", { taskId }).then((json) =>
        json === "null" ? null : (JSON.parse(json) as DownloadProgress),
    );

/** 重试任务（failed/cancelled → 重新排队）。返回最新进度或 null。 */
export const retryDownload = (taskId: string): Promise<DownloadProgress | null> =>
    invoke<string>("retry_download", { taskId }).then((json) =>
        json === "null" ? null : (JSON.parse(json) as DownloadProgress),
    );

/** 清空已完成（done/failed/cancelled），返回移除数量。 */
export const clearDownloads = () => invoke<number>("clear_downloads");

/** 删除某漫画的下载：磁盘上的整目录（含下载索引与全部章节）与该作品在下载队列里的记录。
 * 在途的章节先取消，等当前页写完才删目录。 */
export const deleteDownloaded = (dir: string, source: string, comicId: string) =>
    invoke<void>("delete_downloaded", { dir, source, comicId });

/** 下载队列结构变化的事件名（有作品被整组移除）。进度通道只能表达单任务的状态变化，
 * 表达不了「这个作品整个没了」，下载页据此重取快照。 */
export const DOWNLOADS_CHANGED_EVENT = "download://changed";

// ---------- 存储占用与清理 ----------

/** 一类存储的占用：`bytes` 是字节数，`count` 是条数（下载那项是作品数）。 */
export interface StorageUsageEntry {
    bytes: number;
    count: number;
}

/** 三项存储占用：图片缓存、结果缓存与下载（`storage_usage`）。 */
export interface StorageUsage {
    image: StorageUsageEntry;
    result: StorageUsageEntry;
    download: StorageUsageEntry;
}

/** 统计三项存储占用（图片缓存、结果缓存与下载）；扫描下载目录较慢，Rust 侧走阻塞线程。 */
export const storageUsage = (dir: string): Promise<StorageUsage> =>
    invoke<string>("storage_usage", { dir }).then((json) => JSON.parse(json) as StorageUsage);

/** 已下载作品的一条占用：`bytes` 是整部作品目录的递归字节数，`pages` 是页文件数
 * （点开头的元数据文件不算页）。标题与封面取自下载目录里的作品元数据，没有就是空串。 */
export interface DownloadComic {
    source: string;
    comicId: string;
    title: string;
    cover: string;
    chapters: number;
    pages: number;
    bytes: number;
}

/** 按作品列出下载占用（存储页的下载列表）。返回顺序不定，消费方自己排。 */
export const downloadComics = (dir: string): Promise<DownloadComic[]> =>
    invoke<string>("download_comics", { dir }).then(
        (json) => JSON.parse(json) as DownloadComic[],
    );

/** 一话的完整性检查结果：`pages` 是这一话的期望页数，`missing`/`broken` 是 0 基页序号
 * （与下载命名一致，界面显示时加 1），`manifest` 表示这一话有没有页清单。 */
export interface ChapterCheck {
    chapterIndex: number;
    pages: number;
    missing: number[];
    broken: number[];
    manifest: boolean;
}

/** 一部作品的完整性检查结果（`check_download`）。 */
export interface DownloadCheck {
    chapters: ChapterCheck[];
    missingPages: number;
    brokenFiles: number;
    /** 没有页清单、因此完整性未被核对的话数（旧下载）。 */
    unchecked: number;
}

/** 按作品检查下载完整性：有页清单的按清单比对，没有的旧下载按下载索引比对。
 * 只读本地文件，不发网络请求。 */
export const checkDownload = (
    dir: string,
    source: string,
    comicId: string,
): Promise<DownloadCheck> =>
    invoke<string>("check_download", { dir, source, comicId }).then(
        (json) => JSON.parse(json) as DownloadCheck,
    );

/** 清空图片缓存（磁盘 + 内存表）。 */
export const clearImageCache = (): Promise<void> => invoke<void>("clear_image_cache");

/** 清空结果缓存（磁盘 + 内存表）。 */
export const clearResultCache = (): Promise<void> => invoke<void>("clear_result_cache");

/** 设置图片缓存上限（字节；0 表示不限制），Rust 侧就地整理到上限以内。 */
export const setImageCacheLimit = (bytes: number): Promise<void> =>
    invoke<void>("set_image_cache_limit", { bytes });

/** 某源最近一次错误（wayfinder #17：Sources 错误行 / Settings 源区）。 */
export interface SourceError {
    message: string;
    /** unix 毫秒 */
    at: number;
}

/** 同步载荷：源运行时（可选，缺省用内置）+ 有序的源文档列表（顺序即源清单顺序）。 */
export interface SyncPayload {
    runtime?: string;
    sources: { id: string; document: string }[];
}

/** 同步结果：被接受的源的前端事实，与被拒绝的源及原因（坏文档保留已装版本）。 */
export interface SyncResult {
    sources: SourceFacts[];
    rejected: { id: string; reason: string }[];
}

/** 把已装源（源运行时 + 各源文档）同步进 Rust 注册表（启动/安装/更新后调用）。 */
export const syncSources = (payload: SyncPayload): Promise<SyncResult> =>
    invoke<string>("sync_sources", { payload: JSON.stringify(payload) }).then(
        (json) => JSON.parse(json) as SyncResult,
    );

/** 源文档的 JSON Schema（源管理页的手动导入说明与编辑器补全用）。 */
export const sourceSchema = (): Promise<string> => invoke("source_schema");

/** 各源最近错误：{source: {message, at}}。 */
export const sourceErrors = (): Promise<Record<string, SourceError>> => invoke("source_errors");

/** 本机图片代理端口（research #31 换代理：自用 + Android 优先）。Rust 在 127.0.0.1 起
 * HTTP 服务，单端点 /img 同时服务热链域缓存取图与本地文件（path 优先、否则 url），
 * 绕过自定义 scheme 在移动端 webview 的超时/取消。启动时 initImgProxy() 取端口。 */
let imgProxyPort: number | null = null;

export const initImgProxy = async (): Promise<void> => {
    imgProxyPort = await invoke<number>("img_proxy_port");
};

/** 告诉代理下载目录（wayfinder #31：端点按 source/comicId 读下载索引）。
 * 前端启动 / settings 变更时调用。 */
export const setImgProxyDownloadDir = (dir: string) =>
    invoke<void>("img_proxy_set_download_dir", { dir });

function proxyBase(): string {
    return imgProxyPort ? `http://127.0.0.1:${imgProxyPort}` : "";
}

/** 图片地址重写为本机代理 `/img`（research #31 换代理：单端点同时服务热链取图与本地文件）。
 * 调用方无需区分本地与网络：
 * - 本地路径（旧下载数据没有索引记录）→ `/img?path=..`，相对路径由代理按
 *   `<下载目录>/<source>/<comicId>` 定位，所以路径形态也要带上 source+comicId；
 * - URL → `/img?url=..&ref=..`（源注册表声明的热链 Referer），带 source+comicId 时代理
 *   先查下载索引，命中直接读下载文件，未命中才联网取图。
 * 没有要带 Referer 的域、也没有 source+comicId 的图片保持直连（吃 webview 的 HTTP 缓存）；
 * 代理端口没就绪时本地路径没有可用的地址。 */
export function imgSrc(
    value: string,
    opts?: { source?: string; comicId?: string },
): string {
    const base = proxyBase();
    const { source, comicId } = opts ?? {};
    const local = Boolean(source && comicId);
    const localParams = () => [
        `source=${encodeURIComponent(source!)}`,
        `comicId=${encodeURIComponent(comicId!)}`,
    ];
    if (!/^https?:\/\//i.test(value)) {
        if (!base) return "";
        const params = [`path=${encodeURIComponent(value)}`];
        if (local) params.push(...localParams());
        return `${base}/img?${params.join("&")}`;
    }
    const referer = hotlinkRefererFor(value);
    if (!base || (!referer && !local)) return value;
    const params = [`url=${encodeURIComponent(value)}`];
    if (referer) params.push(`ref=${encodeURIComponent(referer)}`);
    if (local) params.push(...localParams());
    return `${base}/img?${params.join("&")}`;
}

// ---------- WebDAV 备份/恢复（wayfinder #24/#25：core 传输，前端组装内容） ----------

export interface WebdavPutResult {
    success: boolean;
    status: number;
}

export interface WebdavGetResult {
    ok: boolean;
    content?: string;
    status?: number;
    error?: string;
}

/** WebDAV PUT 备份文件（core webdav_put：Basic Auth）。 */
export const webdavPut = (
    base: string,
    user: string,
    password: string,
    fileName: string,
    content: string,
): Promise<WebdavPutResult> =>
    invoke<string>("webdav_put", { base, user, password, fileName, content }).then(
        (json) => JSON.parse(json) as WebdavPutResult,
    );

/** WebDAV GET 读取备份文件（core webdav_get：Basic Auth）。 */
export const webdavGet = (
    base: string,
    user: string,
    password: string,
    fileName: string,
): Promise<WebdavGetResult> =>
    invoke<string>("webdav_get", { base, user, password, fileName }).then(
        (json) => JSON.parse(json) as WebdavGetResult,
    );

// ---------- Android OTA 更新（桌面端走 @tauri-apps/plugin-updater） ----------
// 这三步是一个状态机，必须按 check → download → install 的顺序调用：Rust 侧
// （src-tauri 的 ota 模块）把中间结果存在 State 里，跳步会报「先检查更新」。

/** 检查结果：`available` 为真时 version 是通道给出的新版本号。 */
export interface OtaCheck {
    available: boolean;
    /** 当前安装的版本。 */
    current: string;
    /** 通道里的最新版本（没有可发布版本时缺省）。 */
    version?: string;
}

/** 下载进度（与 Rust 侧 OtaProgress 的 camelCase 字段一致）。 */
export interface OtaProgress {
    event: "started" | "progress" | "finished";
    done: number;
    total: number;
}

/** 已下载待安装的安装包。 */
export interface OtaDownloaded {
    version: string;
    path: string;
}

/** 安装结果：`confirming` 表示系统安装确认界面已拉起，`installed` 表示已装上。 */
export interface OtaInstallResult {
    status: string;
    version: string;
}

/** 拉更新通道的 Android 清单，与已安装版本比对。 */
export const otaCheck = (): Promise<OtaCheck> =>
    invoke<string>("ota_check").then((json) => JSON.parse(json) as OtaCheck);

/** 下载安装包到缓存目录（进度经 Channel 推送），落盘后校验 sha256。 */
export const otaDownload = (channel: Channel<OtaProgress>): Promise<OtaDownloaded> =>
    invoke<string>("ota_download", { channel }).then(
        (json) => JSON.parse(json) as OtaDownloaded,
    );

/** 把下载好的安装包交给系统安装器（安装成功后系统会结束本进程）。 */
export const otaInstall = (): Promise<OtaInstallResult> =>
    invoke<string>("ota_install").then((json) => JSON.parse(json) as OtaInstallResult);

/** 是否已获得「安装未知应用」授权。 */
export const otaCanInstall = (): Promise<boolean> => invoke<boolean>("ota_can_install");

/** 跳到系统的「安装未知应用」授权页。 */
export const otaOpenInstallSettings = (): Promise<void> =>
    invoke<void>("ota_open_install_settings");
