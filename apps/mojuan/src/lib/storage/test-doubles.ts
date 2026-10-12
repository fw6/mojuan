import { vi } from "vitest";
import type { Comic } from "../../api";

// 存储域测试共用的替身：桌面 store 插件、移动端 fs 插件与 core invoke 的内存版。
// 各测试文件用 vi.mock 把插件指向这里（factory 里动态 import 本模块，拿到同一份状态）。

const dataByPath = new Map<string, Map<string, unknown>>();

/** 按 path 隔离的内存表。按 path 查表读数据：store.ts 的 storeCache 会跨用例缓存实例，
 * reset 之后旧实例也要能看到清空后的状态。 */
function storeFor(path: string) {
    if (!dataByPath.has(path)) dataByPath.set(path, new Map());
    return dataByPath.get(path)!;
}

/** 桌面 store 插件替身。 */
export const storePlugin = {
    load: async (path: string) => ({
        get: async (k: string) => storeFor(path).get(k),
        set: async (k: string, v: unknown) => {
            storeFor(path).set(k, v);
        },
        has: async (k: string) => storeFor(path).has(k),
        delete: async (k: string) => storeFor(path).delete(k),
        entries: async <T>() => [...storeFor(path).entries()] as Array<[string, T]>,
        clear: async () => {
            storeFor(path).clear();
        },
        save: async () => {},
    }),
};

/** @tauri-apps/api/path 替身。 */
export const pathPlugin = { downloadDir: async () => "/mock/Downloads" };

/** 移动端 fs 插件替身：内存文件系统。 */
export const fsFiles = new Map<string, string>();

export const fsPlugin = {
    BaseDirectory: { AppData: 14 },
    readTextFile: vi.fn(async (path: string) => {
        const v = fsFiles.get(path);
        if (v === undefined) throw new Error("file not found");
        return v;
    }),
    writeTextFile: vi.fn(async (path: string, data: string) => {
        fsFiles.set(path, data);
    }),
    mkdir: vi.fn(async () => {}),
};

/** core invoke 替身。 */
export const invokeMock = vi.fn();

/** 清空全部替身状态（每个用例前调用）。 */
export function resetDoubles(): void {
    for (const m of dataByPath.values()) m.clear();
    dataByPath.clear();
    fsFiles.clear();
    fsPlugin.readTextFile.mockClear();
    fsPlugin.writeTextFile.mockClear();
    fsPlugin.mkdir.mockClear();
    invokeMock.mockReset();
}

/** 测试用漫画条目。 */
export function testComic(id: string, source = "mangadex"): Comic {
    return {
        id,
        source,
        sourceTitle: "MangaDex",
        title: `作品 ${id}`,
        author: "作者",
        intro: "",
        cover: "https://example.com/cover.jpg",
        status: "ongoing",
        updateTime: "",
        lastChapter: "1",
        tags: [],
        lastReadChapter: 0,
        lastReadTime: 0,
    };
}
