import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
    Route,
    Routes,
    matchPath,
    useLocation,
    type Location,
} from "react-router-dom";
import { ScrollContainerContext } from "../lib/scroll-container";
import { cn } from "../lib/utils";

/**
 * 页面保留（等价于 Vue 的 <KeepAlive />）：离开的页面留在 DOM 里（display: none），
 * 返回时组件状态与滚动位置一并还原。阅读器这类自带滚动的页面由路由表决定是否保留。
 *
 * 保留策略写在 pages 表的 keep 字段里；这里只管实例的取舍、隐藏与滚动位置记忆。
 */
export interface PageRoute {
    /** 路由路径，语法同 react-router。 */
    path: string;
    /** 页面元素（模块级常量，实例被保留时不重建）。 */
    element: ReactNode;
    /** 保留的实例数：同一条路由按最近使用淘汰，0 表示离开即卸载。 */
    keep: number;
    /** false 表示页面自带滚动容器（阅读器），外层不再套一层滚动。 */
    scroll?: boolean;
}

interface PageEntry {
    /** 缓存键：完整路径——同一路由的不同参数各占一个实例。 */
    key: string;
    route: PageRoute;
    /** 冻结的路由位置：页面内的 useParams / useSearchParams 读到的仍是它自己那次导航。 */
    location: Location;
}

export function KeepAliveRoutes({ pages }: { pages: PageRoute[] }) {
    const location = useLocation();
    const [entries, setEntries] = useState<PageEntry[]>([]);
    const [shownKey, setShownKey] = useState<string | null>(null);

    const route = findRoute(pages, location.pathname);
    const activeKey = route ? location.pathname : null;

    if (activeKey !== shownKey) {
        // 渲染期同步缓存表：新页面与这次导航落在同一批提交里，不经过空白帧。
        setShownKey(activeKey);
        setEntries((prev) =>
            nextEntries(
                prev,
                route && activeKey
                    ? { key: activeKey, route, location }
                    : null,
            ),
        );
    }

    return (
        <>
            {entries.map((entry) => (
                <PageSlot
                    key={entry.key}
                    entry={entry}
                    active={entry.key === activeKey}
                />
            ))}
        </>
    );
}

function findRoute(pages: PageRoute[], pathname: string): PageRoute | null {
    return (
        pages.find((page) =>
            matchPath({ path: page.path, end: true }, pathname),
        ) ?? null
    );
}

/** 重算保留的页面：丢掉离开即弃的与超出上限的（数组尾部最近使用）。 */
function nextEntries(
    prev: PageEntry[],
    active: PageEntry | null,
): PageEntry[] {
    const kept = prev.filter(
        (e) => e.key !== active?.key && e.route.keep > 0,
    );
    const list = active ? [...kept, active] : kept;
    const used = new Map<PageRoute, number>();
    const out: PageEntry[] = [];
    for (let i = list.length - 1; i >= 0; i--) {
        const entry = list[i];
        const count = used.get(entry.route) ?? 0;
        // 当前页一定留下（keep: 0 的路由也照常显示），超出的才按最近使用淘汰
        if (entry !== active && count >= entry.route.keep) continue;
        used.set(entry.route, count + 1);
        out.push(entry);
    }
    return out.reverse();
}

/**
 * 一个页面的槽位：常驻的包装元素（滚动容器）+ 该页自己的路由上下文。
 * 非当前页用 display: none 藏起来——状态与 DOM 都留着，同时移出无障碍树与 Tab 顺序。
 */
function PageSlot({ entry, active }: { entry: PageEntry; active: boolean }) {
    const scrollRef = useRef<HTMLDivElement>(null);
    // 最近一次的滚动位置：隐藏后元素量不到真实位置，只能在还看得见的时候记录
    const lastScroll = useRef(0);
    const shown = useRef(active);

    if (shown.current && !active) {
        // 这一帧页面还看得见（React 尚未提交隐藏），就地读一次：浏览器会把
        // 隐藏元素的滚动位置归零，滚动过程中没来得及派发的 scroll 也就没法补记。
        const el = scrollRef.current;
        if (el) lastScroll.current = el.scrollTop;
    }
    shown.current = active;

    useLayoutEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        const remember = () => {
            if (shown.current) lastScroll.current = el.scrollTop;
        };
        el.addEventListener("scroll", remember, { passive: true });
        return () => el.removeEventListener("scroll", remember);
    }, []);

    // 重新显示时回到离开前的位置。DOM 一直保留，通常直接赋值就够；页面内容在
    // 显示的那一帧还没铺满时（数据在 effect 里重取会先变矮），浏览器把位置夹回 0，
    // 这种情况在随后的帧里补一次，直到位置站得住、或用户自己动了手。
    useLayoutEffect(() => {
        if (!active) return;
        const el = scrollRef.current;
        if (!el) return;
        const want = lastScroll.current;
        el.scrollTop = want;
        if (want === 0 || el.scrollTop === want) return;
        let raf = 0;
        let frames = 0;
        const retry = () => {
            const node = scrollRef.current;
            if (!node || node.scrollTop !== 0) return;
            node.scrollTop = want;
            if (node.scrollTop === want || ++frames >= 30) return;
            raf = requestAnimationFrame(retry);
        };
        raf = requestAnimationFrame(retry);
        return () => cancelAnimationFrame(raf);
    }, [active]);

    const scrollable = entry.route.scroll !== false;

    return (
        <div
            ref={scrollRef}
            data-page={entry.key}
            style={active ? undefined : { display: "none" }}
            className={cn(
                "min-h-0 flex-1",
                scrollable ? "overflow-y-auto" : "flex flex-col overflow-hidden",
            )}
        >
            <ScrollContainerContext.Provider value={scrollRef}>
                <Routes location={entry.location}>
                    <Route path={entry.route.path} element={entry.route.element} />
                </Routes>
            </ScrollContainerContext.Provider>
        </div>
    );
}
