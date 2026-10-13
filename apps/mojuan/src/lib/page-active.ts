import { createContext, useContext } from "react";

/**
 * 页面是否在前台。保留页（KeepAlive）离开后留在 DOM 里，挂载 effect 不会重跑，
 * 页面靠它知道「又被打开了」。默认 true：不在保留路由里的页面（组件测试）一律算前台。
 */
export const PageActiveContext = createContext(true);

export function usePageActive(): boolean {
    return useContext(PageActiveContext);
}
