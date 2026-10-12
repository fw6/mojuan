// 移动端存储层（wayfinder #29/#30：tauri-plugin-store 不支持移动端，
// 改用 tauri-plugin-fs 读写 appDataDir 下 JSON，每次 get/set 都写入磁盘）。
// 接口与 @tauri-apps/plugin-store 的 IStore 一致（get/set/has/delete/entries/clear/save），
// 各域 module 零改动；桌面保持 store 版不变，按平台在 store.ts 切换。

import { BaseDirectory, mkdir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";

export interface FsStore {
    get<T>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
    has(key: string): Promise<boolean>;
    delete(key: string): Promise<boolean>;
    entries<T>(): Promise<Array<[string, T]>>;
    clear(): Promise<void>;
    /** 兼容占位（fs 已即时写入磁盘，无独立 save 语义）。 */
    save(): Promise<void>;
}

const BASE = BaseDirectory.AppData;

/** 每文件一个 JSON 对象缓存（首次读盘，进程内常驻）。 */
const dataCache = new Map<string, Promise<Record<string, unknown>>>();

/** 写串行化：同一文件的写操作链式排队，防并发 set 读-改-写交错。 */
const writeQueue = new Map<string, Promise<void>>();

function load(file: string): Promise<Record<string, unknown>> {
    if (!dataCache.has(file)) {
        dataCache.set(
            file,
            (async () => {
                try {
                    return JSON.parse(await readTextFile(file, { baseDir: BASE }));
                } catch {
                    return {}; // 首启文件不存在 / 损坏 → 空对象
                }
            })(),
        );
    }
    return dataCache.get(file)!;
}

/** 幂等确保 appDataDir 存在（移动端默认不存在，研究 #29 #1.3）。fs scope 只放行
 * appDataDir 的子路径（`$APPDATA/**`），`mkdir(".")` 落在根目录会被拒；用 recursive
 * mkdir 建一个子目录，顺带创建 appDataDir 本身。 */
const BOOTSTRAP_DIR = "mojuan";

function persist(file: string): Promise<void> {
    const prev = writeQueue.get(file) ?? Promise.resolve();
    const next = prev.then(async () => {
        await mkdir(BOOTSTRAP_DIR, { baseDir: BASE, recursive: true });
        await writeTextFile(file, JSON.stringify(await load(file)), { baseDir: BASE });
    });
    writeQueue.set(file, next);
    return next;
}

export function getStore(file: string): FsStore {
    return {
        async get<T>(key: string): Promise<T | undefined> {
            return (await load(file))[key] as T | undefined;
        },
        async set(key: string, value: unknown): Promise<void> {
            (await load(file))[key] = value;
            await persist(file);
        },
        async has(key: string): Promise<boolean> {
            return key in (await load(file));
        },
        async delete(key: string): Promise<boolean> {
            const data = await load(file);
            if (!(key in data)) return false;
            delete data[key];
            await persist(file);
            return true;
        },
        async entries<T>(): Promise<Array<[string, T]>> {
            return Object.entries(await load(file)) as Array<[string, T]>;
        },
        async clear(): Promise<void> {
            const data = await load(file);
            for (const k of Object.keys(data)) delete data[k];
            await persist(file);
        },
        async save(): Promise<void> {}, // fs 已即时写入磁盘，占位保持接口一致
    };
}
