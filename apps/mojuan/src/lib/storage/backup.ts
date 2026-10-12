import type { Comic } from "../../api";
import type { HistoryRecord } from "./history";
import type { ProgressRecord } from "./progress";
import { FILES, getStore } from "./store";

/** 备份文件版本（grilling #25 #6：version≠1 拒绝恢复）。 */
export const BACKUP_VERSION = 1;

export interface BackupData {
    version: number;
    /** unix 毫秒，备份时刻（信息展示）。 */
    exportedAt: number;
    /** key = comicKey(source, comicId) */
    favorites: Record<string, Comic>;
    history: Record<string, HistoryRecord>;
    progress: Record<string, ProgressRecord>;
}

/** 收集三域为备份 JSON 字符串（单文件 mojuan-backup.json 内容，grilling #25 #2）。 */
export async function exportBackupJson(): Promise<string> {
    const [favStore, hisStore, proStore] = await Promise.all([
        getStore(FILES.favorites),
        getStore(FILES.history),
        getStore(FILES.progress),
    ]);
    const favorites: Record<string, Comic> = {};
    for (const [k, v] of await favStore.entries<Comic>()) favorites[k] = v;
    const history: Record<string, HistoryRecord> = {};
    for (const [k, v] of await hisStore.entries<HistoryRecord>()) history[k] = v;
    const progress: Record<string, ProgressRecord> = {};
    for (const [k, v] of await proStore.entries<ProgressRecord>()) progress[k] = v;
    const data: BackupData = {
        version: BACKUP_VERSION,
        exportedAt: Date.now(),
        favorites,
        history,
        progress,
    };
    return JSON.stringify(data);
}

/** 解析并校验备份 JSON：版本不符抛错（防旧格式误恢复，grilling #25 #6）。 */
export function parseBackupJson(json: string): BackupData {
    const data = JSON.parse(json) as BackupData;
    if (data.version !== BACKUP_VERSION) {
        throw new Error(`备份版本 ${data.version} 不受支持（当前 ${BACKUP_VERSION}）`);
    }
    return data;
}

/** 恢复：整体覆盖本地三域（快照语义，grilling #25 #4）。 */
export async function importBackupData(data: BackupData): Promise<void> {
    const [favStore, hisStore, proStore] = await Promise.all([
        getStore(FILES.favorites),
        getStore(FILES.history),
        getStore(FILES.progress),
    ]);
    await Promise.all([favStore.clear(), hisStore.clear(), proStore.clear()]);
    for (const [k, v] of Object.entries(data.favorites)) await favStore.set(k, v);
    for (const [k, v] of Object.entries(data.history)) await hisStore.set(k, v);
    for (const [k, v] of Object.entries(data.progress)) await proStore.set(k, v);
}
