import { useEffect, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, PanelLeft, Search } from "lucide-react";
import { mojuanVersion } from "../api";
import { windowChrome } from "../lib/chrome";
import { cn } from "../lib/utils";
import { NAV, type NavEntry } from "../lib/nav";
import { Button } from "./beui/button";
import { OverflowActions } from "./beui/overflow-actions";
import {
    AnimatedSidebar,
    AnimatedSidebarContent,
    AnimatedSidebarFooter,
    AnimatedSidebarHeader,
    AnimatedSidebarInset,
    AnimatedSidebarMenu,
    AnimatedSidebarMenuButton,
    AnimatedSidebarMenuItem,
    AnimatedSidebarProvider,
    AnimatedSidebarTrigger,
    useAnimatedSidebar,
} from "./beui/animated-sidebar";
import { CommandMenu } from "./command-menu";

/** 阅读器/本地阅读：全屏沉浸，不渲染任何导航。 */
function isImmersive(pathname: string): boolean {
    return pathname.startsWith("/reader") || pathname.startsWith("/local");
}

function pageTitle(pathname: string): string {
    if (pathname === "/") return "发现";
    if (pathname.startsWith("/library")) return "书架";
    if (pathname.startsWith("/downloads")) return "下载";
    if (pathname.startsWith("/settings")) return "设置";
    if (pathname.startsWith("/comic/")) return "作品详情";
    return "墨卷";
}

function isActivePath(pathname: string, entry: NavEntry): boolean {
    return entry.end ? pathname === entry.to : pathname.startsWith(entry.to);
}

export function AppShell({ children }: { children: ReactNode }) {
    const location = useLocation();
    const [version, setVersion] = useState("");
    const [menuOpen, setMenuOpen] = useState(false);

    useEffect(() => {
        void mojuanVersion()
            .then(setVersion)
            .catch(() => {});
    }, []);

    // 沉浸模式（阅读器/本地阅读）只摘掉导航壳：页面区保持在树里的同一位置，
    // 保留的页面不被卸载。滚动容器由每个页面自己提供（见 KeepAliveRoutes）。
    const immersive = isImmersive(location.pathname);
    const isRootTab = NAV.some((n) => isActivePath(location.pathname, n));
    // 二级页面（作品详情这类）没有底部导航栏，退出靠顶部栏的返回
    const subpage = !immersive && !isRootTab;

    return (
        <AnimatedSidebarProvider className="h-full">
            {/* macOS 的标题栏让给了界面（titleBarStyle: Overlay），系统不再提供拖拽区，
                所以自己铺一条：整窗宽、28px 高，正好是红黄绿那一行。
                红黄绿是原生按钮、在 webview 之上，落在这一条里仍然点得到。 */}
            {!immersive && windowChrome() === "macos" ? (
                <div data-tauri-drag-region className="fixed inset-x-0 top-0 z-20 h-7" />
            ) : null}

            {immersive ? null : (
                <AnimatedSidebar ariaLabel="主导航">
                    <SidebarContent
                        version={version}
                        pathname={location.pathname}
                        onOpenMenu={() => setMenuOpen(true)}
                    />
                </AnimatedSidebar>
            )}

            {/* 状态栏高度：主导航页面不再有顶部栏，内容仍要给系统状态栏让位 */}
            <AnimatedSidebarInset
                className="h-full min-h-0"
                style={{
                    paddingTop: "env(safe-area-inset-top)",
                    // 底部安全区：有导航栏时栏自己让，二级页面没有栏，由外壳让出
                    ...(subpage
                        ? { paddingBottom: "env(safe-area-inset-bottom)" }
                        : {}),
                }}
            >
                {immersive || isRootTab ? null : (
                    <TopBar
                        title={pageTitle(location.pathname)}
                        onOpenMenu={() => setMenuOpen(true)}
                    />
                )}

                <div className="relative flex min-h-0 flex-1 flex-col">
                    {children}
                </div>

                {isRootTab ? <NavRail pathname={location.pathname} /> : null}
            </AnimatedSidebarInset>

            <CommandMenu open={menuOpen} onOpenChange={setMenuOpen} />
        </AnimatedSidebarProvider>
    );
}

/* ---------- 桌面侧边栏 ---------- */

function SidebarContent({
    version,
    pathname,
    onOpenMenu,
}: {
    version: string;
    pathname: string;
    onOpenMenu: () => void;
}) {
    const { open } = useAnimatedSidebar();
    return (
        <>
            <AnimatedSidebarHeader
                className={cn(
                    "gap-2 p-2.5",
                    // 展开时一行：[标记][名称][收起按钮]，标记的左边缘与导航项的图标同一列（20px）；
                    // 折叠成图标轨道时改成一列居中：标记下面就是展开按钮，轨道里才有入口
                    open ? "flex-row items-center pl-5" : "flex-col items-center",
                    // macOS 的红黄绿浮在 webview 上（titleBarStyle: Overlay），
                    // 侧边栏顶部要让出这一条，品牌行才不压在按钮底下
                    windowChrome() === "macos" && "pt-9.5",
                )}
            >
                {/* 品牌标记就是应用图标本身，放在纸色方块上：标记是墨与纸，纸不能随主题走，
                    否则深色底上纸色的脸会盖过墨（见 DESIGN.md 的 App Icon）。 */}
                <img
                    src="/app-icon.svg"
                    alt=""
                    className="size-9 shrink-0 rounded-xl bg-paper"
                />
                <div
                    className={cn(
                        "min-w-0 flex-1 overflow-hidden transition-opacity duration-200",
                        // 折叠时移出布局：留着宽度会把标记和按钮挤偏，居中就落不到轨道中心
                        open ? "opacity-100" : "hidden",
                    )}
                >
                    <div className="truncate text-sm font-semibold leading-tight">
                        墨卷
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">
                        漫画阅读器
                    </div>
                </div>
                <AnimatedSidebarTrigger
                    aria-label="收起/展开侧边栏"
                    className={cn(
                        // 折叠后这是轨道里唯一的开关，按 DESIGN.md 的 Ghost 给一个悬停底色，
                        // 否则一个只有描边没有底色的图标看起来不像是能点的
                        "text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                        open && "ml-auto",
                    )}
                >
                    <PanelLeft className="size-4" />
                </AnimatedSidebarTrigger>
            </AnimatedSidebarHeader>

            <AnimatedSidebarContent>
                <AnimatedSidebarMenu>
                    {NAV.map((entry) => (
                        <AnimatedSidebarMenuItem key={entry.to}>
                            <AnimatedSidebarMenuButton
                                // lucide 默认 24px，会撑破侧边栏 16px 的图标位并压低 2px（DESIGN.md 的 Navigation）
                                icon={<entry.icon className="size-4" />}
                                href={`#${entry.to}`}
                                isActive={isActivePath(pathname, entry)}
                                // 折叠轨道里只有图标，居中落在轨道中心（与红黄绿同一轴）
                                className={cn(!open && "justify-center")}
                            >
                                {entry.label}
                            </AnimatedSidebarMenuButton>
                        </AnimatedSidebarMenuItem>
                    ))}
                </AnimatedSidebarMenu>
            </AnimatedSidebarContent>

            <AnimatedSidebarFooter>
                <button
                    type="button"
                    onClick={onOpenMenu}
                    className={cn(
                        "flex items-center gap-2 rounded-xl border border-border bg-background px-2.5 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground",
                        open ? "justify-between" : "justify-center",
                    )}
                >
                    <Search className="size-3.5 shrink-0" />
                    {open && (
                        <>
                            <span className="flex-1 text-left">快速跳转</span>
                            <kbd className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px]">
                                ⌘K
                            </kbd>
                        </>
                    )}
                </button>

                {open && (
                    <span className="truncate text-[11px] text-muted-foreground">
                        版本 <code className="font-mono">{version || "…"}</code>
                    </span>
                )}
            </AnimatedSidebarFooter>
        </>
    );
}

/* ---------- 子页面顶部栏（主导航页面不渲染） ---------- */

function TopBar({ title, onOpenMenu }: { title: string; onOpenMenu: () => void }) {
    const navigate = useNavigate();
    return (
        <header className="flex items-center gap-1.5 border-b border-border bg-background px-2 py-1.5 md:hidden">
            <Button
                variant="ghost"
                size="icon"
                aria-label="返回"
                onClick={() => navigate(-1)}
            >
                <ArrowLeft className="size-4" />
            </Button>
            <div className="min-w-0 flex-1 truncate px-1 text-sm font-medium">
                {title}
            </div>
            <Button
                variant="ghost"
                size="icon"
                aria-label="快速跳转"
                onClick={onOpenMenu}
            >
                <Search className="size-4" />
            </Button>
        </header>
    );
}

/* ---------- 移动端底部导航 ---------- */

/** 常驻栏里的入口，其余主导航页面收进「…」展开的溢出组。 */
const RAIL_PRIMARY = ["/", "/library"];
const RAIL_OVERFLOW = ["/downloads", "/settings"];

function NavRail({ pathname }: { pathname: string }) {
    const navigate = useNavigate();
    const [expanded, setExpanded] = useState(false);

    // 当前页落在溢出组里（下载/设置）时展开，让当前项显示出来；换页时回到折叠态，
    // 用户自己点开的展开状态不受影响（这条只在路由变化时跑）。
    const overflowActive = NAV.some(
        (n) => RAIL_OVERFLOW.includes(n.to) && isActivePath(pathname, n),
    );
    useEffect(() => {
        setExpanded(overflowActive);
    }, [overflowActive, pathname]);

    const railItem = (entry: NavEntry) => {
        const active = isActivePath(pathname, entry);
        const Icon = entry.icon;
        return {
            id: entry.to,
            label: (
                <span className={active ? "text-primary" : "text-muted-foreground"}>
                    {entry.label}
                </span>
            ),
            icon: (
                <Icon
                    className={cn(
                        "size-4",
                        active ? "text-primary" : "text-muted-foreground",
                    )}
                />
            ),
            onClick: () => navigate(entry.to),
        };
    };

    return (
        <div className="flex shrink-0 justify-center px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1 md:hidden">
            <OverflowActions
                primaryActions={NAV.filter((n) => RAIL_PRIMARY.includes(n.to)).map(
                    railItem,
                )}
                overflowActions={NAV.filter((n) =>
                    RAIL_OVERFLOW.includes(n.to),
                ).map(railItem)}
                expanded={expanded}
                onExpandedChange={setExpanded}
                openLabel="展开其他页面"
                closeLabel="收起其他页面"
                classNames={{
                    track: "gap-1 p-1",
                    action: "h-11 min-w-11 gap-1.5 px-2.5 text-xs",
                    toggle:
                        "h-11 w-11 bg-secondary text-muted-foreground hover:text-foreground",
                    icon: "size-4",
                }}
            />
        </div>
    );
}
