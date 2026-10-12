import { downloadDir } from "@tauri-apps/api/path";
import { FILES, getStore } from "./store";

/** 设置（最小集：下载目录/夜间模式/自动裁边 + 发现页浏览位置 + WebDAV 凭据）。 */
export interface Settings {
    downloadDir: string | null;
    darkMode: boolean;
    autoTrim: boolean;
    /** 发现页上次选择的源（重启后回到这里）。 */
    lastSource: string | null;
    /** 每个源上次停留的分类标签：`{sourceId: label}`。 */
    lastCategory: Record<string, string>;
    /** WebDAV 备份凭据（wayfinder #24/#25：明文存 settings，钥匙串后置）。 */
    webdav?: { baseUrl: string; user: string; password: string };
}

const DEFAULT_SETTINGS: Settings = {
    downloadDir: null,
    darkMode: false,
    autoTrim: false,
    lastSource: null,
    lastCategory: {},
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
