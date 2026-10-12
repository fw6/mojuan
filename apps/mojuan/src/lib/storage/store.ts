import { load, type Store } from "@tauri-apps/plugin-store";
import { getStore as getFsStore } from "./fs";

// 存储层的底层：桌面与移动端的平台分支、每文件一个 Store 实例、跨域共用的键规则。
// 各域 module 只依赖 Store 的 get/set/delete/entries/clear 契约（测试 mock 插件后验证自有逻辑）。
// 移动端（wayfinder #29/#30）：tauri-plugin-store 不支持移动端 → 切到 fs.ts（fs 读写
// appDataDir JSON，接口一致，上层零改动）。

/** 移动平台检测（Tauri 桌面 webview UA 含 Android/iPhone/iPad/iPod）。 */
const IS_MOBILE = /android|iphone|ipad|ipod/i.test(navigator.userAgent);

/** 每个存储域的 JSON 文件（grilling #6：每域一 JSON）。 */
export const FILES = {
    settings: "settings.json",
    favorites: "favorites.json",
    history: "history.json",
    progress: "progress.json",
    sourceCache: "sources-cache.json",
    sources: "sources.json",
} as const;

const storeCache = new Map<string, Promise<Store>>();

export function getStore(file: (typeof FILES)[keyof typeof FILES]) {
    // 移动端走 fs 版（store 插件不支持）；桌面保持 store 版（现行为，grilling #29）
    return IS_MOBILE ? getFsStore(file) : loadStore(file);
}

function loadStore(file: string): Promise<Store> {
    if (!storeCache.has(file)) {
        storeCache.set(file, load(file));
    }
    return storeCache.get(file)!;
}

/** 漫画跨域唯一键：(source, comicId)。 */
export function comicKey(source: string, comicId: string): string {
    return `${source}:${comicId}`;
}
