import { useEffect } from "react";
import { HashRouter } from "react-router-dom";
import Sources from "./screens/Sources";
import Detail from "./screens/Detail";
import Reader from "./screens/Reader";
import Library from "./screens/Library";
import Settings from "./screens/Settings";
import Downloads from "./screens/Downloads";
import { hydrateSourceCaches, whenSourcesReady } from "./lib/storage/sources";
import { ThemeProvider } from "./lib/theme";
import { ToastProvider } from "./components/toast";
import { AppShell } from "./components/shell";
import { KeepAliveRoutes, type PageRoute } from "./components/keep-alive";

/** 路由表：页面 + 保留策略（离开后按完整路径保留的实例数，0 = 离开即卸载）。 */
const PAGES: PageRoute[] = [
    { path: "/", element: <Sources />, keep: 1 },
    { path: "/library", element: <Library />, keep: 1 },
    { path: "/downloads", element: <Downloads />, keep: 1 },
    { path: "/settings", element: <Settings />, keep: 1 },
    // 详情页保留最近打开的几部：返回时章节列表与滚动位置都还在
    { path: "/comic/:source/:comicId", element: <Detail />, keep: 5 },
    // 阅读器图片与虚拟列表占用大，离开即释放
    {
        path: "/reader/:source/:comicId/:chapterIndex",
        element: <Reader />,
        keep: 0,
        scroll: false,
    },
    {
        path: "/local/:source/:comicId/:chapterIndex",
        element: <Reader local />,
        keep: 0,
        scroll: false,
    },
];

export default function App() {
    useEffect(() => {
        // 源脚本注册（#16/#17：首启种子 / dev 磁盘覆盖 → 同步 Rust registry）；
        // 取数方经 whenSourcesReady 等它完成
        void whenSourcesReady();
        // 源进程内缓存的持久化回灌（grilling #6 存储域）
        void hydrateSourceCaches();
    }, []);

    return (
        <ThemeProvider>
            <HashRouter>
                <ToastProvider>
                    <AppShell>
                        <KeepAliveRoutes pages={PAGES} />
                    </AppShell>
                </ToastProvider>
            </HashRouter>
        </ThemeProvider>
    );
}
