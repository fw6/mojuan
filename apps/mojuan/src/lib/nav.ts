import { Compass, Download, Library, Settings, type LucideIcon } from "lucide-react";

export interface NavEntry {
    to: string;
    label: string;
    icon: LucideIcon;
    end: boolean;
}

/** 主导航（桌面侧边栏与移动端底部栏共用）。 */
export const NAV: NavEntry[] = [
    { to: "/", label: "发现", icon: Compass, end: true },
    { to: "/library", label: "书架", icon: Library, end: false },
    { to: "/downloads", label: "下载", icon: Download, end: false },
    { to: "/settings", label: "设置", icon: Settings, end: false },
];
