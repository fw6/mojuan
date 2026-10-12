#!/usr/bin/env node
/**
 * 从 beui registry（https://beui.dev）拉取组件源码到本仓库，便于离线构建与升级。
 *
 * 用法：
 *   node scripts/fetch-beui.mjs            重新拉取 FILES 里的全部文件
 *   node scripts/fetch-beui.mjs --list     只列出将写入的文件
 *
 * 说明：
 *   - FILES 是 registry 侧的原始路径；组件目录 components/motion/** 落到
 *     src/components/beui/**，lib/** 落到 src/lib/**。
 *   - 写入前会去掉 "use client"（Vite 无 RSC），并把内部引用
 *     @/components/motion/ 改写成 @/components/beui/。
 *   - theme-toggle 的 next-themes 依赖已被 src/lib/theme.tsx 替换，重拉后需
 *     把该 import 改回 "@/lib/theme"（见文件内注释）。
 */

const FILES = [
    // 组件（src/components/beui/**）
    "components/motion/action-swap.tsx",
    "components/motion/animated-badge.tsx",
    "components/motion/animated-number.tsx",
    "components/motion/animated-sidebar.tsx",
    "components/motion/animated-toast-stack.tsx",
    "components/motion/bottom-sheet.tsx",
    "components/motion/button/base.tsx",
    "components/motion/button/index.tsx",
    "components/motion/button/magnetic.tsx",
    "components/motion/button/metallic.tsx",
    "components/motion/button/stateful.tsx",
    "components/motion/command-palette.tsx",
    "components/motion/expandable-action-bar.tsx",
    "components/motion/input.tsx",
    "components/motion/loader.tsx",
    "components/motion/magnetic.tsx",
    "components/motion/overflow-actions.tsx",
    "components/motion/scroll-progress.tsx",
    "components/motion/scroll-reveal.tsx",
    "components/motion/shared-layout-bg.tsx",
    "components/motion/smooth-scroll.tsx",
    "components/motion/switch.tsx",
    "components/motion/tabs.tsx",
    "components/motion/theme-toggle.tsx",
    "components/motion/tilt-card.tsx",
    // 组件依赖的内部工具（src/lib/**）
    "lib/command-search.ts",
    "lib/ease.ts",
    "lib/utils.ts",
    "lib/hooks/use-dismiss.ts",
    "lib/hooks/use-hover-capable.ts",
    "lib/hooks/use-hover-gesture.ts",
    "lib/hooks/use-on-open.ts",
    "lib/hooks/use-row-cursor.ts",
    "lib/hooks/use-tap-gesture.ts",
    "lib/hooks/use-touch-capable.ts",
    "lib/presence-gate.tsx",
    "lib/touch.ts",
];

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** registry 路径 → 本地路径。 */
function localPath(p) {
    if (p.startsWith("components/motion/")) {
        return join(ROOT, "src", "components", "beui", p.slice("components/motion/".length));
    }
    if (p.startsWith("lib/")) return join(ROOT, "src", p);
    throw new Error(`未知的 registry 路径：${p}`);
}

function transform(source) {
    return source
        .replace(/^["']use client["'];?\n+/m, "")
        .replace(/@\/components\/motion\//g, "@/components/beui/");
}

/**
 * 写入前对个别文件做适配，重跑脚本不会把这些改动冲掉：
 *   - theme-toggle 用本仓库的 lib/theme（next-themes 不引入）；
 *   - tabs 的触发按钮补键盘焦点环（上游只有 outline-none）；
 *   - bottom-sheet 的可访问名改中文（界面语言为中文）。
 */
const PATCHES = {
    "components/motion/theme-toggle.tsx": (src) =>
        src.replace('from "next-themes"', 'from "@/lib/theme"'),
    "components/motion/bottom-sheet.tsx": (src) =>
        src
            .replace('aria-label="Close bottom sheet"', 'aria-label="关闭面板"')
            .replace(
                'aria-label={title ? undefined : "Bottom sheet"}',
                'aria-label={title ? undefined : "面板"}',
            )
            // 面板标题按设计系统的区块标题档（14px/600）而不是上游的 16px
            .replace("text-base font-semibold text-foreground", "text-sm font-semibold text-foreground"),
    "components/motion/tabs.tsx": (src) =>
        src
            .replace(
                'className={cn(\n          "relative isolate px-3 pb-2.5 pt-1 -mb-px text-sm font-medium transition-colors min-h-[44px] inline-flex items-center whitespace-nowrap shrink-0",',
                'className={cn(\n          "relative isolate px-3 pb-2.5 pt-1 -mb-px text-sm font-medium transition-colors min-h-[44px] inline-flex items-center whitespace-nowrap shrink-0",\n          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",',
            )
            .replace(
                'className={cn(\n          "relative z-10 inline-flex items-center justify-center whitespace-nowrap bg-transparent px-3.5 py-1.5 text-sm font-medium outline-none",',
                'className={cn(\n          "relative z-10 inline-flex items-center justify-center whitespace-nowrap bg-transparent px-3.5 py-1.5 text-sm font-medium outline-none",\n          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",',
            ),
    // 侧边栏按本项目的设计系统改写（DESIGN.md 的 Navigation）：
    // 面板底色走 --sidebar 令牌——有窗口材质的平台（macOS vibrancy / Windows acrylic）把面板交给
    // 系统材质，其余平台该令牌等于 --background，外观不变（见 src/styles/beui.css 的 data-chrome 段）；
    // 图标位 16px，与导航项「图标 16px 加 10px 文字」对齐（上游是 20px，配 24px 的图标会撑破）；
    // 折叠轨道的宽度取 4.875rem：macOS 的红黄绿占 9..68.5（逻辑像素，实测），78px 才让它们两侧
    // 各留 9px、轨道的中心与按钮组的中心重合；折叠时把文字标签移出布局，图标才能真正居中。
    "components/motion/animated-sidebar.tsx": (src) =>
        src
            .replace(
                '"sticky top-0 flex h-svh w-full flex-col overflow-hidden bg-background"',
                '"sticky top-0 flex h-svh w-full flex-col overflow-hidden bg-sidebar"',
            )
            .replace(
                '"relative z-10 grid size-5 shrink-0 place-items-center"',
                '"relative z-10 grid size-4 shrink-0 place-items-center"',
            )
            .replace('"--sidebar-width-icon": "4.25rem",', '"--sidebar-width-icon": "4.875rem",')
            .replace(
                'panel.collapsed && "pointer-events-none",',
                'panel.collapsed && "hidden",',
            ),
};

async function collect() {
    const index = await (await fetch("https://beui.dev/r")).json();
    const wanted = new Set(FILES);
    const found = new Map();
    const entries = await Promise.all(
        index.components.map(async (c) => {
            try {
                return await (await fetch(`https://beui.dev/r/${c.slug}`)).json();
            } catch {
                return null;
            }
        }),
    );
    for (const entry of entries) {
        for (const file of entry?.files ?? []) {
            const path = file.path ?? file.target;
            if (wanted.has(path) && file.content) found.set(path, file.content);
        }
    }
    return found;
}

const found = await collect();
const missing = FILES.filter((p) => !found.has(p));

if (process.argv.includes("--list")) {
    console.log(FILES.join("\n"));
    console.log(`\n共 ${FILES.length} 个文件，registry 命中 ${found.size} 个`);
} else {
    for (const [path, content] of found) {
        const target = localPath(path);
        const patched = (PATCHES[path] ?? ((s) => s))(transform(content));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, patched);
    }
    console.log(`写入 ${found.size} 个文件`);
}

if (missing.length > 0) {
    console.error(`registry 未提供：\n  ${missing.join("\n  ")}`);
    process.exitCode = 1;
}
