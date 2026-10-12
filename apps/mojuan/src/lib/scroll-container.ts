import { createContext, useContext, type RefObject } from "react";

/** 页面滚动容器（AppShell 的 <main>）；阅读器自带滚动容器，不用这个。 */
export const ScrollContainerContext =
    createContext<RefObject<HTMLElement | null> | null>(null);

export function useScrollContainerRef(): RefObject<HTMLElement | null> | null {
    return useContext(ScrollContainerContext);
}
