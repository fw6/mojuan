import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
    AnimatedToastStack,
    useAnimatedToastStack,
    type ToastInput,
    type ToastStatus,
} from "./beui/animated-toast-stack";

interface ToastApi {
    /** 弹一条轻提示：字符串即标题，或传完整 toast 载荷。 */
    show: (input: string | ToastInput, status?: ToastStatus) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
    const { toasts, showToast, dismissToast } = useAnimatedToastStack({
        defaultDuration: 2600,
        limit: 3,
    });

    const api = useMemo<ToastApi>(
        () => ({
            show: (input, status) => {
                showToast(
                    typeof input === "string"
                        ? { title: input, status: status ?? "neutral" }
                        : input,
                );
            },
        }),
        [showToast],
    );

    return (
        <ToastContext.Provider value={api}>
            {children}
            <AnimatedToastStack
                toasts={toasts}
                onDismiss={dismissToast}
                position="bottom-center"
                fixed
                className="bottom-24 md:bottom-8"
            />
        </ToastContext.Provider>
    );
}

export function useToast(): ToastApi {
    const ctx = useContext(ToastContext);
    if (!ctx) throw new Error("useToast 必须在 ToastProvider 内使用");
    return ctx;
}
