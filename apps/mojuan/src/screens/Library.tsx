import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { AnimatePresence, motion } from "motion/react";
import {
    ChevronDown,
    Clock,
    Download,
    FolderOpen,
    HardDrive,
    Heart,
    History,
} from "lucide-react";
import {
    scanLocal,
    listDownloaded,
    type Comic,
    type LocalComic,
    type DownloadedPage,
} from "../api";
import { getFavorites } from "../lib/storage/favorites";
import { getHistory, type HistoryRecord } from "../lib/storage/history";
import { getSettings } from "../lib/storage/settings";
import { comicKey } from "../lib/storage/store";
import { cn } from "../lib/utils";
import { EASE_OUT, SPRING_PANEL } from "../lib/ease";
import { sourceTitle } from "../lib/sources";
import { ComicRow, Banner, EmptyState, Loading, PageHeader, Tag } from "../components/ui";
import { useToast } from "../components/toast";
import { Button } from "../components/beui/button";
import { Tabs, TabsList, TabsTrigger } from "../components/beui/tabs";
import { AnimatedBadge } from "../components/beui/animated-badge";

type Tab = "history" | "favorites" | "downloads" | "local";

const TABS: { id: Tab; label: string; icon: typeof Clock }[] = [
    { id: "history", label: "历史", icon: History },
    { id: "favorites", label: "收藏", icon: Heart },
    { id: "downloads", label: "下载", icon: Download },
    { id: "local", label: "本地文件", icon: FolderOpen },
];

export default function Library() {
    const toast = useToast();
    const [tab, setTab] = useState<Tab>("history");
    const [history, setHistory] = useState<HistoryRecord[] | null>(null);
    const [favorites, setFavorites] = useState<Comic[] | null>(null);
    const [downloads, setDownloads] = useState<LocalComic[] | null>(null);
    const [local, setLocal] = useState<LocalComic[]>([]);
    const [downloadDir, setDownloadDir] = useState<string | null>(null);
    const [lastScanDir, setLastScanDir] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        setError(null);
        try {
            setHistory(await getHistory());
            setFavorites(await getFavorites());
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

    async function pickLocalDir() {
        try {
            const dir = await open({ directory: true });
            if (typeof dir !== "string") return;
            setLastScanDir(dir);
            setLocal(await scanLocal(dir));
        } catch (e) {
            toast.show(`扫描文件夹失败：${errorText(e)}`, "error");
        }
    }

    return (
        <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8">
            <PageHeader title="书架" sub="看过的、收藏的、下载的都在这里" />

            {error && <Banner>读取本地数据失败：{error}</Banner>}

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
                    <div className="flex flex-col gap-2">
                        {history.map((h) => (
                            <ComicRow
                                key={comicKey(h.comic.source, h.comic.id)}
                                to={`/comic/${h.comic.source}/${encodeURIComponent(h.comic.id)}`}
                                cover={h.comic.cover}
                                title={h.comic.title}
                                subtitle={h.comic.author || sourceTitle(h.comic.source)}
                                meta={`读到第 ${h.chapterIndex} 话`}
                                badge={
                                    <AnimatedBadge status="info" size="sm">
                                        第 {h.chapterIndex} 话
                                    </AnimatedBadge>
                                }
                            />
                        ))}
                    </div>
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
                    <div className="flex flex-col gap-2">
                        {favorites.map((c) => (
                            <ComicRow
                                key={comicKey(c.source, c.id)}
                                to={`/comic/${c.source}/${encodeURIComponent(c.id)}`}
                                cover={c.cover}
                                title={c.title}
                                subtitle={c.author || sourceTitle(c.source)}
                            />
                        ))}
                    </div>
                ))}

            {tab === "downloads" &&
                (downloadDir === null ? (
                    <EmptyState
                        icon={<Download className="size-7" />}
                        text="还没有设置下载位置"
                        hint="到「设置」里选一个文件夹存下载"
                    />
                ) : downloads === null ? (
                    <Loading label="正在扫描文件夹" />
                ) : downloads.length === 0 ? (
                    <EmptyState
                        icon={<Download className="size-7" />}
                        text="还没有下载的漫画"
                        hint="在作品页选中章节下载，没网也能看"
                    />
                ) : (
                    <DirList dir={downloadDir} items={downloads} />
                ))}

            {tab === "local" && (
                <div>
                    <div className="mb-4 flex flex-wrap items-center gap-3">
                        <Button
                            variant="secondary"
                            size="md"
                            onClick={() => void pickLocalDir()}
                        >
                            <FolderOpen className="size-4" />
                            {lastScanDir ? "更换文件夹" : "选择文件夹"}
                        </Button>
                        {lastScanDir && (
                            <span className="truncate font-mono text-xs text-muted-foreground">
                                {lastScanDir}
                            </span>
                        )}
                    </div>
                    {local.length === 0 ? (
                        <EmptyState
                            icon={<HardDrive className="size-7" />}
                            text={
                                lastScanDir
                                    ? "这个文件夹里没有漫画"
                                    : "选一个存着漫画的文件夹"
                            }
                            hint="会读取里面的漫画和章节"
                        />
                    ) : (
                        <DirList dir={lastScanDir!} items={local} />
                    )}
                </div>
            )}
        </div>
    );
}

/** 命令失败时的可读文案（Tauri 的 Err 是字符串，JS 侧异常是 Error）。 */
function errorText(e: unknown): string {
    if (typeof e === "string" && e) return e;
    if (e instanceof Error && e.message) return e.message;
    return "未知错误";
}

/** 下载/本地漫画列表（wayfinder #19）：点漫画就地展开章节，点章节进本地阅读器。 */
function DirList({ dir, items }: { dir: string; items: LocalComic[] }) {
    const toast = useToast();
    const [expanded, setExpanded] = useState<string | null>(null);
    const [chapters, setChapters] = useState<
        Record<string, Record<string, DownloadedPage[]>>
    >({});

    async function toggle(key: string, item: LocalComic) {
        if (expanded === key) {
            setExpanded(null);
            return;
        }
        setExpanded(key);
        if (!chapters[key]) {
            try {
                const listed = await listDownloaded(dir, item.source, item.comicId);
                setChapters((c) => ({ ...c, [key]: listed }));
            } catch (e) {
                toast.show(`读取章节失败：${errorText(e)}`, "error");
            }
        }
    }

    return (
        <div className="flex flex-col gap-2">
            {items.map((d) => {
                const key = `${d.source}:${d.comicId}`;
                const chs = chapters[key];
                const isOpen = expanded === key;
                return (
                    <div
                        key={key}
                        className={cn(
                            "overflow-hidden rounded-lg border bg-card transition-colors",
                            isOpen ? "border-primary/40" : "border-border",
                        )}
                    >
                        <button
                            type="button"
                            onClick={() => void toggle(key, d)}
                            aria-expanded={isOpen}
                            className="flex w-full items-center justify-between gap-3 p-3.5 text-left transition-colors hover:bg-secondary/50"
                        >
                            <div className="min-w-0">
                                <div className="truncate text-sm font-medium text-foreground">
                                    {d.comicId}
                                </div>
                                <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                                    <Tag>{sourceTitle(d.source)}</Tag>
                                    <span>{d.chapterCount} 话</span>
                                </div>
                            </div>
                            <motion.span
                                animate={{ rotate: isOpen ? 180 : 0 }}
                                transition={{ duration: 0.2, ease: EASE_OUT }}
                                className="text-muted-foreground"
                            >
                                <ChevronDown className="size-4" />
                            </motion.span>
                        </button>
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
                                            Object.entries(chs).map(
                                                ([idx, pages]) => (
                                                    <Link
                                                        key={idx}
                                                        to={`/local/${d.source}/${encodeURIComponent(d.comicId)}/${idx}`}
                                                        className="flex items-center justify-between rounded-xl px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                                                    >
                                                        <span>第 {idx} 话</span>
                                                        <span className="text-xs">
                                                            {pages.length} 页
                                                        </span>
                                                    </Link>
                                                ),
                                            )
                                        )}
                                    </div>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>
                );
            })}
        </div>
    );
}
