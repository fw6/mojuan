import { useNavigate } from "react-router-dom";
import { Compass } from "lucide-react";
import { NAV } from "../lib/nav";
import { SOURCES } from "../lib/sources";
import { CommandPalette, type CommandItem } from "./beui/command-palette";

/** ⌘K 命令面板：页面跳转、漫画源直达。 */
export function CommandMenu({
    open,
    onOpenChange,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const navigate = useNavigate();

    const items: CommandItem[] = [
        ...NAV.map((entry) => ({
            id: `nav-${entry.to}`,
            label: entry.label,
            group: "页面",
            icon: entry.icon,
            keywords: ["跳转", "页面", entry.to],
            onSelect: () => navigate(entry.to),
        })),
        ...SOURCES.map((source) => ({
            id: `source-${source.id}`,
            label: `漫画源：${source.title}`,
            group: "漫画源",
            icon: Compass,
            keywords: [source.id, "漫画源"],
            onSelect: () => navigate(`/?source=${source.id}`),
        })),
    ];

    return (
        <CommandPalette
            items={items}
            open={open}
            onOpenChange={onOpenChange}
            placeholder="搜索页面或漫画源…"
            emptyMessage="没有找到结果"
        />
    );
}
