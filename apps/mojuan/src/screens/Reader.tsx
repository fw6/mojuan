import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type MouseEvent,
    type ReactNode,
} from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useScroll } from "motion/react";
import {
    AlertTriangle,
    ArrowLeft,
    BookOpen,
    List,
    Maximize,
    Minimize,
} from "lucide-react";
import {
    crawl,
    crawlCached,
    getDownloads,
    imgSrc,
    listDownloaded,
    type Chapter,
    type Comic,
    type DownloadStatus,
    type DownloadedPage,
} from "../api";
import { filterExternalChapters } from "../lib/chapters";
import { windowChrome } from "../lib/chrome";
import { chapterDownloadStates } from "../lib/downloads";
import { nearBottomByPx } from "../lib/scroll";
import { touchHistory } from "../lib/storage/history";
import { getSettings } from "../lib/storage/settings";
import { cn } from "../lib/utils";
import { useHoverCapable } from "../lib/hooks/use-hover-capable";
import { useReaderPosition } from "../lib/hooks/use-reader-position";
import { useSystemBars } from "../lib/hooks/use-system-bars";
import { useIsMobile } from "../lib/platform";
import { tapZone } from "../lib/tap-zones";
import { virtualizerAdapter } from "../lib/reader-virtualizer";
import { ChapterSheet } from "../components/chapter-sheet";
import ProxyImage from "../components/ProxyImage";
import { useToast } from "../components/toast";
import { Loader } from "../components/beui/loader";
import { ScrollProgress } from "../components/beui/scroll-progress";

interface PageItem {
    /** 在过滤后章节列表中的下标 */
    chapterIdx: number;
    /** 原始图 URL；旧下载数据没有索引记录时是 `chapter_<n>/<file>` 相对路径 */
    url: string;
}

/** 未测量页的高度估算：撑起布局与滚动条，图片加载后按真实高度收缩。
 * 比例优先取该源已加载页面的实测中位数（长条漫与常规页差别很大），
 * 还没有样本时按源给出经验值。 */
const FALLBACK_RATIO: Record<string, number> = { webtoons: 2 };
const DEFAULT_RATIO = 1.4;
/** 每个源保留的最近样本数。 */
const RATIO_SAMPLES = 8;
const ratioSamples = new Map<string, number[]>();

/** 预取范围：视口上下各两屏。挂载与图片请求都按这个范围走。 */
const PREFETCH_SCREENS = 2;
/** 预取页数上限（页面很矮时防止一次挂载过多）。 */
const OVERSCAN_MAX = 8;
/** 鼠标静止多久后隐去指针。 */
const CURSOR_IDLE_MS = 2000;
/** 方向判定死区：小于这个位移不切换顶栏，免得滚动惯性里反复闪。 */
const SCROLL_DIRECTION_SLOP = 4;
/** 顶栏自己的上内边距（py-1.5），让开状态栏时不能把它吃掉。 */
const CHROME_PADDING_TOP = "0.375rem";

function learnedRatio(source: string | undefined): number {
    const samples = source ? ratioSamples.get(source) : undefined;
    if (!samples || samples.length === 0) return 0;
    const sorted = [...samples].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

function rememberRatio(source: string | undefined, ratio: number): boolean {
    if (!source || !Number.isFinite(ratio) || ratio <= 0) return false;
    const samples = ratioSamples.get(source) ?? [];
    samples.push(ratio);
    if (samples.length > RATIO_SAMPLES) samples.shift();
    ratioSamples.set(source, samples);
    return true;
}

export default function Reader({ local = false }: { local?: boolean }) {
    const { source, comicId, chapterIndex } = useParams();
    const id = comicId ? decodeURIComponent(comicId) : "";
    const navigate = useNavigate();
    const toast = useToast();
    const canHover = useHoverCapable();
    const isMobile = useIsMobile();

    const [comic, setComic] = useState<Comic | null>(null);
    const [chapters, setChapters] = useState<Chapter[]>([]);
    const [pages, setPages] = useState<PageItem[]>([]);
    const [loading, setLoading] = useState(false);
    // 首次进入的加载：ready 之前连章节列表都还没有，画布上没有任何页面；
    // bootFailed 覆盖详情与首章图片两处失败（都要给得出重试，否则只剩一个空画布）
    const [ready, setReady] = useState(false);
    const [bootFailed, setBootFailed] = useState(false);
    const [retryKey, setRetryKey] = useState(0);
    const [fullscreen, setFullscreen] = useState(false);
    const [autoTrim, setAutoTrim] = useState(false);
    const [columnWidth, setColumnWidth] = useState(720);
    const [viewportHeight, setViewportHeight] = useState(0);
    // 顶栏显隐（滚动方向与点击画面切换）与光标静止隐去，共同构成沉浸阅读
    const [chromeVisible, setChromeVisible] = useState(true);
    // 沉浸式阅读（移动端）：顶栏与系统栏一起收走，整屏让给漫画
    const [immersive, setImmersive] = useState(false);
    const [cursorIdle, setCursorIdle] = useState(false);
    // 目录面板：打开时按章节序号给出各话在下载队列里的状态
    const [tocOpen, setTocOpen] = useState(false);
    const [downloadTasks, setDownloadTasks] = useState<Record<number, DownloadStatus>>({});
    const [ratio, setRatio] = useState(
        () => learnedRatio(source) || FALLBACK_RATIO[source ?? ""] || DEFAULT_RATIO,
    );

    // 系统栏（状态栏与导航栏）：沉浸式时隐藏
    useSystemBars(immersive);
    /** 顶栏是否在屏上：移动端由沉浸式状态决定（滑动进沉浸、点中带退出），
     *  桌面端仍是随滚动方向显隐。 */
    const chromeShown = isMobile ? !immersive : chromeVisible;
    /** 全屏状态：移动端是沉浸式阅读（收走系统栏），桌面端是窗口全屏。 */
    const chromeFull = isMobile ? immersive : fullscreen;

    const containerRef = useRef<HTMLDivElement>(null);
    const columnRef = useRef<HTMLDivElement>(null);
    const chaptersRef = useRef<Chapter[]>([]);
    const comicRef = useRef<Comic | null>(null);
    const pagesRef = useRef<PageItem[]>([]);
    /** 下载目录里的章节 → 页面（已下载的话直接读它，不必联网取图）。 */
    const downloadsRef = useRef<Record<string, DownloadedPage[]>>({});
    /** 下载目录本身（目录面板打开时按它重读磁盘清单）。 */
    const downloadDirRef = useRef<string | null>(null);
    /** 作品元数据是否来自下载目录（那时标题只有话序号，历史不写这种条目）。 */
    const syntheticComicRef = useRef(false);
    const currentIdxRef = useRef(0);
    const loadingRef = useRef(false);
    const loadedChaptersRef = useRef<Set<number>>(new Set());
    /** 换话代次：跳转时自增，在途的取图结果随之作废。 */
    const generationRef = useRef(0);
    /** 至少有一张图真的加载过（跨话预取的守卫：初始级联时先别预取下一话）。 */
    const imageLoadedRef = useRef(false);
    const progressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const viewportHeightRef = useRef(800);
    const lastTopRef = useRef(0);
    /** 用户已经有过一次手势：进入阅读器时的位置恢复也会派发 scroll 事件，
     *  那不是「开始阅读」，不能让它把状态栏收走。 */
    const userGestureRef = useRef(false);
    const chromeRef = useRef(true);
    const cursorIdleRef = useRef(false);
    const cursorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    chaptersRef.current = chapters;
    comicRef.current = comic;
    pagesRef.current = pages;
    loadingRef.current = loading;

    const { scrollYProgress } = useScroll({ container: containerRef });

    /** 未加载页的预留高度：列宽 × 该源实测中位宽高比。 */
    const estimatePageHeight = useCallback(
        (width: number) => Math.round(Math.max(320, width * ratio)),
        [ratio],
    );

    /** 图片给出真实大小时记录比例，后续未加载页的预留高度随之收敛。 */
    const onNaturalSize = useCallback(
        (width: number, height: number) => {
            imageLoadedRef.current = true;
            if (!rememberRatio(source, height / width)) return;
            const next = learnedRatio(source);
            // 变化小于 5% 不重建布局，避免边读边抖
            if (next > 0 && Math.abs(next - ratio) / ratio > 0.05) setRatio(next);
        },
        [source, ratio],
    );

    /** 挂载范围＝视口上下各两屏换算成的页数（长条漫一页就超过两屏，取 1）。 */
    const overscanPages = useMemo(() => {
        const pageHeight = estimatePageHeight(columnWidth);
        const screens = (viewportHeight || 800) / pageHeight;
        return Math.min(
            Math.max(Math.ceil(screens * PREFETCH_SCREENS), 1),
            OVERSCAN_MAX,
        );
    }, [estimatePageHeight, columnWidth, viewportHeight]);

    /**
     * 虚拟化渲染：只挂载视口附近页面（含 overscan），页面高度经 ResizeObserver
     * 测量（图片加载后自动重测）；未测页用 estimateSize 撑布局。
     */
    const virtualizer = useVirtualizer({
        count: pages.length,
        getScrollElement: () => containerRef.current,
        estimateSize: () => estimatePageHeight(columnWidth),
        overscan: overscanPages,
    });

    // 位置模型：视口中心 ⇄（话序号, 话内页码, 页内位置）。虚拟器经适配面交进去
    // （measurementsCache 的稀疏稠密化在 reader-virtualizer.ts）。
    const positionAdapter = useMemo(() => virtualizerAdapter(virtualizer), [virtualizer]);
    const { record } = useReaderPosition({
        container: containerRef,
        virtualizer: positionAdapter,
        pages,
        chapters,
        comic,
        chapterIndex: Number(chapterIndex),
    });

    /** 阅读列宽度（决定估算高度与最小高度）。 */
    useEffect(() => {
        const el = columnRef.current;
        if (!el) return;
        const update = (width: number) => setColumnWidth(Math.round(width));
        update(el.getBoundingClientRect().width);
        const observer = new ResizeObserver(([entry]) =>
            update(entry.contentRect.width),
        );
        observer.observe(el);
        return () => observer.disconnect();
    }, [autoTrim]);

    /** 视口高度（决定挂载范围与下一话的提前量）。 */
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const update = (height: number) => {
            const rounded = Math.round(height);
            viewportHeightRef.current = rounded;
            setViewportHeight(rounded);
        };
        update(el.getBoundingClientRect().height);
        const observer = new ResizeObserver(([entry]) =>
            update(entry.contentRect.height),
        );
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    /** 一章的页面地址：已下载的话读下载清单（url 优先，旧数据回落到相对路径），
     * 否则走 images op。一个地址都取不到按加载失败处理（离线且这一话没下载就是这样）。 */
    const chapterPages = useCallback(
        async (chapter: Chapter): Promise<string[]> => {
            const listed = downloadsRef.current[String(chapter.index)];
            const imgs = listed
                ? listed.map((p) => p.url || p.path)
                : await crawl<string[]>("images", source!, {
                      comicId: id,
                      chapterIndex: chapter.index,
                  });
            if (imgs.length === 0) {
                throw new Error(`第 ${chapter.index} 话没有取到页面`);
            }
            return imgs;
        },
        [source, id],
    );

    /** 追加某章图片（幂等：已加载章节跳过；失败可重试）。 */
    const appendChapter = useCallback(
        async (chapterIdx: number) => {
            if (loadingRef.current || loadedChaptersRef.current.has(chapterIdx)) return;
            const chapter = chaptersRef.current[chapterIdx];
            if (!chapter) return;
            const generation = generationRef.current;
            loadedChaptersRef.current.add(chapterIdx);
            loadingRef.current = true;
            setLoading(true);
            try {
                const imgs = await chapterPages(chapter);
                // 取图期间跳过话：这一批页已经不属于当前画面，丢掉
                if (generation !== generationRef.current) return;
                const next = [
                    ...pagesRef.current,
                    ...imgs.map((url) => ({ chapterIdx, url })),
                ];
                pagesRef.current = next;
                setPages(next);
                currentIdxRef.current = chapterIdx;
                setBootFailed(false);
            } catch (err) {
                if (generation !== generationRef.current) return;
                loadedChaptersRef.current.delete(chapterIdx);
                console.error(err);
                // 首章失败：画布上还没有任何页面，只弹 toast 给不出能点的重试
                if (pagesRef.current.length === 0) {
                    setBootFailed(true);
                } else {
                    toast.show("这一话加载失败，滚动到底部可重试", "error");
                }
            } finally {
                if (generation === generationRef.current) {
                    loadingRef.current = false;
                    setLoading(false);
                }
            }
        },
        [chapterPages, toast],
    );

    /** 从目录跳到某一话：丢掉已加载的页，从这一话第一页重新开始。
     *  在途的预取经代次作废，不会落到新的一话上；点已经在读的这一话就回到话首。 */
    const jumpToChapter = useCallback(
        async (index: number) => {
            const target = chaptersRef.current.findIndex((c) => c.index === index);
            if (target < 0) return;
            const container = containerRef.current;
            if (target === currentIdxRef.current) {
                container?.scrollTo({ top: 0 });
                return;
            }
            generationRef.current += 1;
            loadedChaptersRef.current = new Set();
            pagesRef.current = [];
            setPages([]);
            loadingRef.current = false;
            setLoading(false);
            imageLoadedRef.current = false;
            currentIdxRef.current = target;
            lastTopRef.current = 0;
            container?.scrollTo({ top: 0 });
            // 换了内容就丢掉按页下标缓存的实测高度（默认的键就是下标）
            virtualizer.measure();
            await appendChapter(target);
        },
        [appendChapter, virtualizer],
    );

    /** 顶栏显隐只在值真的变化时写入 state（滚动事件里省掉无谓的重渲染）。 */
    const setChrome = useCallback((visible: boolean) => {
        if (chromeRef.current === visible) return;
        chromeRef.current = visible;
        setChromeVisible(visible);
    }, []);

    /** 鼠标一动就唤回指针，静止两秒后隐去。 */
    const wakeCursor = useCallback(() => {
        if (!canHover) return;
        if (cursorIdleRef.current) {
            cursorIdleRef.current = false;
            setCursorIdle(false);
        }
        if (cursorTimer.current !== null) clearTimeout(cursorTimer.current);
        cursorTimer.current = setTimeout(() => {
            cursorIdleRef.current = true;
            setCursorIdle(true);
        }, CURSOR_IDLE_MS);
    }, [canHover]);

    useEffect(() => {
        if (!canHover) return;
        wakeCursor();
        return () => {
            if (cursorTimer.current !== null) clearTimeout(cursorTimer.current);
        };
    }, [canHover, wakeCursor]);

    const onScroll = useCallback(() => {
        const el = containerRef.current;
        if (el) {
            const top = el.scrollTop;
            const delta = top - lastTopRef.current;
            lastTopRef.current = top;
            if (isMobile) {
                // 开始阅读（滑动，或点两侧翻页带来的滚动）即进沉浸式；退出靠点中带
                if (userGestureRef.current) setImmersive(true);
            } else if (delta > SCROLL_DIRECTION_SLOP) {
                // 向下滚收起顶栏，向上滚或回到顶部唤出
                setChrome(false);
            } else if (delta < -SCROLL_DIRECTION_SLOP || top < 16) {
                setChrome(true);
            }
            wakeCursor();
        }
        if (progressTimer.current !== null) clearTimeout(progressTimer.current);
        progressTimer.current = setTimeout(() => {
            const node = containerRef.current;
            if (!node) return;
            const { scrollTop, clientHeight, scrollHeight } = node;
            // 跨话连续：距底不足两屏且有下一话（至少一张图加载过，防初始级联）→ 预取下一话。
            // 判据用图片加载而不是虚拟器的 itemSizeCache：实测高度与估算相等时那个 Map 不会写入。
            if (
                nearBottomByPx(
                    scrollTop,
                    clientHeight,
                    scrollHeight,
                    viewportHeightRef.current * PREFETCH_SCREENS,
                ) &&
                currentIdxRef.current < chaptersRef.current.length - 1 &&
                imageLoadedRef.current
            ) {
                void appendChapter(currentIdxRef.current + 1);
            }
            const at = record();
            const c = comicRef.current;
            // 下载目录兜底时没有真实标题，历史 tab 保持链在线 reader（#19）
            if (at && c && !syntheticComicRef.current) {
                void touchHistory(c, at.chapterIndex);
            }
        }, 250);
    }, [appendChapter, record, setChrome, wakeCursor, isMobile]);

    // 进入：加载详情（漫画 + 过滤后章节）+ 首章图片，并记一条历史
    // 换话时这个 effect 会重跑（chapterIndex 在依赖里），但不重置 ready：
    // 那时画面上已有上一话的页面，回到加载态反而会把读着的内容换成加载动画
    useEffect(() => {
        let cancelled = false;
        setBootFailed(false);
        /** 首次加载：详情 + 首章图片。失败记进 bootFailed，界面给重试。 */
        const boot = async () => {
            const settings = await getSettings();
            const dir = settings.downloadDir;
            // 下载清单：本地模式的唯一来源，也是在线阅读取不到详情时的兜底
            const listed = dir ? await listDownloaded(dir, source!, id) : {};
            if (cancelled) return;
            downloadsRef.current = listed;
            downloadDirRef.current = dir;

            /** 下载目录里的章节：标题只有话序号，comic 元数据是合成的。 */
            const fromDownloads = (): { comic: Comic; chapters: Chapter[] } => ({
                comic: {
                    id,
                    source: source!,
                    sourceTitle: "本地",
                    title: id,
                    author: "",
                    intro: "",
                    cover: "",
                    status: "serial",
                    updateTime: "",
                    lastChapter: "",
                    tags: [],
                    lastReadChapter: 0,
                    lastReadTime: 0,
                },
                chapters: Object.entries(listed)
                    .map(([idx]) => ({
                        index: Number(idx),
                        title: `第 ${Number(idx)} 话`,
                        // 页面地址在 appendChapter 里从下载清单取
                        pages: [] as string[],
                        external: false,
                        downloaded: true,
                        read: false,
                    }))
                    .sort((a, b) => a.index - b.index),
            });

            /** 抓取成功的详情：有 comic 就算成功（章节可能为空——整部都是站外章节）。 */
            const detailOf = (v: { comic?: Comic; chapters?: Chapter[] } | null | undefined) =>
                v?.comic
                    ? { comic: v.comic, chapters: filterExternalChapters(v.chapters ?? []) }
                    : null;

            // 详情来源：本地模式只认下载目录；在线阅读先读结果缓存（详情页每次进都刷新它，
            // 离线进阅读器也能立刻拿到带标题的章节表），缓存没有但这部作品有下载就用下载
            // 清单，手头什么都没有才联网（渲染源的章节中转链也靠这次抓取）。
            let data: { comic: Comic; chapters: Chapter[] } | null = null;
            let synthetic = false;
            if (local) {
                data = fromDownloads();
                synthetic = true;
            } else {
                const cached = await crawlCached<{ comic: Comic; chapters: Chapter[] }>(
                    "detail",
                    source!,
                    { comicId: id },
                );
                if (cancelled) return;
                data = detailOf(cached?.data);
                if (!data && Object.keys(listed).length > 0) {
                    data = fromDownloads();
                    synthetic = true;
                }
                if (!data) {
                    const fresh = await crawl<{ comic: Comic; chapters: Chapter[] }>(
                        "detail",
                        source!,
                        { comicId: id },
                    );
                    if (cancelled) return;
                    data = detailOf(fresh);
                }
            }
            if (!data) {
                throw new Error(`没有取到 ${source}/${id} 的详情`);
            }

            const target = Math.max(
                0,
                data.chapters.findIndex((c) => c.index === Number(chapterIndex)),
            );
            comicRef.current = data.comic;
            chaptersRef.current = data.chapters;
            syntheticComicRef.current = synthetic;
            setComic(data.comic);
            setChapters(data.chapters);
            setReady(true);
            currentIdxRef.current = target;
            // 下载目录里没有真实标题，历史 tab 保持链在线 reader（#19）
            if (!synthetic) void touchHistory(data.comic, data.chapters[target]?.index ?? 0);
            loadingRef.current = false;
            await appendChapter(target);
        };
        void boot().catch((err) => {
            console.error(err);
            if (!cancelled) setBootFailed(true);
        });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [source, id, chapterIndex, local, retryKey]);

    // 打开目录时重读一次下载状态：磁盘清单是「能不能离线读」的判据（在别处下完的话
    // 这里要看得到），队列快照给出在途的那几话。队列只取一次快照——进度通道是全局
    // 单槽（Rust State 里只存一个 Channel），阅读器订阅会把下载页的订阅顶掉。
    useEffect(() => {
        if (!tocOpen) return;
        let cancelled = false;
        void (async () => {
            const dir = downloadDirRef.current;
            const listed = dir ? await listDownloaded(dir, source!, id) : {};
            if (cancelled) return;
            downloadsRef.current = listed;
            const tasks: Record<number, DownloadStatus> = {};
            try {
                for (const task of await getDownloads()) {
                    if (task.source === source && task.comicId === id) {
                        tasks[task.chapterIndex] = task.status;
                    }
                }
            } catch (err) {
                // 队列快照取不到只影响在途状态，磁盘清单照常给出「已下载」
                console.error(err);
            }
            if (!cancelled) setDownloadTasks(tasks);
        })().catch((err) => console.error(err));
        return () => {
            cancelled = true;
        };
    }, [tocOpen, source, id]);

    // 全屏（grilling #6）：隐藏窗口边框与标题栏；Esc 退出。
    // 进全屏即收起顶栏（点画面可唤回），退出全屏把顶栏交还出来。
    const toggleFullscreen = useCallback(async () => {
        const next = !fullscreen;
        await getCurrentWindow().setFullscreen(next);
        setFullscreen(next);
        setChrome(!next);
    }, [fullscreen, setChrome]);

    /** 翻一屏。阅读形态是连续滚动，所以「一页」就是一屏：长条漫一页好几屏，
     *  按图片翻会跳过一大段。 */
    const turnPage = useCallback((direction: 1 | -1) => {
        const el = containerRef.current;
        if (!el) return;
        // 位移降级：系统开了「减少动态效果」时直接跳过去（beui.css 那条只压 CSS 的
        // scroll-behavior，JS 这个 behavior 选项它管不到）
        const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
        el.scrollTo({
            top: el.scrollTop + direction * el.clientHeight,
            behavior: reduce ? "auto" : "smooth",
        });
    }, []);

    /** 记下「用户碰过画面」：位置恢复也会派发 scroll，那不是阅读。 */
    const onPointerDown = useCallback(() => {
        userGestureRef.current = true;
    }, []);

    /** 点击画面：移动端按横向三分带分流（左翻上一页、中切沉浸式、右翻下一页），
     *  桌面端整片画面都是顶栏开关。控件自己的点击与文字拖选不算。 */
    const onContainerClick = useCallback(
        (e: MouseEvent<HTMLDivElement>) => {
            if ((e.target as HTMLElement).closest("a,button,header")) return;
            if (window.getSelection()?.toString()) return;
            if (!isMobile) {
                setChrome(!chromeRef.current);
                return;
            }
            const el = containerRef.current;
            if (!el) return;
            const rect = el.getBoundingClientRect();
            const zone = tapZone(e.clientX - rect.left, rect.width);
            if (zone === "prev") turnPage(-1);
            else if (zone === "next") turnPage(1);
            else setImmersive((v) => !v);
        },
        [setChrome, isMobile, turnPage],
    );

    // 自动裁边（设置项）：页面略放大，裁掉边缘空白
    useEffect(() => {
        void getSettings().then((s) => setAutoTrim(s.autoTrim));
    }, []);

    /** 首次加载失败后的重试：清掉失败标记、让加载 effect 重跑一遍。 */
    const retryBoot = useCallback(() => {
        setBootFailed(false);
        setReady(false);
        setRetryKey((k) => k + 1);
    }, []);

    // 卸载时清掉两个防抖计时器，并把窗口还原——否则从全屏的阅读器返回，
    // 会把全屏状态带到其他页面上
    useEffect(
        () => () => {
            if (progressTimer.current !== null) clearTimeout(progressTimer.current);
            if (cursorTimer.current !== null) clearTimeout(cursorTimer.current);
            const win = getCurrentWindow();
            void win.isFullscreen().then((fs) => {
                if (fs) void win.setFullscreen(false);
            });
        },
        [],
    );

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== "Escape") return;
            // 目录面板开着时 Escape 归它关（它自己也在 window 上听，先跑的是这里，
            // 不挡住的话一次 Escape 会既关面板又退出阅读器）
            if (tocOpen) return;
            if (fullscreen) {
                void getCurrentWindow().setFullscreen(false);
                setFullscreen(false);
                setChrome(true);
            } else {
                navigate(-1);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [fullscreen, navigate, setChrome, tocOpen]);

    const lastChapter = currentIdxRef.current >= chapters.length - 1;
    const currentChapter = chapters[currentIdxRef.current];
    const reserved = estimatePageHeight(columnWidth);
    /** 目录面板里各话的下载状态（磁盘清单 + 队列快照）。 */
    const downloadStates = chapterDownloadStates(
        chapters,
        downloadsRef.current,
        downloadTasks,
    );
    const backTo = local
        ? "/library"
        : `/comic/${source}/${encodeURIComponent(id)}`;

    return (
        <div className="relative flex min-h-0 flex-1 flex-col bg-reader-canvas text-reader-foreground">
            <div
                ref={containerRef}
                onScroll={onScroll}
                onPointerDown={onPointerDown}
                onPointerMove={wakeCursor}
                onClick={onContainerClick}
                className={cn(
                    "min-h-0 flex-1 overflow-y-auto overscroll-contain",
                    cursorIdle && "cursor-none",
                )}
                // 画布铺到导航栏下面（栏是半透明的，漫画从它下面过），给末尾的加载行与
                // 「最后一话」让出一条。安全区随栏的显隐自己变（实测 Android 17：栏在时
                // 24px、栏隐藏后 0px），所以沉浸式里不留空隙。
                style={{
                    paddingBottom: "env(safe-area-inset-bottom)",
                }}
            >
                {bootFailed ? (
                    <div className="flex flex-col items-center justify-center gap-3 px-6 py-20 text-center">
                        <AlertTriangle className="size-8 text-reader-muted" />
                        <p className="text-sm text-reader-muted">
                            章节加载失败，检查网络后重试
                        </p>
                        <ReaderButton onClick={retryBoot}>重试</ReaderButton>
                    </div>
                ) : !ready || (pages.length === 0 && loading) ? (
                    // 首次进入：详情与首章图片都还没到，画布上还没有任何页面
                    <div className="flex flex-col items-center justify-center gap-3 px-6 py-24 text-center">
                        <Loader
                            variant="dots"
                            size={22}
                            label="正在加载章节"
                            className="text-reader-muted"
                        />
                        <p className="text-sm text-reader-muted">正在加载章节…</p>
                    </div>
                ) : chapters.length === 0 ? (
                    <div className="flex flex-col items-center justify-center gap-3 px-6 py-20 text-center">
                        <BookOpen className="size-8 text-reader-muted" />
                        <p className="text-sm text-reader-muted">
                            {local
                                ? "这部作品还没有下载的章节"
                                : "这部作品只有站外章节，已经隐藏"}
                        </p>
                        <ReaderButton onClick={() => navigate(-1)}>返回</ReaderButton>
                    </div>
                ) : (
                    <>
                        <div
                            ref={columnRef}
                            className="relative mx-auto w-full"
                            style={{ maxWidth: autoTrim ? "none" : 720 }}
                        >
                            <div
                                className="relative"
                                style={{ height: virtualizer.getTotalSize() }}
                            >
                                {virtualizer.getVirtualItems().map((vi) => {
                                    const page = pages[vi.index];
                                    if (!page) return null;
                                    return (
                                        <div
                                            key={vi.key}
                                            data-index={vi.index}
                                            ref={virtualizer.measureElement}
                                            className="absolute left-0 top-0 w-full overflow-hidden"
                                            style={{
                                                transform: `translateY(${vi.start}px)`,
                                            }}
                                        >
                                            <ReaderPage
                                                src={imgSrc(page.url, {
                                                    source,
                                                    comicId: id,
                                                })}
                                                index={vi.index}
                                                reserved={reserved}
                                                autoTrim={autoTrim}
                                                onNaturalSize={onNaturalSize}
                                            />
                                        </div>
                                    );
                                })}
                            </div>
                        </div>

                        {loading && (
                            <div className="flex items-center justify-center gap-2 py-6 text-xs text-reader-muted">
                                <Loader
                                    variant="dots"
                                    size={18}
                                    label="正在加载下一话"
                                    className="text-reader-muted"
                                />
                                正在加载下一话…
                            </div>
                        )}

                        {!loading && lastChapter && pages.length > 0 && (
                            <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
                                <BookOpen className="size-8 text-reader-muted" />
                                <p className="text-sm font-medium">已经是最后一话了</p>
                                <ReaderButton onClick={() => navigate(backTo)}>
                                    回到章节列表
                                </ReaderButton>
                            </div>
                        )}
                    </>
                )}
            </div>

            <ScrollProgress
                progress={scrollYProgress}
                fixed={false}
                position="top"
                height={2}
                className="bg-reader-foreground/60"
            />

            <header
                className={cn(
                    "absolute inset-x-0 top-0 z-30 flex items-center gap-2 border-b border-reader-border bg-reader-canvas/80 px-2 py-1.5 backdrop-blur-md",
                    // macOS 的红黄绿浮在 webview 上（titleBarStyle: Overlay），占 x 9–68.5，
                    // 阅读器没有侧边栏、顶栏从窗口左边缘开始，返回按钮与作品名会压在按钮组底下
                    windowChrome() === "macos" && "pl-19",
                    "transition-[opacity,translate] duration-200 ease-out",
                    chromeShown
                        ? "translate-y-0 opacity-100"
                        : "pointer-events-none -translate-y-2 opacity-0",
                )}
                // 顶栏是浮层，状态栏由它自己让开（外壳把阅读器的顶部安全区交给这里）：
                // 栏显示时是半透明的画布色，漫画从栏下穿过，栏一收就是整屏。
                // 6px 是顶栏自己的内边距，让位时不能把它吃掉。
                style={{
                    paddingTop: `max(${CHROME_PADDING_TOP}, env(safe-area-inset-top))`,
                }}
            >
                <Link
                    to={backTo}
                    aria-label={local ? "返回书架" : "返回章节"}
                    className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-reader-muted transition-colors hover:bg-white/10 hover:text-reader-foreground"
                >
                    <ArrowLeft className="size-4" />
                </Link>
                <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">
                        {comic?.title ?? "阅读中"}
                    </div>
                    {currentChapter && (
                        <div className="truncate text-[11px] text-reader-muted">
                            {currentChapter.title}
                            {pages.length > 0 && (
                                <>
                                    {" · "}
                                    已加载 {pages.length} 页
                                </>
                            )}
                        </div>
                    )}
                </div>
                <button
                    type="button"
                    aria-label="目录"
                    aria-haspopup="dialog"
                    aria-expanded={tocOpen}
                    disabled={chapters.length === 0}
                    onClick={() => setTocOpen(true)}
                    className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-reader-muted transition-colors hover:bg-white/10 hover:text-reader-foreground disabled:pointer-events-none disabled:opacity-40"
                >
                    <List className="size-4" />
                </button>
                <button
                    type="button"
                    aria-label={chromeFull ? "退出全屏" : "全屏"}
                    aria-pressed={chromeFull}
                    // 移动端没有窗口全屏（tao 在 Android 上是空实现），这颗按钮切的是
                    // 沉浸式阅读：隐藏系统栏，与点中带是同一个状态
                    onClick={() => (isMobile ? setImmersive((v) => !v) : void toggleFullscreen())}
                    className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-reader-muted transition-colors hover:bg-white/10 hover:text-reader-foreground"
                >
                    {chromeFull ? (
                        <Minimize className="size-4" />
                    ) : (
                        <Maximize className="size-4" />
                    )}
                </button>
            </header>

            <ChapterSheet
                open={tocOpen}
                onOpenChange={setTocOpen}
                chapters={chapters}
                currentIndex={currentChapter?.index ?? -1}
                states={downloadStates}
                onSelect={(index) => {
                    setTocOpen(false);
                    void jumpToChapter(index);
                }}
            />
        </div>
    );
}

/** 阅读器里的文字按钮（暗房底色上的描边药丸）。 */
function ReaderButton({
    onClick,
    children,
}: {
    onClick: () => void;
    children: ReactNode;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="rounded-full border border-reader-border px-4 py-1.5 text-xs text-reader-muted transition-colors hover:border-reader-foreground/40 hover:text-reader-foreground"
        >
            {children}
        </button>
    );
}

/** 阅读页图片：宽度 100%、高度自适应；加载完成前用预留高度撑住布局，避免滚动跳动。
 * 挂载范围就是预取范围，因此一律 eager——浏览器自己的 lazy 只提前约一屏，
 * 会把已经挂载好的后两屏又压回"滚到才取"。 */
function ReaderPage({
    src,
    index,
    reserved,
    autoTrim,
    onNaturalSize,
}: {
    src: string;
    index: number;
    reserved: number;
    autoTrim: boolean;
    onNaturalSize: (width: number, height: number) => void;
}) {
    const [loaded, setLoaded] = useState(false);
    const [failed, setFailed] = useState(false);
    const [retryKey, setRetryKey] = useState(0);

    return (
        <div style={{ minHeight: loaded ? undefined : reserved }}>
            <div
                className={cn("relative", !loaded && !failed && "overflow-hidden")}
                style={{ minHeight: loaded || failed ? undefined : reserved }}
            >
                {!loaded && !failed && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-white/5 text-reader-muted">
                        <Loader
                            variant="dots"
                            size={18}
                            label={`第 ${index + 1} 页加载中`}
                            className="text-reader-muted"
                        />
                        <span className="text-[11px] tabular-nums">
                            第 {index + 1} 页
                        </span>
                    </div>
                )}

                {failed ? (
                    <button
                        type="button"
                        onClick={() => {
                            setFailed(false);
                            setRetryKey((k) => k + 1);
                        }}
                        className="flex w-full flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-reader-border bg-white/5 py-10 text-reader-muted transition-colors hover:text-reader-foreground"
                        style={{ minHeight: reserved }}
                    >
                        <AlertTriangle className="size-5" />
                        <span className="text-xs">
                            第 {index + 1} 页加载失败，点击重试
                        </span>
                    </button>
                ) : (
                    <ProxyImage
                        key={retryKey}
                        src={src}
                        alt={`第 ${index + 1} 页`}
                        loading="eager"
                        onLoad={(el) => {
                            setLoaded(true);
                            if (el.naturalWidth > 0) {
                                onNaturalSize(el.naturalWidth, el.naturalHeight);
                            }
                        }}
                        onFailed={() => setFailed(true)}
                        className="block h-auto w-full"
                        style={
                            autoTrim
                                ? { width: "106%", marginLeft: "-3%", maxWidth: "none" }
                                : undefined
                        }
                    />
                )}
            </div>
        </div>
    );
}
