import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { motion } from "motion/react";
import { Inbox, TriangleAlert } from "lucide-react";
import { imgSrc, type Comic } from "../api";
import { cn } from "../lib/utils";
import { useScrollContainerRef } from "../lib/scroll-container";
import { Loader } from "./beui/loader";
import { ScrollReveal } from "./beui/scroll-reveal";
import { TiltCard } from "./beui/tilt-card";
import { ButtonLink, type ButtonSize, type ButtonVariant } from "./beui/button";

/**
 * 共享界面原语：封面、卡片、列表行、空状态、进度条、面板。
 * 样式取自 beui 设计系统（语义化颜色令牌 + 圆角 + 弹簧动效）。
 */

/* ---------- 页面标题 ---------- */

/**
 * 页头：当前页已由导航标出，顶部不再重复写一遍页面名，
 * 视觉上只留一行副标题与右侧动作，标题留给读屏。
 */
export function PageHeader({
    title,
    sub,
    actions,
}: {
    title: string;
    sub?: string;
    actions?: ReactNode;
}) {
    return (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h1 className="sr-only">{title}</h1>
            {sub && <p className="text-sm text-muted-foreground">{sub}</p>}
            {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
    );
}

/* ---------- 封面（骨架 + 失败回退） ---------- */

export function Cover({
    src,
    alt,
    className,
    aspect = "2 / 3",
}: {
    src: string;
    alt: string;
    className?: string;
    aspect?: string;
}) {
    const [state, setState] = useState<"loading" | "loaded" | "error">("loading");
    return (
        <div
            className={cn(
                "relative overflow-hidden rounded-lg border border-border bg-muted",
                className,
            )}
            style={{ aspectRatio: aspect }}
        >
            {state === "loading" && (
                <div className="absolute inset-0 animate-pulse bg-gradient-to-br from-muted to-secondary" />
            )}
            {state === "error" ? (
                <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-secondary to-card">
                    <span className="text-2xl font-semibold text-muted-foreground">
                        {alt.trim().charAt(0) || "C"}
                    </span>
                </div>
            ) : (
                <img
                    src={src}
                    alt={alt}
                    loading="lazy"
                    decoding="async"
                    onLoad={() => setState("loaded")}
                    onError={() => setState("error")}
                    className={cn(
                        "h-full w-full object-cover transition-opacity duration-500 ease-out",
                        state === "loaded" ? "opacity-100" : "opacity-0",
                    )}
                />
            )}
        </div>
    );
}

/* ---------- 进入动效（滚动到视口时显示，网格/列表项共用） ---------- */

export function Reveal({
    children,
    delay = 0,
    className,
}: {
    children: ReactNode;
    delay?: number;
    className?: string;
}) {
    const root = useScrollContainerRef();
    return (
        <ScrollReveal
            y={12}
            blur={6}
            duration={0.42}
            delay={Math.min(delay, 0.24)}
            amount={0.15}
            root={root ?? undefined}
            className={className}
        >
            {children}
        </ScrollReveal>
    );
}

/* ---------- 漫画网格卡片（桌面） ---------- */

export function ComicCard({ comic, delay }: { comic: Comic; delay?: number }) {
    return (
        <Reveal delay={delay ? Math.min(delay / 1000, 0.32) : 0}>
            <Link
                to={`/comic/${comic.source}/${encodeURIComponent(comic.id)}`}
                className="group block"
            >
                <TiltCard className="border border-border transition-shadow duration-300 group-hover:shadow-lg">
                    <Cover src={imgSrc(comic.cover)} alt={comic.title} />
                </TiltCard>
                <div className="mt-2 px-0.5">
                    <div className="line-clamp-2 text-sm font-medium leading-snug text-foreground">
                        {comic.title}
                    </div>
                    <div className="mt-0.5 truncate text-xs text-muted-foreground">
                        {comic.author || "未知作者"}
                    </div>
                </div>
            </Link>
        </Reveal>
    );
}

/* ---------- 漫画列表行（移动端） ---------- */

export function ComicRow({
    to,
    cover,
    title,
    subtitle,
    meta,
    tags,
    chapterTag,
    delay,
    badge,
}: {
    to: string;
    cover: string;
    title: string;
    subtitle?: string;
    meta?: string;
    tags?: string[];
    chapterTag?: string;
    delay?: number;
    badge?: ReactNode;
}) {
    return (
        <Reveal delay={delay ? Math.min(delay / 1000, 0.32) : 0}>
            <Link
                to={to}
                className="flex items-center gap-3 rounded-lg border border-border bg-card p-2.5 transition-colors hover:bg-secondary/60"
            >
                <Cover
                    src={imgSrc(cover)}
                    alt={title}
                    className="w-14 shrink-0 rounded-lg"
                />
                <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-foreground">
                        {title}
                    </div>
                    {subtitle && (
                        <div className="truncate text-xs text-muted-foreground">
                            {subtitle}
                        </div>
                    )}
                    {meta && (
                        <div className="mt-0.5 truncate text-xs text-muted-foreground">
                            {meta}
                        </div>
                    )}
                    {(tags?.length || chapterTag) && (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                            {tags?.slice(0, 3).map((t) => (
                                <Tag key={t}>{t}</Tag>
                            ))}
                            {chapterTag && <Tag tone="accent">#{chapterTag}</Tag>}
                        </div>
                    )}
                </div>
                {badge}
            </Link>
        </Reveal>
    );
}

/* ---------- 标签 ---------- */

export function Tag({
    children,
    tone = "neutral",
}: {
    children: ReactNode;
    tone?: "neutral" | "accent" | "primary";
}) {
    return (
        <span
            className={cn(
                "inline-flex h-5 items-center rounded-full px-2 text-[11px] font-medium text-foreground",
                tone === "accent" && "bg-accent/25",
                tone === "primary" && "bg-primary/12 text-primary",
                tone === "neutral" && "bg-muted text-muted-foreground",
            )}
        >
            {children}
        </span>
    );
}

/* ---------- 空状态 ---------- */

export function EmptyState({
    text,
    hint,
    icon,
    action,
}: {
    text: string;
    hint?: string;
    icon?: ReactNode;
    action?: ReactNode;
}) {
    return (
        <div className="flex flex-col items-center justify-center rounded-3xl border border-dashed border-border bg-card/40 px-6 py-14 text-center">
            <span className="text-muted-foreground opacity-70">
                {icon ?? <Inbox className="size-7" />}
            </span>
            <p className="mt-3 text-sm font-medium text-foreground">{text}</p>
            {hint && (
                <p className="mt-1 max-w-xs text-xs leading-5 text-muted-foreground">
                    {hint}
                </p>
            )}
            {action && <div className="mt-4">{action}</div>}
        </div>
    );
}

/* ---------- 错误横幅 ---------- */

export function Banner({ children }: { children: ReactNode }) {
    return (
        <div className="mb-4 flex items-start gap-2.5 rounded-2xl border border-destructive/25 bg-destructive/8 px-4 py-3 text-sm text-foreground">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="min-w-0">{children}</div>
        </div>
    );
}

/* ---------- 加载 ---------- */

export function Loading({ label = "加载中" }: { label?: string }) {
    return (
        <div className="flex flex-col items-center justify-center gap-3 py-16">
            <Loader variant="comet" size={28} label={label} />
            <span className="text-xs text-muted-foreground">{label}</span>
        </div>
    );
}

/* ---------- 进度条 ---------- */

export function ProgressBar({ pct, done }: { pct: number; done?: boolean }) {
    const value = Math.max(0, Math.min(100, pct));
    return (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <motion.div
                className={cn(
                    "h-full rounded-full",
                    done ? "bg-success" : "bg-primary",
                )}
                initial={false}
                animate={{ width: `${value}%` }}
                transition={{ type: "spring", stiffness: 260, damping: 30 }}
            />
        </div>
    );
}

/* ---------- 面板 ---------- */

export function Panel({
    title,
    desc,
    actions,
    children,
    className,
}: {
    title?: string;
    desc?: string;
    actions?: ReactNode;
    children: ReactNode;
    className?: string;
}) {
    return (
        <section
            className={cn(
                "rounded-3xl border border-border bg-card p-5",
                className,
            )}
        >
            {(title || actions) && (
                <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
                    <div>
                        {title && (
                            <h2 className="text-sm font-semibold text-foreground">
                                {title}
                            </h2>
                        )}
                        {desc && (
                            <p className="mt-1 text-xs text-muted-foreground">{desc}</p>
                        )}
                    </div>
                    {actions && (
                        <div className="flex items-center gap-2">{actions}</div>
                    )}
                </header>
            )}
            {children}
        </section>
    );
}

/* ---------- 行内设置项 ---------- */

export function SettingRow({
    label,
    hint,
    children,
}: {
    label: string;
    hint?: string;
    children: ReactNode;
}) {
    return (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border py-3 first:border-t-0 first:pt-0">
            <div className="min-w-0">
                <div className="text-sm font-medium text-foreground">{label}</div>
                {hint && (
                    <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>
                )}
            </div>
            <div className="flex flex-wrap items-center gap-2">{children}</div>
        </div>
    );
}

/* ---------- 带按钮外观的路由链接 ---------- */

export function LinkButton({
    to,
    variant = "primary",
    size = "md",
    className,
    children,
}: {
    to: string;
    variant?: ButtonVariant;
    size?: ButtonSize;
    className?: string;
    children: ReactNode;
}) {
    // HashRouter 下用锚点等价于路由跳转，同时拿到 Button 的弹簧交互
    return (
        <ButtonLink href={`#${to}`} variant={variant} size={size} className={className}>
            {children}
        </ButtonLink>
    );
}
