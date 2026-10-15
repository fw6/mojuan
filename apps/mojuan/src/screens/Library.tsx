import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import {
    ChevronDown,
    Clock,
    Download,
    Heart,
    History,
    RefreshCw,
    Trash2,
    TriangleAlert,
} from "lucide-react";
import {
    scanLocal,
    listDownloaded,
    readComicMeta,
    deleteDownloaded,
    imgSrc,
    FLAT_SOURCE,
    type Comic,
    type ComicMeta,
    type LocalComic,
    type DownloadedPage,
} from "../api";
import { getFavorites, removeFavorite } from "../lib/storage/favorites";
import { getHistory, removeHistory, type HistoryRecord } from "../lib/storage/history";
import {
    getFollowStates,
    removeFollowState,
    type FollowRecord,
} from "../lib/storage/follow";
import { getProgressAll, type ProgressRecord } from "../lib/storage/progress";
import { unreadCount } from "../lib/follow";
import { runFollowCheckNow, type FollowCheckFailure } from "../lib/follow-check";
import { usePageActive } from "../lib/page-active";
import { chapterLabel } from "../lib/chapters";
import { getSettings } from "../lib/storage/settings";
import { comicKey } from "../lib/storage/store";
import { cn } from "../lib/utils";
import { EASE_OUT, SPRING_PANEL } from "../lib/ease";
import { sourceTitle } from "../lib/sources";
import {
    ComicRow,
    Banner,
    Cover,
    EmptyState,
    Loading,
    PageHeader,
    Tag,
} from "../components/ui";
import { useToast } from "../components/toast";
import { Button } from "../components/beui/button";
import { Tabs, TabsList, TabsTrigger } from "../components/beui/tabs";
import { AnimatedBadge } from "../components/beui/animated-badge";
import {
    SwipeableList,
    type SwipeAction,
    type SwipeableListClassNames,
} from "../components/beui/swipeable-list";

type Tab = "history" | "favorites" | "downloads";

const TABS: { id: Tab; label: string; icon: typeof Clock }[] = [
    { id: "history", label: "历史", icon: History },
    { id: "favorites", label: "收藏", icon: Heart },
    { id: "downloads", label: "下载", icon: Download },
];

/** 横向滑动露出的一枚动作（三种列表共用）。 */
const DELETE_ACTION: SwipeAction = {
    id: "delete",
    label: "删除",
    icon: <Trash2 className="size-4" />,
    tone: "danger",
};

/** 行的卡片外观由行内容自己给（列表行 / 章节折叠块），滑动外壳只负责裁切与轨道底色。
 * 外壳铺 `card` 底而不是透明：行内容进场时会位移与淡入，透明的话轨道底色（`muted`）会从
 * 行底下透出来。 */
const SWIPE_CLASSNAMES: SwipeableListClassNames = {
    item: "rounded-lg",
    rail: "rounded-lg",
    surface: "min-h-0 rounded-lg border-0 bg-card p-0 shadow-none",
};

/** 指针移动多少像素之后，落下的那一次点击不再算点击。 */
const DRAG_SLOP = 6;

export default function Library() {
    const toast = useToast();
    const [tab, setTab] = useState<Tab>("history");
    const [history, setHistory] = useState<HistoryRecord[] | null>(null);
    const [favorites, setFavorites] = useState<Comic[] | null>(null);
    const [downloads, setDownloads] = useState<LocalComic[] | null>(null);
    const [downloadDir, setDownloadDir] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    // 追更：每部收藏的最近检查结果与阅读进度，角标由两者就地算出
    const [followStates, setFollowStates] = useState<Record<string, FollowRecord>>({});
    const [progressAll, setProgressAll] = useState<Record<string, ProgressRecord>>({});
    // 最近一次检查没成功的作品与原因，页头据此提示；展开后逐条列出
    const [failures, setFailures] = useState<FollowCheckFailure[]>([]);
    const [failuresOpen, setFailuresOpen] = useState(false);
    const active = usePageActive();

    const refresh = useCallback(async () => {
        setError(null);
        try {
            setHistory(await getHistory());
            setFavorites(await getFavorites());
            setFollowStates(await getFollowStates());
            setProgressAll(await getProgressAll());
            const s = await getSettings();
            setDownloadDir(s.downloadDir);
            setDownloads(s.downloadDir ? await scanLocal(s.downloadDir) : []);
        } catch (e) {
            setError(errorText(e));
            // 失败域按空数据渲染，页面结构与错误横幅一起给出，不留一个转不完的加载中
            setHistory((h) => h ?? []);
            setFavorites((f) => f ?? []);
            setDownloads((d) => d ?? []);
        }
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh, tab]);

    // 进入书架跑一次检查（保留页的挂载 effect 不会重跑，靠 active 感知「又被打开了」）。
    // 静默进行：不显示加载态，角标就地出现；失败作品保留上一次的角标，只在页头汇总。
    useEffect(() => {
        if (!active) return;
        let cancelled = false;
        void (async () => {
            try {
                const list = await getFavorites();
                // 先读回最新进度：读完最新一话回到书架，角标立刻归零，不等这次检查
                const progress = await getProgressAll();
                if (!cancelled) setProgressAll(progress);
                const result = await runFollowCheckNow(list);
                const states = await getFollowStates();
                if (cancelled) return;
                setFollowStates(states);
                // 被节流跳过的那一次返回空结果：保留上一次的失败提示，不误报「都成功了」。
                // 收藏非空却一部都没产出，只可能是没真正跑检查。
                if (list.length === 0 || result.updated.length > 0 || result.failures.length > 0) {
                    setFailures(result.failures);
                }
            } catch (e) {
                console.error("书架追更检查失败", e);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [active]);

    /** 手动刷新追更：不受节流限制，跑完就地刷新角标与失败提示。 */
    async function onRefreshFollow() {
        try {
            const list = await getFavorites();
            const result = await runFollowCheckNow(list, { manual: true });
            const [states, progress] = await Promise.all([getFollowStates(), getProgressAll()]);
            setFollowStates(states);
            setProgressAll(progress);
            setFailures(result.failures);
        } catch (e) {
            toast.show(`刷新追更失败：${errorText(e)}`, "error");
        }
    }

    async function onDeleteHistory(record: HistoryRecord) {
        const { source, id } = record.comic;
        try {
            await removeHistory(source, id);
            setHistory((list) => list?.filter((h) => !sameComic(h.comic, record.comic)) ?? list);
            toast.show("已删除这条历史", "success");
        } catch (e) {
            toast.show(`删除历史失败：${errorText(e)}`, "error");
        }
    }

    async function onDeleteFavorite(comic: Comic) {
        try {
            await removeFavorite(comic.source, comic.id);
            // 追更状态一并删掉：先取消再重新收藏不会捡回旧的基线
            await removeFollowState(comic.source, comic.id);
            setFavorites((list) => list?.filter((c) => !sameComic(c, comic)) ?? list);
            toast.show("已取消收藏", "success");
        } catch (e) {
            toast.show(`取消收藏失败：${errorText(e)}`, "error");
        }
    }

    async function onDeleteDownload(item: LocalComic) {
        if (!downloadDir) return;
        try {
            await deleteDownloaded(downloadDir, item.source, item.comicId);
            setDownloads((list) => list?.filter((d) => !sameLocal(d, item)) ?? list);
            toast.show("已删除下载", "success");
        } catch (e) {
            toast.show(`删除下载失败：${errorText(e)}`, "error");
        }
    }

    return (
        <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8">
            <PageHeader
                title="书架"
                sub="看过的、收藏的、下载的都在这里"
                actions={
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => void onRefreshFollow()}
                    >
                        <RefreshCw className="size-3.5" />
                        刷新追更
                    </Button>
                }
            />

            {error && <Banner>读取本地数据失败：{error}</Banner>}

            {failures.length > 0 && (
                <div className="mb-4 overflow-hidden rounded-2xl border border-destructive/25 bg-destructive/8">
                    <button
                        type="button"
                        onClick={() => setFailuresOpen((open) => !open)}
                        aria-expanded={failuresOpen}
                        className="flex w-full items-center gap-2.5 px-4 py-3 text-left text-sm text-foreground"
                    >
                        <TriangleAlert className="size-4 shrink-0 text-destructive" />
                        <span className="flex-1">{failures.length} 部未检查成功</span>
                        <motion.span
                            animate={{ rotate: failuresOpen ? 180 : 0 }}
                            transition={{ duration: 0.2, ease: EASE_OUT }}
                            className="block shrink-0 text-muted-foreground"
                        >
                            <ChevronDown className="size-4" />
                        </motion.span>
                    </button>
                    <AnimatePresence initial={false}>
                        {failuresOpen && (
                            <motion.div
                                key="failures"
                                initial={{ height: 0, opacity: 0 }}
                                animate={{ height: "auto", opacity: 1 }}
                                exit={{ height: 0, opacity: 0 }}
                                transition={{
                                    height: SPRING_PANEL,
                                    opacity: { duration: 0.16, ease: EASE_OUT },
                                }}
                                className="overflow-hidden"
                            >
                                <ul className="flex flex-col gap-2.5 border-t border-destructive/20 px-4 py-3">
                                    {failures.map((failure) => (
                                        <li
                                            key={comicKey(failure.source, failure.comicId)}
                                            className="min-w-0"
                                        >
                                            <div className="truncate text-sm text-foreground">
                                                {failure.title}
                                            </div>
                                            <div className="truncate text-xs text-muted-foreground">
                                                {failure.reason}
                                            </div>
                                        </li>
                                    ))}
                                </ul>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>
            )}

            <Tabs
                value={tab}
                onValueChange={(v) => setTab(v as Tab)}
                variant="segment"
                className="mb-5 w-full"
            >
                <TabsList className="bg-card">
                    {TABS.map((t) => {
                        const Icon = t.icon;
                        return (
                            <TabsTrigger key={t.id} value={t.id}>
                                <span className="flex items-center gap-1.5">
                                    <Icon className="size-3.5" />
                                    {t.label}
                                </span>
                            </TabsTrigger>
                        );
                    })}
                </TabsList>
            </Tabs>

            {tab === "history" &&
                (history === null ? (
                    <Loading label="正在加载历史" />
                ) : history.length === 0 ? (
                    <EmptyState
                        icon={<History className="size-7" />}
                        text="还没有看过漫画"
                        hint="去「发现」挑一部开始看，进度会自动记下"
                    />
                ) : (
                    <SwipeableList
                        items={history.map((h) => ({
                            id: comicKey(h.comic.source, h.comic.id),
                            content: (
                                <SwipeRow>
                                    <ComicRow
                                        to={`/comic/${h.comic.source}/${encodeURIComponent(h.comic.id)}`}
                                        cover={h.comic.cover}
                                        title={h.comic.title}
                                        subtitle={h.comic.author || sourceTitle(h.comic.source)}
                                        meta={`读到 ${chapterLabel(h.chapterTitle, h.chapterIndex)}`}
                                        badge={
                                            <AnimatedBadge status="info" size="sm">
                                                <span className="block max-w-32 truncate">
                                                    {chapterLabel(h.chapterTitle, h.chapterIndex)}
                                                </span>
                                            </AnimatedBadge>
                                        }
                                    />
                                </SwipeRow>
                            ),
                            rightActions: [DELETE_ACTION],
                        }))}
                        classNames={SWIPE_CLASSNAMES}
                        onAction={({ item }) => {
                            const record = history.find(
                                (h) => comicKey(h.comic.source, h.comic.id) === item.id,
                            );
                            if (record) void onDeleteHistory(record);
                        }}
                    />
                ))}

            {tab === "favorites" &&
                (favorites === null ? (
                    <Loading label="正在加载收藏" />
                ) : favorites.length === 0 ? (
                    <EmptyState
                        icon={<Heart className="size-7" />}
                        text="还没有收藏"
                        hint="在作品页点「收藏」，就会出现在这里"
                    />
                ) : (
                    <SwipeableList
                        items={favorites.map((c) => {
                            const key = comicKey(c.source, c.id);
                            const count = unreadCount(
                                followStates[key] ?? null,
                                progressAll[key] ?? null,
                            );
                            return {
                                id: key,
                                content: (
                                    <SwipeRow>
                                        <ComicRow
                                            to={`/comic/${c.source}/${encodeURIComponent(c.id)}`}
                                            cover={c.cover}
                                            title={c.title}
                                            subtitle={c.author || sourceTitle(c.source)}
                                            badge={
                                                count > 0 ? (
                                                    <AnimatedBadge
                                                        status="info"
                                                        size="sm"
                                                        showIcon={false}
                                                    >
                                                        {count > 99 ? "99+" : count}
                                                    </AnimatedBadge>
                                                ) : undefined
                                            }
                                        />
                                    </SwipeRow>
                                ),
                                rightActions: [DELETE_ACTION],
                            };
                        })}
                        classNames={SWIPE_CLASSNAMES}
                        onAction={({ item }) => {
                            const comic = favorites.find(
                                (c) => comicKey(c.source, c.id) === item.id,
                            );
                            if (comic) void onDeleteFavorite(comic);
                        }}
                    />
                ))}

            {tab === "downloads" &&
                (downloadDir === null ? (
                    <EmptyState
                        icon={<Download className="size-7" />}
                        text="还没有设置下载位置"
                        hint="到「设置」里选一个文件夹存下载"
                    />
                ) : downloads === null ? (
                    <Loading label="正在扫描下载目录" />
                ) : downloads.length === 0 ? (
                    <EmptyState
                        icon={<Download className="size-7" />}
                        text="还没有下载的漫画"
                        hint="在作品页选中章节下载，没网也能看"
                    />
                ) : (
                    <DirList
                        dir={downloadDir}
                        items={downloads}
                        onDelete={(item) => void onDeleteDownload(item)}
                    />
                ))}
        </div>
    );
}

/** 命令失败时的可读文案（Tauri 的 Err 是字符串，JS 侧异常是 Error）。 */
function errorText(e: unknown): string {
    if (typeof e === "string" && e) return e;
    if (e instanceof Error && e.message) return e.message;
    return "未知错误";
}

function sameComic(a: Comic, b: Comic): boolean {
    return a.source === b.source && a.id === b.id;
}

function sameLocal(a: LocalComic, b: LocalComic): boolean {
    return a.source === b.source && a.comicId === b.comicId;
}

function localKey(item: LocalComic): string {
    return comicKey(item.source, item.comicId);
}

/**
 * 滑动行的内容外壳：横向拖动之后落下的那一次点击不算点击。
 * 行里是可导航的链接与可展开的按钮，而 motion 的拖动不会吞掉随后的 click 事件，
 * 「拖了一下但没拉开」于是会变成一次误触的跳转或展开。
 */
function SwipeRow({ children }: { children: ReactNode }) {
    const moved = useRef(false);
    const origin = useRef<{ x: number; y: number } | null>(null);
    return (
        <div
            onPointerDownCapture={(e) => {
                origin.current = { x: e.clientX, y: e.clientY };
                moved.current = false;
            }}
            onPointerMoveCapture={(e) => {
                const from = origin.current;
                if (from && Math.hypot(e.clientX - from.x, e.clientY - from.y) > DRAG_SLOP) {
                    moved.current = true;
                }
            }}
            onClickCapture={(e) => {
                if (!moved.current) return;
                e.preventDefault();
                e.stopPropagation();
                moved.current = false;
            }}
        >
            {children}
        </div>
    );
}

/**
 * 下载漫画列表（wayfinder #19）：点漫画就地展开章节，点章节进本地阅读器，左滑露出删除。
 * 卡片显示的是下载时记进作品目录的标题与封面（`comic.json`）；旧下载没有这份元数据，
 * 回落到 comicId 与占位封面。
 */
function DirList({
    dir,
    items,
    onDelete,
}: {
    dir: string;
    items: LocalComic[];
    onDelete: (item: LocalComic) => void;
}) {
    const toast = useToast();
    const [expanded, setExpanded] = useState<string | null>(null);
    const [chapters, setChapters] = useState<
        Record<string, Record<string, DownloadedPage[]>>
    >({});
    const [metas, setMetas] = useState<Record<string, ComicMeta | null>>({});

    async function toggle(key: string, item: LocalComic) {
        if (expanded === key) {
            setExpanded(null);
            return;
        }
        setExpanded(key);
        if (chapters[key]) return;
        try {
            const [listed, meta] = await Promise.all([
                listDownloaded(dir, item.source, item.comicId),
                // 作品元数据缺失或读取失败只影响话名，章节表照常显示
                readComicMeta(dir, item.source, item.comicId).catch(() => null),
            ]);
            setChapters((c) => ({ ...c, [key]: listed }));
            setMetas((m) => ({ ...m, [key]: meta }));
        } catch (e) {
            toast.show(`读取章节失败：${errorText(e)}`, "error");
        }
    }

    /** 一部作品的折叠块（组头 + 展开后的章节），两种列表形态共用同一份。 */
    function accordion(d: LocalComic) {
        const key = localKey(d);
        const chs = chapters[key];
        const meta = metas[key];
        const isOpen = expanded === key;
        // 扁平布局的旧下载 source 是 "local"，没有在线作品页可进
        const detailTo =
            d.source === FLAT_SOURCE
                ? null
                : `/comic/${d.source}/${encodeURIComponent(d.comicId)}`;
        const summary = (
            <>
                <Cover
                    src={d.cover ? imgSrc(d.cover, { source: d.source, comicId: d.comicId }) : ""}
                    alt={d.title || d.comicId}
                    className="w-12 shrink-0"
                />
                <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-foreground">
                        {d.title || d.comicId}
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                        <Tag>{sourceTitle(d.source)}</Tag>
                        <span>{d.chapterCount} 话</span>
                    </div>
                </div>
            </>
        );
        const summaryClass =
            "flex min-w-0 flex-1 items-center gap-3 rounded-md text-left transition-colors hover:bg-secondary/50";
        return (
            <div
                key={key}
                className={cn(
                    "overflow-hidden rounded-lg border bg-card transition-colors",
                    isOpen ? "border-primary/40" : "border-border",
                )}
            >
                <div className="flex items-center gap-3 p-3.5">
                    {detailTo ? (
                        <Link to={detailTo} className={summaryClass}>
                            {summary}
                        </Link>
                    ) : (
                        <button
                            type="button"
                            onClick={() => void toggle(key, d)}
                            aria-expanded={isOpen}
                            className={summaryClass}
                        >
                            {summary}
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={() => void toggle(key, d)}
                        aria-expanded={isOpen}
                        aria-label={isOpen ? "收起章节" : "展开章节"}
                        className="shrink-0 rounded-md p-2.5 text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground"
                    >
                        <motion.span
                            animate={{ rotate: isOpen ? 180 : 0 }}
                            transition={{ duration: 0.2, ease: EASE_OUT }}
                            className="block"
                        >
                            <ChevronDown className="size-4" />
                        </motion.span>
                    </button>
                </div>
                <AnimatePresence initial={false}>
                    {isOpen && (
                        <motion.div
                            key="content"
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: "auto", opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{
                                height: SPRING_PANEL,
                                opacity: { duration: 0.16, ease: EASE_OUT },
                            }}
                            className="overflow-hidden"
                        >
                            <div className="flex flex-col gap-0.5 px-2.5 pb-2.5">
                                {chs === undefined ? (
                                    <span className="px-2 py-2 text-xs text-muted-foreground">
                                        正在加载章节…
                                    </span>
                                ) : (
                                    Object.entries(chs).map(([idx, pages]) => (
                                        <Link
                                            key={idx}
                                            to={`/local/${d.source}/${encodeURIComponent(d.comicId)}/${idx}`}
                                            className="flex items-center justify-between rounded-xl px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                                        >
                                            <span className="truncate">
                                                {chapterLabel(meta?.chapters[idx], Number(idx))}
                                            </span>
                                            <span className="shrink-0 text-xs">
                                                {pages.length} 页
                                            </span>
                                        </Link>
                                    ))
                                )}
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
        );
    }

    return (
        <SwipeableList
            items={items.map((d) => ({
                id: localKey(d),
                content: <SwipeRow>{accordion(d)}</SwipeRow>,
                rightActions: [DELETE_ACTION],
            }))}
            classNames={SWIPE_CLASSNAMES}
            onAction={({ item }) => {
                const target = items.find((d) => localKey(d) === item.id);
                if (target) onDelete(target);
            }}
        />
    );
}
