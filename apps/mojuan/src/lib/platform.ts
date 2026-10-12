import { useEffect, useState } from "react";

/** 移动端断点：与 Tailwind 的 md（768px）以及 beui 侧边栏的 MOBILE_QUERY 一致。 */
const MOBILE_QUERY = "(max-width: 767px)";

/**
 * 是否窄屏（移动端）布局。用 matchMedia 监听，桌面窗口缩放也会实时切换
 * （桌面「网格卡片」↔ 移动端「列表行」的 DOM 不同，需 JS 侧决定）。
 */
export function useIsMobile(): boolean {
    const [mobile, setMobile] = useState(() => {
        if (typeof window === "undefined") return false;
        if (typeof window.matchMedia === "function") {
            return window.matchMedia(MOBILE_QUERY).matches;
        }
        // jsdom 等环境没有 matchMedia：退回视口宽度判断
        return window.innerWidth <= 767;
    });
    useEffect(() => {
        if (typeof window.matchMedia !== "function") return;
        const mq = window.matchMedia(MOBILE_QUERY);
        const onChange = (e: MediaQueryListEvent) => setMobile(e.matches);
        mq.addEventListener("change", onChange);
        return () => mq.removeEventListener("change", onChange);
    }, []);
    return mobile;
}
