import { downloadDir } from "@tauri-apps/api/path";
import { FILES, getStore } from "./store";

/** 设置（最小集：下载目录/夜间模式/自动裁边/书架追更 + 发现页浏览位置 + WebDAV 凭据 + 图片缓存上限）。 */
export interface Settings {
    downloadDir: string | null;
    darkMode: boolean;
    autoTrim: boolean;
    /** 书架追更：进入书架时自动检查收藏作品有没有新话。手动刷新不受它限制。 */
    followUpdate: boolean;
    /** 发现页上次选择的源（重启后回到这里）。 */
    lastSource: string | null;
    /** 每个源上次停留的分类标签：`{sourceId: label}`。 */
    lastCategory: Record<string, string>;
    /** 书架追更最近一次自动检查的时刻（unix 毫秒）；null 表示还没检查过。手动刷新不写这里。 */
    followCheckedAt: number | null;
    /** 图片缓存上限（字节；0 表示不限制）。启动时推给 Rust，超出上限按最近使用时间淘汰。 */
    imageCacheLimit: number;
    /** WebDAV 备份凭据（wayfinder #24/#25：明文存 settings，钥匙串后置）。 */
    webdav?: { baseUrl: string; user: string; password: string };
}

/** 图片缓存上限的默认值：1 GB。 */
export const DEFAULT_IMAGE_CACHE_LIMIT = 1024 * 1024 * 1024;

const DEFAULT_SETTINGS: Settings = {
    downloadDir: null,
    darkMode: false,
    autoTrim: false,
    followUpdate: true,
    lastSource: null,
    lastCategory: {},
    followCheckedAt: null,
    imageCacheLimit: DEFAULT_IMAGE_CACHE_LIMIT,
};

/** 下载目录默认值（grilling #6：~/Downloads/mojuan）。 */
export async function defaultDownloadDir(): Promise<string> {
    const base = await downloadDir();
    return `${base}/mojuan`;
}

export async function getSettings(): Promise<Settings> {
    const store = await getStore(FILES.settings);
    const saved = await store.get<Partial<Settings>>("settings");
    const merged = { ...DEFAULT_SETTINGS, ...saved };
    return {
        ...merged,
        downloadDir: merged.downloadDir ?? (await defaultDownloadDir()),
    };
}

export async function setSettings(partial: Partial<Settings>): Promise<void> {
    const store = await getStore(FILES.settings);
    const current = await store.get<Partial<Settings>>("settings");
    await store.set("settings", { ...current, ...partial });
}

/** 记住发现页的浏览位置：切源或切分类时调用，重启后从这里恢复。
 * 一次写入同时更新 lastSource 与 lastCategory，避免两次读改写互相覆盖。 */
export async function rememberDiscovery(source: string, category?: string): Promise<void> {
    const store = await getStore(FILES.settings);
    const current = (await store.get<Partial<Settings>>("settings")) ?? {};
    const lastCategory = { ...(current.lastCategory ?? {}) };
    if (category !== undefined) lastCategory[source] = category;
    await store.set("settings", { ...current, lastSource: source, lastCategory });
}
