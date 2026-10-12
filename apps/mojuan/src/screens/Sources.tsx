import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { Comic } from "../api";
import { getSettings, rememberDiscovery } from "../lib/storage/settings";
import { whenSourcesReady } from "../lib/storage/sources";
import { useCrawl } from "../lib/hooks/use-crawl";
import { useIsMobile } from "../lib/platform";
import { SOURCES, sourceTitle } from "../lib/sources";
import { cn } from "../lib/utils";
import {
    Banner,
    ComicCard,
    ComicRow,
    EmptyState,
    Loading,
    PageHeader,
} from "../components/ui";
import { Button } from "../components/beui/button";
import { Tabs, TabsList, TabsTrigger } from "../components/beui/tabs";
import { Input } from "../components/beui/input";
import { SourceSheet } from "../components/source-sheet";
import { ChevronDown, Compass, Search, X } from "lucide-react";

/** 列表缓存的新鲜窗口：窗口内切换源/分类直接用缓存、不发请求；
 * 窗口外先显示缓存（stale），再拉最新覆盖（revalidate）。 */
const LIST_MAX_AGE_MS = 2 * 60 * 1000;

/** 发现页要恢复的浏览位置：上次停留的源 + 各源上次停留的分类。 */
interface DiscoveryPrefs {
    source: string;
    lastCategory: Record<string, string>;
}

/** 先读回持久化的浏览位置，再交给 Discovery 渲染：避免开局按默认源拉一次列表、
 * 又立刻切到记忆里的源。 */
export default function Sources() {
    const [params] = useSearchParams();
    const [prefs, setPrefs] = useState<DiscoveryPrefs | null>(null);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            // 源清单（含默认源）由源注册表填充，等同步完成再取
            await whenSourcesReady();
            const s = await getSettings();
            if (cancelled) return;
            setPrefs({
                source: params.get("source") ?? s.lastSource ?? SOURCES[0]?.id ?? "",
                lastCategory: s.lastCategory,
            });
        })();
        return () => {
            cancelled = true;
        };
        // 只在挂载时读一次；此后 URL 变化由 Discovery 内的 effect 跟随
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    if (!prefs) {
        return (
            <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8">
                <Loading label="正在打开发现页" />
            </div>
        );
    }
    return <Discovery prefs={prefs} />;
}

function Discovery({ prefs }: { prefs: DiscoveryPrefs }) {
    const mobile = useIsMobile();
    const [params] = useSearchParams();
    const [source, setSource] = useState(prefs.source);
    // 选中的分类：连同它属于哪个源一起记，切源后自动回到「还没选」的状态
    const [picked, setPicked] = useState<{ source: string; category: string } | null>(
        null,
    );
    const category = picked?.source === source ? picked.category : null;
    // 已提交的搜索：同样连同源一起记，切源后回到分类浏览
    const [search, setSearch] = useState<{ source: string; keyword: string } | null>(
        null,
    );
    const inSearch = search?.source === source;
    // 搜索框里正在输入的内容
    const [keyword, setKeyword] = useState("");
    // 每个源记忆的分类（切回该源时优先恢复，标签已失效则退回第一个）
    const lastCategoryRef = useRef<Record<string, string>>({ ...prefs.lastCategory });
    // 源选择面板（切换源是低频操作，列表收进面板；页头只留当前源按钮）
    const [sheetOpen, setSheetOpen] = useState(false);
    const sourceTriggerRef = useRef<HTMLButtonElement>(null);

    const categories = useCrawl<string[]>("categories", source, {});
    const list = useCrawl<Comic[]>(
        inSearch ? "search" : "category",
        source,
        inSearch ? { keyword: search?.keyword ?? "" } : { label: category },
        { maxAge: LIST_MAX_AGE_MS, enabled: inSearch || category !== null },
    );
    const comics = list.data ?? [];
    const sourceErr = list.error ?? categories.error;
    // 缓存已经在屏上时不算忙：后台拉最新不挡操作，也不压暗列表
    const busy = list.loading && !list.stale;

    // 命令面板跳转（/?source=xxx）：URL 指定的源优先
    useEffect(() => {
        const want = params.get("source");
        if (want && want !== source) {
            setSource(want);
            void rememberDiscovery(want);
        }
    }, [params, source]);

    // 分类表到达（缓存或网络）后为该源选一个分类；网络结果后到时不再改选。
    // 只在分类表变化时触发：切源不触发（那时 data 还属于上一个源），新源的数据
    // 到达时这里读到的是新 source。
    useEffect(() => {
        const cats = categories.data;
        if (!cats || cats.length === 0) return;
        if (picked?.source === source) return;
        const want = lastCategoryRef.current[source];
        const cat = want && cats.includes(want) ? want : (cats[0] ?? null);
        if (cat === null) return;
        setPicked({ source, category: cat });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [categories.data]);

    function selectSource(id: string) {
        setSource(id);
        void rememberDiscovery(id);
    }

    function selectCategory(label: string) {
        lastCategoryRef.current[source] = label;
        void rememberDiscovery(source, label);
        setPicked({ source, category: label });
        setSearch(null);
        setKeyword("");
    }

    function onSearch() {
        const kw = keyword.trim();
        if (!kw) {
            exitSearch();
            return;
        }
        // 搜索结果与分类列表不是一回事，别把上一个分类的结果留在屏幕上冒充它
        setSearch({ source, keyword: kw });
    }

    /** 退出搜索，回到分类浏览（输入框一并清空）。 */
    function exitSearch() {
        setKeyword("");
        setSearch(null);
    }

    const isEmpty = !busy && comics.length === 0;

    return (
        <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8">
            <PageHeader
                title="发现"
                sub="搜索漫画，或按分类浏览"
                actions={
                    <button
                        type="button"
                        ref={sourceTriggerRef}
                        onClick={() => setSheetOpen(true)}
                        aria-haspopup="dialog"
                        aria-expanded={sheetOpen}
                        className={cn(
                            "inline-flex h-7 items-center gap-1 rounded-full bg-primary/12 pl-3 pr-2.5 text-xs font-medium text-primary",
                            "transition-colors hover:bg-primary/20",
                            "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                        )}
                    >
                        {sourceTitle(source)}
                        <ChevronDown className="size-3.5" aria-hidden="true" />
                    </button>
                }
            />

            <div className="mb-4 flex items-end gap-2">
                <Input
                    className="flex-1"
                    value={keyword}
                    onChange={setKeyword}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") onSearch();
                    }}
                    placeholder="搜索漫画标题…"
                    leftIcon={<Search className="size-4" />}
                    aria-label="搜索漫画标题"
                />
                <Button
                    variant="primary"
                    size="md"
                    onClick={onSearch}
                    disabled={busy}
                >
                    {busy ? "加载中…" : "搜索"}
                </Button>
            </div>

            {/* 分类浏览与搜索各占一块，不同时出现：搜索时分类 tabs 让位给搜索头，
                结果只属于当前这一块 */}
            {inSearch ? (
                <div className="mb-5 flex min-h-11 items-center gap-2 rounded-lg bg-card px-3">
                    <Search
                        className="size-4 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                    />
                    <p className="min-w-0 flex-1 truncate text-sm">
                        搜索 “
                        <span className="font-semibold">{search?.keyword}</span>”
                    </p>
                    {!busy && comics.length > 0 && (
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                            {comics.length} 部作品
                        </span>
                    )}
                    <button
                        type="button"
                        onClick={exitSearch}
                        aria-label="退出搜索"
                        className={cn(
                            "inline-flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors",
                            "hover:bg-secondary hover:text-foreground",
                            "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                        )}
                    >
                        <X className="size-3.5" aria-hidden="true" />
                    </button>
                </div>
            ) : categories.data && categories.data.length > 0 ? (
                <Tabs
                    value={category ?? ""}
                    onValueChange={selectCategory}
                    variant="segment"
                    className="mb-5 w-full"
                >
                    <TabsList className="max-w-full bg-card">
                        {categories.data.map((c) => (
                            <TabsTrigger key={c} value={c}>
                                {c}
                            </TabsTrigger>
                        ))}
                    </TabsList>
                </Tabs>
            ) : null}

            {sourceErr && (
                <Banner>
                    加载失败：{sourceErr}
                    <Button
                        variant="ghost"
                        size="sm"
                        className="ml-2"
                        onClick={() => {
                            categories.reload();
                            list.reload();
                        }}
                    >
                        重试
                    </Button>
                </Banner>
            )}

            {busy && comics.length === 0 ? (
                <Loading label={inSearch ? "正在搜索" : "正在加载列表"} />
            ) : isEmpty ? (
                <EmptyState
                    icon={<Compass className="size-7" />}
                    text={
                        sourceErr
                            ? "这个漫画源暂时用不了"
                            : inSearch
                              ? "没有找到相关作品"
                              : "这里还没有漫画"
                    }
                    hint={
                        sourceErr
                            ? "换一个漫画源，或稍后再试"
                            : inSearch
                              ? "换个关键词试试"
                              : "换个分类，或搜别的词"
                    }
                />
            ) : (
                <div
                    className={cn(
                        "transition-opacity duration-200",
                        busy && "pointer-events-none opacity-50",
                    )}
                    aria-busy={busy}
                >
                    {mobile ? (
                        <div className="flex flex-col gap-2">
                            {comics.map((c, i) => (
                                <ComicRow
                                    key={c.id}
                                    delay={Math.min(i * 28, 280)}
                                    to={`/comic/${c.source}/${encodeURIComponent(c.id)}`}
                                    cover={c.cover}
                                    title={c.title}
                                    subtitle={c.author || "未知作者"}
                                    tags={c.tags}
                                    chapterTag={c.lastChapter.replace(/^#/, "")}
                                />
                            ))}
                        </div>
                    ) : (
                        <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 lg:grid-cols-6">
                            {comics.map((c, i) => (
                                <ComicCard
                                    key={c.id}
                                    comic={c}
                                    delay={Math.min(i * 30, 300)}
                                />
                            ))}
                        </div>
                    )}
                </div>
            )}

            <SourceSheet
                open={sheetOpen}
                onOpenChange={setSheetOpen}
                current={source}
                onSelect={selectSource}
                restoreFocusRef={sourceTriggerRef}
            />
        </div>
    );
}
