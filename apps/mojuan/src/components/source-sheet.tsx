import { useEffect, useState, type RefObject } from "react";
import { Check, TriangleAlert } from "lucide-react";
import { sourceErrors, type SourceError } from "../api";
import { SOURCES } from "../lib/sources";
import { errorFirstLine } from "../lib/errors";
import { cn } from "../lib/utils";
import { BottomSheet } from "./beui/bottom-sheet";

/**
 * 源选择面板：切换源是低频操作，源列表收进底部面板，页头只留当前源按钮。
 * 每一行是一个源；当前项用蓝色标记，该源最近一次抓取失败时行内标出
 * （产品原则「源可以坏，应用不能假」：切换前就能看到）。
 */
export function SourceSheet({
    open,
    onOpenChange,
    current,
    onSelect,
    restoreFocusRef,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    current: string;
    onSelect: (sourceId: string) => void;
    /** 关闭后把焦点交还的触发按钮（键盘可达性）。 */
    restoreFocusRef: RefObject<HTMLButtonElement | null>;
}) {
    const [errors, setErrors] = useState<Record<string, SourceError>>({});

    // 打开时取一次各源最近错误（面板里的失败状态）
    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        void sourceErrors()
            .then((errs) => {
                if (!cancelled) setErrors(errs);
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, [open]);

    /** 关闭（含选择后）：把焦点交还触发按钮。 */
    function close() {
        onOpenChange(false);
        restoreFocusRef.current?.focus();
    }

    return (
        <BottomSheet
            open={open}
            onOpenChange={(next) => {
                if (!next) close();
            }}
            snapPoints={["auto"]}
            title="漫画源"
            className="pb-[env(safe-area-inset-bottom)]"
        >
            <ul className="flex flex-col gap-2">
                {SOURCES.map((s) => {
                    const active = s.id === current;
                    const err = errors[s.id];
                    return (
                        <li key={s.id}>
                            <button
                                type="button"
                                autoFocus={active}
                                aria-current={active || undefined}
                                onClick={() => {
                                    if (!active) onSelect(s.id);
                                    close();
                                }}
                                className={cn(
                                    "flex min-h-11 w-full items-center gap-2.5 rounded-md px-3 text-left text-sm transition-colors",
                                    "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                                    active
                                        ? "bg-primary/12 text-foreground"
                                        : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                                )}
                            >
                                <span className="min-w-0 flex-1 truncate">
                                    {s.title}
                                </span>
                                {err && (
                                    <span
                                        className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
                                        title={errorFirstLine(err.message)}
                                    >
                                        <TriangleAlert
                                            className="size-3.5 text-warning"
                                            aria-hidden="true"
                                        />
                                        上次加载失败
                                    </span>
                                )}
                                {active && (
                                    <Check
                                        className="size-4 shrink-0 text-primary"
                                        aria-hidden="true"
                                    />
                                )}
                            </button>
                        </li>
                    );
                })}
            </ul>
        </BottomSheet>
    );
}
