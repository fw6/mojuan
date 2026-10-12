import { useCallback, useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { AnimatePresence, motion } from "motion/react";
import { ChevronDown, Download, RotateCcw, Trash2 } from "lucide-react";
import {
    cancelDownload,
    clearDownloads,
    getDownloads,
    retryDownload,
    subscribeDownloads,
    unsubscribeDownloads,
    type DownloadProgress,
    type DownloadStatus,
    type DownloadTaskView,
} from "../api";
import {
    donePercent,
    groupDownloads,
    type DownloadGroup,
} from "../lib/downloads";
import { EASE_OUT, SPRING_PANEL } from "../lib/ease";
import { sourceTitle } from "../lib/sources";
import { cn } from "../lib/utils";
import {
    EmptyState,
    Loading,
    PageHeader,
    ProgressBar,
    Tag,
} from "../components/ui";
import { Button } from "../components/beui/button";
import {
    AnimatedBadge,
    type AnimatedBadgeStatus,
} from "../components/beui/animated-badge";
import { AnimatedNumber } from "../components/beui/animated-number";

const STATUS_LABEL: Record<DownloadStatus, string> = {
    queued: "排队中",
    downloading: "下载中",
    done: "已完成",
    failed: "失败",
    cancelled: "已取消",
};

const STATUS_BADGE: Record<DownloadStatus, AnimatedBadgeStatus> = {
    queued: "neutral",
    downloading: "loading",
    done: "success",
    failed: "danger",
    cancelled: "warning",
};

/** 完成/取消两态在浅色主题下要用本仓库的语义色（beui 原生的 emerald/amber 偏亮）。 */
const STATUS_BADGE_CLASS: Record<DownloadStatus, string> = {
    queued: "",
    downloading: "",
    done: "text-success",
    failed: "",
    cancelled: "text-warning",
};

/** 下载任务队列页（wayfinder #20/#23）：按漫画分组展示，展开看单章节进度。 */
export default function Downloads() {
    const [tasks, setTasks] = useState<DownloadTaskView[] | null>(null);
    // 已见过的任务 id：进度事件只在快照里已有的任务上原地更新；出现没见过的任务
    // （别处刚入队）就重取一次快照补齐。页面被保留（KeepAlive）时不会重新挂载，
    // 只靠初始快照会把新任务漏掉。
    const knownIds = useRef<Set<string>>(new Set());

    // 订阅进度（Channel 存 Rust State，worker 推送；卸载时退订清理，grilling #23 #6）
    useEffect(() => {
        const channel = new Channel<DownloadProgress>();
        channel.onmessage = (p) => {
            if (!knownIds.current.has(p.taskId)) {
                void getDownloads().then((list) => {
                    knownIds.current = new Set(list.map((t) => t.taskId));
                    setTasks(list);
                });
                return;
            }
            setTasks((prev) =>
                prev?.map((t) => (t.taskId === p.taskId ? { ...t, ...p } : t)) ??
                null,
            );
        };
        void subscribeDownloads(channel);
        void getDownloads().then((list) => {
            knownIds.current = new Set(list.map((t) => t.taskId));
            setTasks(list);
        });
        return () => {
            void unsubscribeDownloads();
        };
    }, []);

    const refresh = useCallback(() => {
        void getDownloads().then((list) => {
            knownIds.current = new Set(list.map((t) => t.taskId));
            setTasks(list);
        });
    }, []);

    async function onCancel(taskId: string) {
        await cancelDownload(taskId);
        refresh();
    }

    async function onRetry(taskId: string) {
        await retryDownload(taskId);
        refresh();
    }

    async function onClearFinished() {
        await clearDownloads();
        refresh();
    }

    const groups = groupDownloads(tasks ?? []);

    return (
        <div className="mx-auto w-full max-w-4xl px-4 py-6 md:px-8">
            <PageHeader
                title="下载"
                sub="下载中和下载过的漫画"
                actions={
                    tasks && tasks.length > 0 ? (
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => void onClearFinished()}
                        >
                            <Trash2 className="size-3.5" />
                            清空已完成
                        </Button>
                    ) : undefined
                }
            />

            {tasks === null ? (
                <Loading label="正在加载下载列表" />
            ) : tasks.length === 0 ? (
                <EmptyState
                    icon={<Download className="size-7" />}
                    text="还没有下载任务"
                    hint="在作品页选中章节下载，任务会出现在这里"
                />
            ) : (
                <div className="flex flex-col gap-2">
                    {groups.map((group) => (
                        <ComicGroup
                            key={group.key}
                            group={group}
                            onCancel={(id) => void onCancel(id)}
                            onRetry={(id) => void onRetry(id)}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

/** 一部作品一组：组头是章节粒度的汇总，展开后逐话看页进度与重试/取消。 */
function ComicGroup({
    group,
    onCancel,
    onRetry,
}: {
    group: DownloadGroup;
    onCancel: (taskId: string) => void;
    onRetry: (taskId: string) => void;
}) {
    const [expanded, setExpanded] = useState(false);
    const total = group.chapters.length;

    return (
        <div
            className={cn(
                "overflow-hidden rounded-lg border bg-card transition-colors",
                expanded ? "border-primary/40" : "border-border",
            )}
        >
            <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                className="w-full p-3.5 text-left transition-colors hover:bg-secondary/50"
            >
                <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-foreground">
                            {group.title}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                            <Tag>{sourceTitle(group.source)}</Tag>
                            <span className="tabular-nums">
                                待下载 {group.pending} 话
                            </span>
                            {group.done > 0 && (
                                <span className="tabular-nums">
                                    已完成 {group.done} 话
                                </span>
                            )}
                            {group.failed > 0 && (
                                <span className="tabular-nums text-destructive">
                                    失败 {group.failed} 话
                                </span>
                            )}
                            {group.cancelled > 0 && (
                                <span className="tabular-nums">
                                    已取消 {group.cancelled} 话
                                </span>
                            )}
                        </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2.5">
                        <AnimatedBadge
                            status={STATUS_BADGE[group.status]}
                            size="sm"
                            contentKey={group.status}
                            className={STATUS_BADGE_CLASS[group.status]}
                        >
                            {STATUS_LABEL[group.status]}
                        </AnimatedBadge>
                        <motion.span
                            animate={{ rotate: expanded ? 180 : 0 }}
                            transition={{ duration: 0.2, ease: EASE_OUT }}
                            className="text-muted-foreground"
                        >
                            <ChevronDown className="size-4" />
                        </motion.span>
                    </div>
                </div>

                <div className="mt-3 flex items-center gap-3">
                    <ProgressBar
                        pct={donePercent(group.done, total)}
                        done={group.status === "done"}
                    />
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        <AnimatedNumber value={group.done} startOnView={false} />
                        {" / "}
                        {total} 话
                    </span>
                </div>
            </button>

            <AnimatePresence initial={false}>
                {expanded && (
                    <motion.div
                        key="chapters"
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{
                            height: SPRING_PANEL,
                            opacity: { duration: 0.16, ease: EASE_OUT },
                        }}
                        className="overflow-hidden"
                    >
                        <div className="border-t border-border">
                            {group.chapters.map((task) => (
                                <ChapterRow
                                    key={task.taskId}
                                    task={task}
                                    onCancel={() => onCancel(task.taskId)}
                                    onRetry={() => onRetry(task.taskId)}
                                />
                            ))}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}

/** 单话一行：页进度 + 状态 + 取消/重试。 */
function ChapterRow({
    task,
    onCancel,
    onRetry,
}: {
    task: DownloadTaskView;
    onCancel: () => void;
    onRetry: () => void;
}) {
    const canCancel = task.status === "queued" || task.status === "downloading";
    const canRetry = task.status === "failed" || task.status === "cancelled";
    return (
        <div className="border-t border-border px-3.5 py-2.5 first:border-t-0">
            <div className="flex items-center justify-between gap-2.5">
                <span className="text-xs font-medium tabular-nums text-foreground">
                    第 {task.chapterIndex} 话
                </span>
                <div className="flex items-center gap-1.5">
                    <AnimatedBadge
                        status={STATUS_BADGE[task.status]}
                        size="sm"
                        contentKey={task.status}
                        className={STATUS_BADGE_CLASS[task.status]}
                    >
                        {STATUS_LABEL[task.status]}
                    </AnimatedBadge>
                    {canCancel && (
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={onCancel}
                            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                        >
                            取消
                        </Button>
                    )}
                    {canRetry && (
                        <Button variant="secondary" size="sm" onClick={onRetry}>
                            <RotateCcw className="size-3.5" />
                            重试
                        </Button>
                    )}
                </div>
            </div>

            <div className="mt-2 flex items-center gap-3">
                <ProgressBar
                    pct={donePercent(task.done, task.total)}
                    done={task.status === "done"}
                />
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {task.done} / {task.total} 页
                </span>
            </div>

            {task.error && (
                <div className="mt-1.5 text-xs text-destructive">{task.error}</div>
            )}
        </div>
    );
}
