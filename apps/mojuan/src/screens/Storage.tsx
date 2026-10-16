import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, Download, HardDrive } from "lucide-react";
import { confirm } from "@tauri-apps/plugin-dialog";
import {
    checkDownload,
    deleteDownloaded,
    downloadComics,
    imgSrc,
    readComicMeta,
    type ChapterCheck,
    type ComicMeta,
    type DownloadCheck,
    type DownloadComic,
} from "../api";
import { getSettings } from "../lib/storage/settings";
import { sourceTitle } from "../lib/sources";
import { usePageActive } from "../lib/page-active";
import { chapterLabel } from "../lib/chapters";
import { cn, formatBytes } from "../lib/utils";
import {
    Banner,
    Cover,
    EmptyState,
    Loading,
    PageHeader,
    Panel,
    Tag,
} from "../components/ui";
import { Button } from "../components/beui/button";
import {
    AnimatedBadge,
    type AnimatedBadgeStatus,
} from "../components/beui/animated-badge";
import { StorageOverview } from "../components/storage-overview";

/**
 * 整屏存储页：顶部是三项占用与缓存控制（与设置页的「存储」段同一份数据，共用
 * `StorageOverview`），下面是下载管理——按占用从大到小列出已下载作品，可勾选批量删除。
 * 入口在设置页的存储段；本页 `keep: 0`（离开即卸载），侧边栏不出现。
 */
export default function Storage() {
    return (
        <div className="mx-auto w-full max-w-3xl px-4 py-6 md:px-8">
            <PageHeader title="存储" sub="缓存与下载占用" />
            <StoragePanels />
        </div>
    );
}

/** 一部作品的选中键（source 与 comicId 一起才唯一）。 */
function comicKey(item: DownloadComic): string {
    return `${item.source}:${item.comicId}`;
}

/** 命令失败时的可读文案（Tauri 的 Err 是字符串，JS 侧异常是 Error）。 */
function errorText(e: unknown): string {
    if (typeof e === "string" && e) return e;
    if (e instanceof Error && e.message) return e.message;
    return "未知错误";
}

/**
 * 占用面板与下载面板同处一层：删除之后两块都要重新统计，所以下载面板持有一个版本号，
 * 占用面板按它重取（它自己也按 `usePageActive` 在页面再次打开时重取）。
 */
function StoragePanels() {
    const [usageVersion, setUsageVersion] = useState(0);
    return (
        <>
            <Panel
                title="占用与缓存"
                desc="图片缓存、结果缓存与下载各占多少空间"
                actions={<HardDrive className="size-4 text-muted-foreground" />}
            >
                <StorageOverview refreshKey={usageVersion} />
            </Panel>
            <DownloadPanel onChanged={() => setUsageVersion((v) => v + 1)} />
        </>
    );
}

/**
 * 下载管理：按占用从大到小列出已下载作品，选择模式下可勾选批量删除。
 * 删除复用整部删除命令（它先停下该作品在下载队列里的任务、等正在写的那一页写完再删目录）。
 */
function DownloadPanel({ onChanged }: { onChanged: () => void }) {
    // dir 为 null 表示设置还没读到；空串表示用户没有设置下载位置
    const [dir, setDir] = useState<string | null>(null);
    const [items, setItems] = useState<DownloadComic[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [selecting, setSelecting] = useState(false);
    const [selected, setSelected] = useState<string[]>([]);
    const [deleting, setDeleting] = useState(false);
    const active = usePageActive();

    const load = useCallback(async () => {
        try {
            const s = await getSettings();
            const downloadDir = s.downloadDir ?? "";
            setDir(downloadDir);
            setItems(downloadDir ? await downloadComics(downloadDir) : []);
            setError(null);
        } catch (e) {
            setError(errorText(e));
        }
    }, []);

    useEffect(() => {
        if (!active) return;
        void load();
    }, [active, load]);

    // 占用从大到小（同占用时按 key 定序，两次统计之间列表不会跳）
    const sorted = useMemo(
        () =>
            [...(items ?? [])].sort(
                (a, b) => b.bytes - a.bytes || comicKey(a).localeCompare(comicKey(b)),
            ),
        [items],
    );

    const selectedItems = sorted.filter((item) => selected.includes(comicKey(item)));
    const selectedBytes = selectedItems.reduce((total, item) => total + item.bytes, 0);
    const allSelected = sorted.length > 0 && selectedItems.length === sorted.length;

    function toggle(key: string) {
        setSelected((keys) =>
            keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key],
        );
    }

    /** 退出选择模式：选中一并清空，下次进来是干净状态。 */
    function exitSelection() {
        setSelecting(false);
        setSelected([]);
    }

    async function onDeleteSelected() {
        if (!dir || selectedItems.length === 0) return;
        const ok = await confirm(
            `删除所选 ${selectedItems.length} 部作品？将释放 ${formatBytes(selectedBytes)}，删除后需要重新下载。`,
            { title: "删除下载", kind: "warning" },
        );
        if (!ok) return;
        setDeleting(true);
        setError(null);
        let failure: string | null = null;
        try {
            for (const item of selectedItems) {
                await deleteDownloaded(dir, item.source, item.comicId);
            }
            exitSelection();
        } catch (e) {
            // 失败前可能已经删掉了一部分，选中留着让人重试
            failure = errorText(e);
        }
        // 无论成功与否都重新统计：磁盘已经变了
        await load();
        onChanged();
        setDeleting(false);
        if (failure !== null) setError(failure);
    }

    /** 面板右侧的动作区：平时是一枚「选择」，选择模式下换成整条操作栏。 */
    const actions = selecting ? (
        <>
            <span className="text-xs tabular-nums text-muted-foreground">
                已选 {selectedItems.length} 部 · 合计 {formatBytes(selectedBytes)}
            </span>
            <Button
                variant="secondary"
                size="sm"
                onClick={() => setSelected(allSelected ? [] : sorted.map(comicKey))}
            >
                {allSelected ? "取消全选" : "全选"}
            </Button>
            <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => void onDeleteSelected()}
                disabled={selectedItems.length === 0 || deleting}
            >
                删除所选
            </Button>
            <Button variant="ghost" size="sm" onClick={exitSelection}>
                取消
            </Button>
        </>
    ) : (
        <Button variant="secondary" size="sm" onClick={() => setSelecting(true)}>
            选择
        </Button>
    );

    const body = (() => {
        // 统计失败时列表还没落地：只给错误横幅，不假装「没有下载」
        if (dir === null || items === null) {
            return error ? (
                <Banner>读取下载列表失败：{error}</Banner>
            ) : (
                <Loading label="正在统计下载占用" />
            );
        }
        if (dir === "") {
            return (
                <EmptyState
                    icon={<Download className="size-7" />}
                    text="还没有设置下载位置"
                    hint="到「设置」里选一个文件夹存下载"
                />
            );
        }
        return (
            <>
                {error && <Banner>删除下载失败：{error}</Banner>}
                {sorted.length === 0 ? (
                    <EmptyState
                        icon={<Download className="size-7" />}
                        text="还没有下载的漫画"
                        hint="在作品页选中章节下载，没网也能看"
                    />
                ) : (
                    <div className="flex flex-col gap-2">
                        {sorted.map((item) => (
                            <DownloadRow
                                key={comicKey(item)}
                                item={item}
                                dir={dir}
                                selecting={selecting}
                                checked={selected.includes(comicKey(item))}
                                onToggle={() => toggle(comicKey(item))}
                            />
                        ))}
                    </div>
                )}
            </>
        );
    })();

    return (
        <Panel
            title="下载"
            desc="已下载的作品，按占用从大到小"
            actions={actions}
            className="mt-4"
        >
            {body}
        </Panel>
    );
}

/** 一部作品一行：封面、标题、源与话数、占用。选择模式下整行点击切换选中；
 * 非选择模式下整行点击就地展开这一部作品的完整性检查。 */
function DownloadRow({
    item,
    dir,
    selecting,
    checked,
    onToggle,
}: {
    item: DownloadComic;
    dir: string;
    selecting: boolean;
    checked: boolean;
    onToggle: () => void;
}) {
    const [expanded, setExpanded] = useState(false);
    const content = (
        <>
            <Cover
                src={
                    item.cover
                        ? imgSrc(item.cover, { source: item.source, comicId: item.comicId })
                        : ""
                }
                alt={item.title || item.comicId}
                className="w-12 shrink-0"
            />
            <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-foreground">
                    {item.title || item.comicId}
                </div>
                <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                    <Tag>{sourceTitle(item.source)}</Tag>
                    <span className="tabular-nums">{item.chapters} 话</span>
                </div>
            </div>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {formatBytes(item.bytes)}
            </span>
        </>
    );

    // 选择模式是删除用的：不展开、不显示检查入口
    if (selecting) {
        // label 包住整行：点行的任何位置都切换这一行的勾选框
        return (
            <label className="flex cursor-pointer items-center gap-3 rounded-lg border bg-card p-3.5 transition-colors hover:bg-secondary/50">
                <input
                    type="checkbox"
                    checked={checked}
                    onChange={onToggle}
                    aria-label={`选择 ${item.title || item.comicId}`}
                    className="size-4 shrink-0 accent-primary"
                />
                {content}
            </label>
        );
    }
    return (
        <div className="rounded-lg border bg-card">
            <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                aria-label={`${expanded ? "收起" : "展开"}检查结果：${item.title || item.comicId}`}
                className="flex w-full items-center gap-3 p-3.5 text-left transition-colors hover:bg-secondary/50"
            >
                {content}
                <ChevronDown
                    className={cn(
                        "size-4 shrink-0 text-muted-foreground transition-transform",
                        expanded && "rotate-180",
                    )}
                />
            </button>
            {expanded && <CheckPanel dir={dir} item={item} />}
        </div>
    );
}

/** 页号很多时只列前几个（命令面的页号是 0 基，显示时加 1）。 */
const MAX_LISTED_PAGES = 5;

/** 一话的徽标：缺页与损坏都走危险色，未核对走中性的次级文字色。 */
function chapterBadge(check: ChapterCheck): {
    status: AnimatedBadgeStatus;
    className: string;
    label: string;
} {
    if (check.missing.length > 0) {
        return { status: "danger", className: "", label: `缺 ${check.missing.length} 页` };
    }
    if (check.broken.length > 0) {
        return { status: "danger", className: "", label: `损坏 ${check.broken.length} 个` };
    }
    if (!check.manifest) {
        return { status: "neutral", className: "", label: "未核对" };
    }
    // 浅色主题下用本仓库的语义色（beui 原生的 emerald 偏亮）
    return { status: "success", className: "text-success", label: "正常" };
}

/** 页号小字：「缺第 13、14 页」，页号多时只列前几个并补上总数。 */
function pageListText(prefix: string, pages: number[]): string {
    const listed = pages
        .slice(0, MAX_LISTED_PAGES)
        .map((page) => page + 1)
        .join("、");
    return pages.length > MAX_LISTED_PAGES
        ? `${prefix}第 ${listed} 页 等 ${pages.length} 页`
        : `${prefix}第 ${listed} 页`;
}

/** 一话的页号小字：缺失与损坏各一段，都有时并排。 */
function pageDetail(check: ChapterCheck): string {
    const parts: string[] = [];
    if (check.missing.length > 0) parts.push(pageListText("缺", check.missing));
    if (check.broken.length > 0) parts.push(pageListText("损坏", check.broken));
    return parts.join(" · ");
}

/** 展开区：挂载即跑一次检查（展开就是要看结果），顶部是汇总与「重新检查」。 */
function CheckPanel({ dir, item }: { dir: string; item: DownloadComic }) {
    const [report, setReport] = useState<DownloadCheck | null>(null);
    const [checking, setChecking] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [meta, setMeta] = useState<ComicMeta | null>(null);

    const run = useCallback(async () => {
        setChecking(true);
        setError(null);
        try {
            setReport(await checkDownload(dir, item.source, item.comicId));
        } catch (e) {
            setError(errorText(e));
        } finally {
            setChecking(false);
        }
    }, [dir, item.source, item.comicId]);

    useEffect(() => {
        void run();
    }, [run]);

    // 话名取自作品元数据；取不到（旧下载没有 comic.json）回落到话序号
    useEffect(() => {
        let live = true;
        void readComicMeta(dir, item.source, item.comicId).then(
            (m) => {
                if (live) setMeta(m);
            },
            () => {
                if (live) setMeta(null);
            },
        );
        return () => {
            live = false;
        };
    }, [dir, item.source, item.comicId]);

    return (
        <div className="border-t border-border px-3.5 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs tabular-nums text-muted-foreground">
                    {report && !checking
                        ? `${report.chapters.length} 话 · 缺 ${report.missingPages} 页 · 损坏 ${report.brokenFiles} 个`
                        : "正在检查…"}
                </span>
                <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void run()}
                    disabled={checking}
                >
                    {checking ? "检查中…" : "重新检查"}
                </Button>
            </div>
            {checking ? (
                <Loading label="正在检查完整性" />
            ) : error ? (
                <p className="mt-2 text-xs text-destructive">检查失败：{error}</p>
            ) : report ? (
                <>
                    {report.unchecked > 0 && (
                        <p className="mt-1 text-xs text-muted-foreground">
                            {`其中 ${report.unchecked} 话没有页清单，只核对了已有的页`}
                        </p>
                    )}
                    <div className="mt-2">
                        {report.chapters.map((check) => (
                            <ChapterCheckRow
                                key={check.chapterIndex}
                                check={check}
                                title={meta?.chapters[String(check.chapterIndex)]}
                            />
                        ))}
                    </div>
                </>
            ) : null}
        </div>
    );
}

/** 一话一行：左侧话名（下面补页号小字），右侧状态徽标。 */
function ChapterCheckRow({ check, title }: { check: ChapterCheck; title?: string }) {
    const badge = chapterBadge(check);
    const detail = pageDetail(check);
    return (
        <div className="flex items-start justify-between gap-3 border-t border-border py-2 first:border-t-0">
            <div className="min-w-0">
                <div className="truncate text-xs font-medium text-foreground">
                    {chapterLabel(title, check.chapterIndex)}
                </div>
                {detail && (
                    <div className="mt-0.5 text-[11px] tabular-nums text-muted-foreground">
                        {detail}
                    </div>
                )}
            </div>
            <AnimatedBadge
                status={badge.status}
                size="sm"
                className={badge.className}
                contentKey={badge.label}
            >
                {badge.label}
            </AnimatedBadge>
        </div>
    );
}
