import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
    type ReactNode,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getSettings, setSettings } from "./storage/settings";
import { windowChrome } from "./chrome";

/** 主题写入 html[data-theme]，beui.css 的深浅两套令牌由此切换。
 *  有窗口材质的平台还要把窗口外观一起改掉：系统材质（vibrancy / acrylic）按窗口外观取明暗，
 *  只改界面不改窗口的话，深色界面会配上一块浅色材质（见 src-tauri/tauri.*.conf.json）。 */
export function applyTheme(dark: boolean): void {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    if (windowChrome() === "none") return;
    void getCurrentWindow()
        .setTheme(dark ? "dark" : "light")
        .catch((err) => console.error("setTheme failed", err));
}

interface ThemeContextValue {
    isDark: boolean;
    setDark: (dark: boolean) => void;
    toggle: () => void;
    /** 设置读取完成前为 false（beui 的 ThemeToggle 用它避免首帧图标闪烁）。 */
    ready: boolean;
    /** next-themes 形状的取值，供 beui 组件直接使用。 */
    resolvedTheme: "dark" | "light";
    setTheme: (theme: "dark" | "light") => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
    const [isDark, setIsDark] = useState(false);
    const [ready, setReady] = useState(false);

    useEffect(() => {
        void getSettings().then((s) => {
            setIsDark(s.darkMode);
            applyTheme(s.darkMode);
            setReady(true);
        });
    }, []);

    const setDark = useCallback((dark: boolean) => {
        setIsDark(dark);
        applyTheme(dark);
        void setSettings({ darkMode: dark });
    }, []);

    const toggle = useCallback(() => setDark(!isDark), [isDark, setDark]);

    const value = useMemo<ThemeContextValue>(
        () => ({
            isDark,
            setDark,
            toggle,
            ready,
            resolvedTheme: isDark ? "dark" : "light",
            setTheme: (theme) => setDark(theme === "dark"),
        }),
        [isDark, ready, setDark, toggle],
    );

    return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
    const ctx = useContext(ThemeContext);
    if (!ctx) throw new Error("useTheme 必须在 ThemeProvider 内使用");
    return ctx;
}
