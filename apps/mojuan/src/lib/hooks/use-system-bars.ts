import { useEffect } from "react";
import { setSystemBars } from "../../api";
import { useIsMobile } from "../platform";

/**
 * 阅读器的系统栏（状态栏与导航栏）：把沉浸式状态交给原生侧。
 *
 * 阅读画布是暗房，所以栏内图标一律取浅色——浅色主题下系统的深色图标落在黑底上看不见。
 * 离开阅读器时按当前主题还原，否则浅色图标会被带到浅底的页面上。
 *
 * 桌面端不调用：桌面窗口没有系统栏（命令在两端都注册，这里只是省掉一次无意义的往返）。
 * 平台判定用窄屏断点，与阅读区的三分带同一个口径。
 */
export function useSystemBars(hidden: boolean): void {
    const isMobile = useIsMobile();

    useEffect(() => {
        if (!isMobile) return;
        let cancelled = false;
        void setSystemBars({ hidden, lightIcons: true }).catch((err) => {
            if (!cancelled) console.error("setSystemBars failed", err);
        });
        return () => {
            cancelled = true;
        };
    }, [isMobile, hidden]);

    // 离开阅读器：系统栏重新显示，图标明暗交还给主题。
    // 单独一个 effect（依赖里没有 hidden）：切沉浸式不该顺带还原一次。
    useEffect(() => {
        if (!isMobile) return;
        return () => {
            const lightIcons = document.documentElement.dataset.theme === "dark";
            void setSystemBars({ hidden: false, lightIcons }).catch((err) =>
                console.error("setSystemBars failed", err),
            );
        };
    }, [isMobile]);
}
