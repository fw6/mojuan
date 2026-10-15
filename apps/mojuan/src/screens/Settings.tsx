import { useEffect, useState } from "react";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import {
    CircleCheck,
    CloudDownload,
    CloudUpload,
    FlaskConical,
    FolderOpen,
    Info,
    RefreshCw,
    ScrollText,
    SlidersHorizontal,
    TriangleAlert,
} from "lucide-react";
import {
    exportBackupJson,
    importBackupData,
    parseBackupJson,
} from "../lib/storage/backup";
import {
    getSettings,
    setSettings,
    type Settings as SettingsT,
} from "../lib/storage/settings";
import {
    getOrder,
    getSources,
    installSourceDocument,
    putRuntime,
    putSource,
    removeSource,
    resyncSources,
    type SourceEntry,
} from "../lib/storage/sources";
import { SOURCES, sourceTitle } from "../lib/sources";
import { usePageActive } from "../lib/page-active";
import { useTheme } from "../lib/theme";
import { errorFirstLine } from "../lib/errors";
import {
    sourceErrors,
    setImgProxyDownloadDir,
    webdavGet,
    webdavPut,
    mojuanVersion,
    otaCheck,
    otaDownload,
    otaInstall,
    otaCanInstall,
    otaOpenInstallSettings,
    type OtaProgress,
    type SourceError,
} from "../api";
import { check as checkUpdate, type Update } from "@tauri-apps/plugin-updater";
import { Channel } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { cn } from "../lib/utils";
import { Button } from "../components/beui/button";
import { Switch } from "../components/beui/switch";
import { Input } from "../components/beui/input";
import {
    AnimatedBadge,
    type AnimatedBadgeStatus,
} from "../components/beui/animated-badge";
import { LinkButton, Loading, PageHeader, Panel, SettingRow, Tag } from "../components/ui";

/** 备份文件名（grilling #25 #2：单文件聚合）。 */
const BACKUP_FILE = "mojuan-backup.json";

/** macOS 平台检测：ad-hoc 签名无法过 Gatekeeper 整包替换，macOS 不发自动更新（wayfinder #26）。 */
const IS_MACOS = navigator.userAgent.includes("Mac");

/** iOS 检测：UA 里也带 "Mac OS X"，所以要在 IS_MACOS 之外单独认一次。 */
const IS_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent);

/** Android 平台检测：走应用内 OTA——更新通道的 android.json + 系统安装器。 */
const IS_ANDROID = navigator.userAgent.includes("Android");

/** 没有应用内更新通道的平台：macOS 与 iOS 都只能手动装新版。 */
const NO_INAPP_UPDATE = IS_MACOS || IS_IOS;

/** 源仓库索引：一份源运行时 + 各源文档（每份带整数版本与 sha256）。
 * 目录与更新走同一份索引；手动导入的源不经索引。 */
const REPO_INDEX_URL =
    "https://raw.githubusercontent.com/fw6/cimoc-sources/main/sources.json";

/** 索引里的一个源条目。 */
interface RepoEntry {
    name: string;
    version: number;
    /** 源文档（JSON 原文）。 */
    document: string;
    sha256: string;
}

/** 索引里的源运行时条目（可选：没有就继续用 app 内置的那份）。 */
interface RepoRuntime {
    version: number;
    script: string;
    sha256: string;
}

interface RepoIndex {
    runtime?: RepoRuntime;
    sources: Record<string, RepoEntry>;
}

/** 内置源：随 app 打包，不可卸载（首启可用的保证）。 */
const BUILTIN_SOURCES = ["webtoons"];

async function sha256Hex(s: string): Promise<string> {
    const data = new TextEncoder().encode(s);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

export default function Settings() {
    const { isDark, setDark } = useTheme();
    const [settings, setSettingsState] = useState<SettingsT | null>(null);
    const [version, setVersion] = useState("");
    // 源区（ADR-0002：源文档 + 源运行时）
    const [sources, setSourcesState] = useState<Record<string, SourceEntry>>({});
    const [order, setOrder] = useState<string[]>([]);
    const [errors, setErrors] = useState<Record<string, SourceError>>({});
    const [checking, setChecking] = useState(false);
    const [applying, setApplying] = useState(false);
    const [catalog, setCatalog] = useState<RepoIndex | null>(null);
    const [importText, setImportText] = useState("");
    const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(
        null,
    );
    // WebDAV 段（wayfinder #24/#25）
    const [webdav, setWebdav] = useState({ baseUrl: "", user: "", password: "" });
    const [backing, setBacking] = useState(false);
    const [restoring, setRestoring] = useState(false);
    // 更新段（wayfinder #26/#27：检查/下载进度/重启安装）
    const [update, setUpdate] = useState<Update | null>(null);
    const [checkingUpd, setCheckingUpd] = useState(false);
    const [downloadingUpd, setDownloadingUpd] = useState(false);
    const [downloaded, setDownloaded] = useState(false);
    const [updProgress, setUpdProgress] = useState<{
        done: number;
        total: number;
    } | null>(null);
    // Android OTA 段（移动端：检查 → 下载 → 交给系统安装器）
    const [otaVersion, setOtaVersion] = useState<string | null>(null);
    const [otaChecking, setOtaChecking] = useState(false);
    const [otaDownloading, setOtaDownloading] = useState(false);
    const [otaReady, setOtaReady] = useState(false);
    const [otaProgress, setOtaProgress] = useState<{
        done: number;
        total: number;
    } | null>(null);

    useEffect(() => {
        void mojuanVersion()
            .then(setVersion)
            .catch(() => {});
        void getSettings().then((s) => {
            setSettingsState(s);
            if (s.webdav) setWebdav(s.webdav);
        });
    }, []);

    // 源清单在每次进入设置页时重取：保留页的挂载 effect 不会重跑，调试台里装上的源要在这里出现
    const active = usePageActive();
    useEffect(() => {
        if (!active) return;
        void refreshSources();
    }, [active]);

    async function refreshSources() {
        const [srcs, errs, ord] = await Promise.all([
            getSources(),
            sourceErrors().catch(() => ({})),
            getOrder(),
        ]);
        setSourcesState(srcs);
        setErrors(errs);
        setOrder(ord);
    }

    async function pickDir() {
        const dir = await open({ directory: true });
        if (typeof dir !== "string") return;
        await setSettings({ downloadDir: dir });
        setSettingsState((s) => (s ? { ...s, downloadDir: dir } : s));
        // 代理按这个目录查下载索引（离线阅读读本地文件），改了就同步，不用重启
        await setImgProxyDownloadDir(dir);
    }

    async function toggleTrim(trim: boolean) {
        await setSettings({ autoTrim: trim });
        setSettingsState((s) => (s ? { ...s, autoTrim: trim } : s));
    }

    async function toggleFollow(follow: boolean) {
        await setSettings({ followUpdate: follow });
        setSettingsState((s) => (s ? { ...s, followUpdate: follow } : s));
    }

    // ---------- 源管理（ADR-0002：源文档由源仓库分发，也可手动导入） ----------

    /** 拉源仓库索引（目录与更新共用一份）。 */
    async function loadCatalog() {
        setChecking(true);
        setNotice(null);
        try {
            const resp = await fetch(REPO_INDEX_URL);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const index = (await resp.json()) as RepoIndex;
            setCatalog(index);
            const installed = await getSources();
            const updatable = Object.entries(index.sources ?? {}).filter(
                ([id, repo]) => installed[id] && repo.version > installed[id].version,
            );
            setNotice({
                kind: "ok",
                text: `源目录里有 ${Object.keys(index.sources ?? {}).length} 个源，${updatable.length} 个可更新`,
            });
        } catch (e) {
            setNotice({ kind: "err", text: `读取源目录失败：${String(e)}` });
        } finally {
            setChecking(false);
        }
    }

    /** 索引里的运行时（有则一并装上；sha256 不符就继续用当前那份）。 */
    async function installRuntime(index: RepoIndex) {
        const repo = index.runtime;
        if (!repo) return;
        const hex = await sha256Hex(repo.script);
        if (hex !== repo.sha256) {
            throw new Error("源运行时的文件损坏（sha256 不符）");
        }
        await putRuntime({ version: repo.version, script: repo.script });
    }

    /** 装/更新一个源：先按 sha256 校验文档，再写入并重新同步。 */
    async function installSource(id: string, repo: RepoEntry) {
        setApplying(true);
        setNotice(null);
        try {
            const hex = await sha256Hex(repo.document);
            if (hex !== repo.sha256) {
                throw new Error(`${repo.name} 的文件损坏（sha256 不符）`);
            }
            await putSource({
                sourceId: id,
                version: repo.version,
                document: repo.document,
                updatedAt: Date.now(),
            });
            const rejected = await resyncSources();
            await refreshSources();
            if (rejected.length > 0) {
                setNotice({ kind: "err", text: `${repo.name} 未装载：${rejected[0].reason}` });
            } else {
                setNotice({ kind: "ok", text: `已安装 ${repo.name} v${repo.version}` });
            }
        } catch (e) {
            setNotice({ kind: "err", text: `安装失败：${String(e)}` });
        } finally {
            setApplying(false);
        }
    }

    /** 目录里全部可更新的源一次装上（含索引里的运行时）。 */
    async function applyUpdates() {
        if (!catalog) return;
        setApplying(true);
        setNotice(null);
        try {
            await installRuntime(catalog);
            const installed = await getSources();
            let applied = 0;
            let failed = 0;
            for (const [id, repo] of Object.entries(catalog.sources ?? {})) {
                const cur = installed[id];
                if (!cur || repo.version <= cur.version) continue;
                const hex = await sha256Hex(repo.document);
                if (hex !== repo.sha256) {
                    failed += 1;
                    continue; // sha 不符：拒绝替换，旧版本保留
                }
                await putSource({
                    sourceId: id,
                    version: repo.version,
                    document: repo.document,
                    updatedAt: Date.now(),
                });
                applied += 1;
            }
            await resyncSources();
            await refreshSources();
            setNotice(
                failed > 0
                    ? { kind: "ok", text: `已更新 ${applied} 个，${failed} 个文件损坏已跳过` }
                    : { kind: "ok", text: `已更新 ${applied} 个漫画源` },
            );
        } catch (e) {
            setNotice({ kind: "err", text: `更新失败：${String(e)}` });
        } finally {
            setApplying(false);
        }
    }

    /** 手动导入：把粘贴的源文档写进已装源（结构由 Rust 侧校验，坏文档不替换已装版本）。
     * 与调试台的「安装这份文档」共用 installSourceDocument 这一条路径。 */
    async function importDocument() {
        setApplying(true);
        setNotice(null);
        try {
            const outcome = await installSourceDocument(importText);
            await refreshSources();
            if (!outcome.ok) {
                setNotice({
                    kind: "err",
                    text:
                        outcome.stage === "rejected"
                            ? `文档未通过校验：${outcome.reason}`
                            : `导入失败：${outcome.reason}`,
                });
            } else {
                setImportText("");
                setNotice({ kind: "ok", text: `已导入 ${outcome.title}` });
            }
        } catch (e) {
            setNotice({ kind: "err", text: `导入失败：${String(e)}` });
        } finally {
            setApplying(false);
        }
    }

    async function uninstallSource(id: string, title: string) {
        const ok = await confirm(`卸载「${title}」？已下载的内容不受影响。`, {
            title: "卸载漫画源",
            kind: "warning",
        });
        if (!ok) return;
        setApplying(true);
        setNotice(null);
        try {
            await removeSource(id);
            await resyncSources();
            await refreshSources();
            setNotice({ kind: "ok", text: `已卸载 ${title}` });
        } catch (e) {
            setNotice({ kind: "err", text: `卸载失败：${String(e)}` });
        } finally {
            setApplying(false);
        }
    }

    // ---------- WebDAV 备份/恢复（wayfinder #24/#25） ----------

    async function onWebdavChange(patch: Partial<typeof webdav>) {
        const next = { ...webdav, ...patch };
        setWebdav(next);
        await setSettings({ webdav: next });
        setSettingsState((s) => (s ? { ...s, webdav: next } : s));
    }

    async function backupNow() {
        setBacking(true);
        setNotice(null);
        try {
            if (!webdav.baseUrl || !webdav.user || !webdav.password) {
                throw new Error("请先填写地址、账号和密码");
            }
            const content = await exportBackupJson();
            const res = await webdavPut(
                webdav.baseUrl,
                webdav.user,
                webdav.password,
                BACKUP_FILE,
                content,
            );
            if (!res.success) throw new Error(`WebDAV 返回 HTTP ${res.status}`);
            setNotice({ kind: "ok", text: "已备份收藏、历史和进度" });
        } catch (e) {
            setNotice({ kind: "err", text: `备份失败：${String(e)}` });
        } finally {
            setBacking(false);
        }
    }

    async function restoreNow() {
        setRestoring(true);
        setNotice(null);
        try {
            if (!webdav.baseUrl || !webdav.user || !webdav.password) {
                throw new Error("请先填写地址、账号和密码");
            }
            const confirmed = await confirm(
                "恢复会覆盖本机现在的收藏、历史和进度",
                { title: "恢复备份", kind: "warning" },
            );
            if (!confirmed) return;
            const res = await webdavGet(
                webdav.baseUrl,
                webdav.user,
                webdav.password,
                BACKUP_FILE,
            );
            if (!res.ok) {
                throw new Error(
                    res.error
                        ? `WebDAV 读取失败：${res.error}`
                        : `WebDAV 返回 HTTP ${res.status}`,
                );
            }
            const data = parseBackupJson(res.content ?? "{}");
            await importBackupData(data);
            setNotice({ kind: "ok", text: "已恢复收藏、历史和进度" });
        } catch (e) {
            setNotice({ kind: "err", text: `恢复失败：${String(e)}` });
        } finally {
            setRestoring(false);
        }
    }

    // ---------- 自动更新（wayfinder #26/#27：设置页手动检查） ----------

    async function checkForUpdate() {
        setCheckingUpd(true);
        setNotice(null);
        try {
            const found = await checkUpdate();
            setUpdate(found);
            setDownloaded(false);
            setUpdProgress(null);
            if (found) {
                setNotice({ kind: "ok", text: `发现新版本 v${found.version}` });
            } else {
                setNotice({ kind: "ok", text: "已是最新版本" });
            }
        } catch (e) {
            setNotice({ kind: "err", text: `检查更新失败：${String(e)}` });
        } finally {
            setCheckingUpd(false);
        }
    }

    async function downloadUpdate() {
        if (!update) return;
        setDownloadingUpd(true);
        setNotice(null);
        try {
            await update.download((event) => {
                if (event.event === "Started") {
                    setUpdProgress({ done: 0, total: event.data.contentLength ?? 0 });
                } else if (event.event === "Progress") {
                    setUpdProgress((p) => ({
                        done: (p?.done ?? 0) + event.data.chunkLength,
                        total: p?.total ?? 0,
                    }));
                } else if (event.event === "Finished") {
                    setUpdProgress(null);
                }
            });
            setDownloaded(true);
            setNotice({ kind: "ok", text: "新版本已下载，点「重启并安装」生效" });
        } catch (e) {
            setNotice({ kind: "err", text: `下载新版本失败：${String(e)}` });
        } finally {
            setDownloadingUpd(false);
        }
    }

    async function installAndRelaunch() {
        if (!update) return;
        try {
            await update.install();
            await relaunch();
        } catch (e) {
            setNotice({ kind: "err", text: `安装失败：${String(e)}` });
        }
    }

    // ---------- Android OTA（移动端：更新通道 → 系统安装器） ----------

    async function otaCheckNow() {
        setOtaChecking(true);
        setNotice(null);
        setOtaVersion(null);
        setOtaReady(false);
        setOtaProgress(null);
        try {
            const found = await otaCheck();
            if (found.available) {
                setOtaVersion(found.version ?? null);
                setNotice({ kind: "ok", text: `发现新版本 v${found.version}` });
            } else {
                setNotice({ kind: "ok", text: "已是最新版本" });
            }
        } catch (e) {
            setNotice({ kind: "err", text: `检查更新失败：${String(e)}` });
        } finally {
            setOtaChecking(false);
        }
    }

    async function otaDownloadNow() {
        setOtaDownloading(true);
        setNotice(null);
        try {
            const channel = new Channel<OtaProgress>();
            channel.onmessage = (event) => {
                if (event.event === "started") {
                    setOtaProgress({ done: 0, total: event.total });
                } else if (event.event === "progress") {
                    setOtaProgress({ done: event.done, total: event.total });
                }
            };
            const apk = await otaDownload(channel);
            setOtaProgress(null);
            setOtaReady(true);
            setNotice({ kind: "ok", text: `v${apk.version} 已下载，点「安装」交给系统` });
        } catch (e) {
            setOtaProgress(null);
            setNotice({ kind: "err", text: `下载新版本失败：${String(e)}` });
        } finally {
            setOtaDownloading(false);
        }
    }

    async function otaInstallNow() {
        setNotice(null);
        try {
            // 没授权「安装未知应用」时先跳设置页：直接装只会拿到系统安装器的失败
            if (!(await otaCanInstall())) {
                await otaOpenInstallSettings();
                setNotice({
                    kind: "ok",
                    text: "请先允许本应用「安装未知应用」，再回来点安装",
                });
                return;
            }
            const result = await otaInstall();
            setNotice({
                kind: "ok",
                text:
                    result.status === "installed"
                        ? `已安装 v${result.version}，重启后生效`
                        : `v${result.version} 已交给系统安装，请在系统界面确认`,
            });
        } catch (e) {
            setNotice({ kind: "err", text: `安装失败：${String(e)}` });
        }
    }

    if (!settings) {
        return <Loading label="正在加载设置" />;
    }

    /** 已装源清单：以 Rust 侧注册表的顺序为准（内置的排最前），挂上本地存储里的版本与时间。
     * 顺序 = 内置 + 安装顺序；存储里多出来的（顺序表漏记）也一并列出。 */
    const installedIds = SOURCES.map((s) => s.id);
    for (const id of order) {
        if (!installedIds.includes(id) && sources[id]) installedIds.push(id);
    }
    for (const id of Object.keys(sources)) {
        if (!installedIds.includes(id)) installedIds.push(id);
    }
    const sourceList = installedIds.map((id) => ({
        id,
        title: sourceTitle(id),
        entry: sources[id] ?? null,
        builtin: BUILTIN_SOURCES.includes(id),
    }));
    /** 目录里可更新的源（已装且索引版本更高）。 */
    const updatable = catalog
        ? Object.entries(catalog.sources ?? {}).filter(
              ([id, repo]) => sources[id] && repo.version > sources[id].version,
          )
        : [];
    /** 目录里尚未安装的源。 */
    const installable = catalog
        ? Object.entries(catalog.sources ?? {}).filter(([id]) => !sources[id])
        : [];
    const busy = backing || restoring;

    return (
        <div className="mx-auto w-full max-w-3xl px-4 py-6 md:px-8">
            <PageHeader title="设置" sub="阅读、备份和更新" />

            {notice && (
                <div
                    role="status"
                    className={cn(
                        "mb-4 flex items-start gap-2.5 rounded-2xl border px-4 py-3 text-sm text-foreground",
                        notice.kind === "ok"
                            ? "border-success/30 bg-success/10"
                            : "border-destructive/30 bg-destructive/10",
                    )}
                >
                    {notice.kind === "ok" ? (
                        <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" />
                    ) : (
                        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
                    )}
                    <div className="min-w-0">{notice.text}</div>
                </div>
            )}

            <div className="flex flex-col gap-4">
                <Panel
                    title="常用"
                    desc="下载位置和阅读显示"
                    actions={<SlidersHorizontal className="size-4 text-muted-foreground" />}
                >
                    <SettingRow label="下载位置" hint="下载的漫画存在这里">
                        <span className="max-w-[16rem] truncate font-mono text-xs text-muted-foreground">
                            {settings.downloadDir}
                        </span>
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => void pickDir()}
                        >
                            <FolderOpen className="size-3.5" />
                            更改
                        </Button>
                    </SettingRow>
                    <SettingRow label="夜间模式" hint="背景变暗，晚上看着不刺眼">
                        <Switch
                            checked={isDark}
                            onCheckedChange={(v) => setDark(v)}
                            ariaLabel="夜间模式"
                        />
                    </SettingRow>
                    <SettingRow label="自动裁边" hint="页面稍微放大，去掉白边">
                        <Switch
                            checked={settings.autoTrim}
                            onCheckedChange={(v) => void toggleTrim(v)}
                            ariaLabel="自动裁边"
                        />
                    </SettingRow>
                    <SettingRow label="书架追更" hint="进入书架时自动检查收藏作品有没有新话">
                        <Switch
                            checked={settings.followUpdate}
                            onCheckedChange={(v) => void toggleFollow(v)}
                            ariaLabel="书架追更"
                        />
                    </SettingRow>
                </Panel>

                <Panel
                    title="WebDAV 备份"
                    desc="收藏、历史和进度存到你的网盘"
                    actions={<CloudUpload className="size-4 text-muted-foreground" />}
                >
                    <SettingRow label="地址">
                        <Input
                            className="w-[18rem]"
                            value={webdav.baseUrl}
                            placeholder="https://dav.example.com/dav/"
                            aria-label="WebDAV 地址"
                            onChange={(v) => void onWebdavChange({ baseUrl: v })}
                        />
                    </SettingRow>
                    <SettingRow label="账号">
                        <Input
                            className="w-[18rem]"
                            value={webdav.user}
                            aria-label="WebDAV 账号"
                            onChange={(v) => void onWebdavChange({ user: v })}
                        />
                    </SettingRow>
                    <SettingRow label="密码">
                        <Input
                            className="w-[18rem]"
                            type="password"
                            value={webdav.password}
                            aria-label="WebDAV 密码"
                            onChange={(v) => void onWebdavChange({ password: v })}
                        />
                    </SettingRow>
                    <SettingRow label="备份">
                        <Button
                            variant="primary"
                            size="sm"
                            onClick={() => void backupNow()}
                            disabled={busy}
                        >
                            <CloudUpload className="size-3.5" />
                            {backing ? "备份中…" : "立即备份"}
                        </Button>
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => void restoreNow()}
                            disabled={busy}
                        >
                            <CloudDownload className="size-3.5" />
                            {restoring ? "恢复中…" : "恢复备份"}
                        </Button>
                    </SettingRow>
                </Panel>

                <Panel
                    title="软件更新"
                    desc={
                        IS_ANDROID
                            ? "检查新版本，下载后交给系统安装"
                            : NO_INAPP_UPDATE
                              ? "本平台不能应用内更新，请到发布页下载新版本"
                              : "检查新版本，下载后重启安装"
                    }
                    actions={<Info className="size-4 text-muted-foreground" />}
                >
                    {IS_ANDROID ? (
                        <SettingRow label="版本">
                            <Button
                                variant="primary"
                                size="sm"
                                onClick={() => void otaCheckNow()}
                                disabled={otaChecking || otaDownloading}
                            >
                                <RefreshCw className="size-3.5" />
                                {otaChecking ? "检查中…" : "检查新版本"}
                            </Button>
                            {otaVersion && !otaReady && !otaDownloading && (
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => void otaDownloadNow()}
                                >
                                    下载 v{otaVersion}
                                </Button>
                            )}
                            {otaReady && (
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => void otaInstallNow()}
                                >
                                    安装
                                </Button>
                            )}
                            {otaProgress && (
                                <span className="text-xs tabular-nums text-muted-foreground">
                                    {otaProgress.total > 0
                                        ? `${Math.round(
                                              (otaProgress.done / otaProgress.total) * 100,
                                          )}%`
                                        : `${Math.round(
                                              otaProgress.done / 1024 / 1024,
                                          )} MB`}
                                </span>
                            )}
                        </SettingRow>
                    ) : NO_INAPP_UPDATE ? (
                        <SettingRow label={IS_IOS ? "iOS" : "macOS"}>
                            <span className="text-xs text-muted-foreground">
                                不能自动更新，请到发布页下载新版本
                            </span>
                        </SettingRow>
                    ) : (
                        <SettingRow label="版本">
                            <Button
                                variant="primary"
                                size="sm"
                                onClick={() => void checkForUpdate()}
                                disabled={checkingUpd || downloadingUpd}
                            >
                                <RefreshCw className="size-3.5" />
                                {checkingUpd ? "检查中…" : "检查新版本"}
                            </Button>
                            {update && !downloaded && !downloadingUpd && (
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => void downloadUpdate()}
                                >
                                    下载 v{update.version}
                                </Button>
                            )}
                            {downloaded && (
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => void installAndRelaunch()}
                                >
                                    重启并安装
                                </Button>
                            )}
                            {updProgress && updProgress.total > 0 && (
                                <span className="text-xs tabular-nums text-muted-foreground">
                                    {Math.round(
                                        (updProgress.done / updProgress.total) * 100,
                                    )}
                                    %
                                </span>
                            )}
                        </SettingRow>
                    )}
                </Panel>

                <Panel
                    title="漫画源"
                    desc="源文档由源仓库分发，也可手动导入"
                    actions={<ScrollText className="size-4 text-muted-foreground" />}
                >
                    <SettingRow label="源目录" hint="拉取源仓库索引，安装或更新源">
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => void loadCatalog()}
                            disabled={checking || applying}
                        >
                            <RefreshCw className="size-3.5" />
                            {checking ? "读取中…" : "读取源目录"}
                        </Button>
                        {updatable.length > 0 && (
                            <Button
                                variant="primary"
                                size="sm"
                                onClick={() => void applyUpdates()}
                                disabled={applying}
                            >
                                {applying ? "更新中…" : `全部更新（${updatable.length}）`}
                            </Button>
                        )}
                    </SettingRow>
                    {catalog && (
                        <SettingRow
                            label="可安装"
                            hint={
                                installable.length > 0
                                    ? "源目录里尚未安装的源"
                                    : "源目录里的源都已安装"
                            }
                        >
                            <div className="flex flex-wrap justify-end gap-2">
                                {installable.map(([id, repo]) => (
                                    <Button
                                        key={id}
                                        variant="secondary"
                                        size="sm"
                                        onClick={() => void installSource(id, repo)}
                                        disabled={applying}
                                    >
                                        {repo.name} v{repo.version}
                                    </Button>
                                ))}
                            </div>
                        </SettingRow>
                    )}
                    {sourceList.map(({ id, title, entry, builtin }) => {
                        const err = errors[id];
                        const status: AnimatedBadgeStatus = err ? "danger" : "neutral";
                        return (
                            <SettingRow
                                key={id}
                                label={title}
                                hint={
                                    err
                                        ? `上次出错：${errorFirstLine(err.message)}`
                                        : entry
                                          ? new Date(entry.updatedAt).toLocaleString()
                                          : "随应用内置"
                                }
                            >
                                <Tag>{entry ? `v${entry.version}` : "内置"}</Tag>
                                <AnimatedBadge
                                    status={status}
                                    size="sm"
                                    contentKey={err ? "err" : "ok"}
                                >
                                    {err ? "出错了" : "正常"}
                                </AnimatedBadge>
                                {!builtin && (
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => void uninstallSource(id, title)}
                                        disabled={applying}
                                    >
                                        卸载
                                    </Button>
                                )}
                            </SettingRow>
                        );
                    })}
                    <SettingRow
                        label="源调试台"
                        hint="写一份源文档，对真实站点跑一次，看每一步的请求与响应"
                    >
                        <LinkButton to="/debug" variant="secondary" size="sm">
                            <FlaskConical className="size-3.5" />
                            打开调试台
                        </LinkButton>
                    </SettingRow>
                    <SettingRow label="手动导入" hint="粘贴一份源文档（JSON）后导入">
                        <textarea
                            value={importText}
                            onChange={(e) => setImportText(e.target.value)}
                            spellCheck={false}
                            rows={4}
                            placeholder='{ "schema": 1, "id": "mysite", "title": "我的漫画", ... }'
                            className={cn(
                                "min-h-20 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs",
                                "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                            )}
                        />
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => void importDocument()}
                            disabled={applying || !importText.trim()}
                        >
                            导入
                        </Button>
                    </SettingRow>
                </Panel>

                <footer className="pb-2 text-center text-xs text-muted-foreground">
                    墨卷 · 版本{" "}
                    <code className="font-mono">{version || "…"}</code>
                    <span className="mx-1.5">·</span>
                    <a
                        href="https://deerflow.tech"
                        target="_blank"
                        rel="noreferrer"
                        className="underline underline-offset-2 hover:text-foreground"
                    >
                        Created by Deerflow
                    </a>
                </footer>
            </div>
        </div>
    );
}
