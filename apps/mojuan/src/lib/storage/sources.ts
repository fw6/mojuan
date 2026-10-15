import { crawl, syncSources } from "../../api";
import { applySources } from "../sources";
import { FILES, getStore } from "./store";

/** 已装源（sources.json 域，key = sourceId）。 */
export interface SourceEntry {
    sourceId: string;
    /** 递增整数版本，与源仓库索引对比决定更新。 */
    version: number;
    /** 源文档（JSON 原文；由 Rust 侧校验后装载）。 */
    document: string;
    updatedAt: number;
}

/** 源运行时（源仓库索引里带的一份共享解释器；未装过时用 app 内置的）。 */
export interface RuntimeEntry {
    version: number;
    script: string;
}

/** 安装顺序（内置的 webtoons 由 Rust 侧恒排在最前，这里只记用户装的源）。 */
export async function getOrder(): Promise<string[]> {
    const store = await getStore(FILES.sources);
    return (await store.get<string[]>("order")) ?? [];
}

export async function getSources(): Promise<Record<string, SourceEntry>> {
    const store = await getStore(FILES.sources);
    return (await store.get<Record<string, SourceEntry>>("sources")) ?? {};
}

export async function getRuntime(): Promise<RuntimeEntry | null> {
    const store = await getStore(FILES.sources);
    return (await store.get<RuntimeEntry>("runtime")) ?? null;
}

/** 装/更新一个源：写进存储并追加安装顺序（已装过则保持原位置）。 */
export async function putSource(entry: SourceEntry): Promise<void> {
    const store = await getStore(FILES.sources);
    const sources = await getSources();
    sources[entry.sourceId] = entry;
    await store.set("sources", sources);
    const order = await getOrder();
    if (!order.includes(entry.sourceId)) {
        order.push(entry.sourceId);
        await store.set("order", order);
    }
}

/** 卸载一个源（内置的 webtoons 不可卸载，由调用方拦住）。 */
export async function removeSource(sourceId: string): Promise<void> {
    const store = await getStore(FILES.sources);
    const sources = await getSources();
    delete sources[sourceId];
    await store.set("sources", sources);
    const order = (await getOrder()).filter((id) => id !== sourceId);
    await store.set("order", order);
}

export async function putRuntime(entry: RuntimeEntry): Promise<void> {
    const store = await getStore(FILES.sources);
    await store.set("runtime", entry);
}

/** 丢掉没有文档的安装记录：旧模型的 `sources.json` 里只有 `script`，读出来的 `document` 是空的，
 * 这些条目装载不了、也不该出现在源清单里。返回清干净的那份（顺序表同步去掉这些 id）。 */
async function pruneEmptySources(): Promise<Record<string, SourceEntry>> {
    const sources = await getSources();
    const kept: Record<string, SourceEntry> = {};
    let dropped = false;
    for (const [id, entry] of Object.entries(sources)) {
        if (typeof entry?.document === "string" && entry.document.trim() !== "") {
            kept[id] = entry;
        } else {
            dropped = true;
        }
    }
    if (!dropped) return kept;
    const store = await getStore(FILES.sources);
    await store.set("sources", kept);
    await store.set(
        "order",
        (await getOrder()).filter((id) => kept[id]),
    );
    return kept;
}

/**
 * 把已装源同步进 Rust 注册表，并用返回的源事实填充前端清单与热链对。
 * 返回被拒绝的源及原因（坏文档保留已装版本，前端据此提示）。
 */
export async function syncInstalled(): Promise<{ id: string; reason: string }[]> {
    const installed = await pruneEmptySources();
    const order = await getOrder();
    const runtime = await getRuntime();
    const ids = order.filter((id) => installed[id]);
    // 存储里有但顺序表漏掉的（异常数据）也一并带上，避免装了的源不生效
    for (const id of Object.keys(installed)) {
        if (!ids.includes(id)) ids.push(id);
    }
    const result = await syncSources({
        runtime: runtime?.script,
        sources: ids.map((id) => ({ id, document: installed[id].document })),
    });
    applySources(result.sources);
    return result.rejected;
}

/** 源同步的单例：首次调用执行，后续调用等待同一个 Promise。
 * 页面取数前 await whenSourcesReady()——源尚未进入注册表时，该源的 op 会按空结果返回。 */
let pending: Promise<{ id: string; reason: string }[]> | null = null;

/** 执行一次同步（已同步过则复用结果）。返回被拒绝的源及原因。 */
export function syncNow(): Promise<{ id: string; reason: string }[]> {
    pending ??= syncInstalled().catch((err) => {
        console.error("源同步失败", err);
        return [];
    });
    return pending;
}

export function whenSourcesReady(): Promise<void> {
    return syncNow().then((rejected) => {
        for (const r of rejected) {
            console.error(`源 ${r.id} 未装载：${r.reason}`);
        }
    });
}

/** 安装/更新/卸载源之后重新同步（返回被拒绝的源及原因）。 */
export function resyncSources(): Promise<{ id: string; reason: string }[]> {
    pending = null;
    return syncNow();
}

/** 安装一份源文档的结果：装上给出 id 与显示名，没装上给出卡在哪一步与原因。 */
export type InstallOutcome =
    | { ok: true; id: string; title: string }
    /** 文档自身不合规（空的、不是 JSON 对象、缺 id）：没有写进已装源。 */
    | { ok: false; stage: "document"; reason: string }
    /** Rust 侧校验没过：已装源保持原来的版本。 */
    | { ok: false; stage: "rejected"; reason: string };

/**
 * 把一份源文档原文安装为已装源：先做本地校验（JSON 与 id），再写进已装源并同步进 Rust 注册表。
 * 结构由 Rust 侧校验，坏文档不替换已装版本——原先装着的放回去，没装过的清掉安装记录。
 *
 * 设置页的「手动导入」与调试台的「安装这份文档」共用这一条路径。
 */
export async function installSourceDocument(text: string): Promise<InstallOutcome> {
    const document = text.trim();
    if (!document) {
        return { ok: false, stage: "document", reason: "请先粘贴源文档" };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(document);
    } catch (e) {
        return { ok: false, stage: "document", reason: String(e) };
    }
    if (typeof parsed !== "object" || parsed === null) {
        return { ok: false, stage: "document", reason: "源文档不是一个 JSON 对象" };
    }
    const { id, title } = parsed as { id?: unknown; title?: unknown };
    if (typeof id !== "string" || id === "") {
        return { ok: false, stage: "document", reason: "源文档缺少 id" };
    }

    // 已装过的先留一份：Rust 侧拒了这份文档时用它把安装记录放回去
    const previous = (await getSources())[id] ?? null;
    await putSource({
        sourceId: id,
        version: 1,
        document,
        updatedAt: Date.now(),
    });
    const rejected = await resyncSources();
    const bad = rejected.find((r) => r.id === id);
    if (bad) {
        if (previous) await putSource(previous);
        else await removeSource(id);
        return { ok: false, stage: "rejected", reason: bad.reason };
    }
    return { ok: true, id, title: typeof title === "string" && title ? title : id };
}

// ---------- 源进程内缓存的持久化（cache_dump / cache_hydrate） ----------

/** 启动时把上次保存的各源缓存回灌进 Rust。没有持久缓存的源 hydrate 是空操作。 */
export async function hydrateSourceCaches(): Promise<void> {
    const store = await getStore(FILES.sourceCache);
    const all = (await store.get<Record<string, unknown>>("caches")) ?? {};
    for (const [id, data] of Object.entries(all)) {
        if (data && Object.keys(data).length > 0) {
            await crawl("cache_hydrate", id, data);
        }
    }
}

/** 抓取后把某源的进程内缓存写入磁盘；该源没有持久缓存时 dump 出空对象，不写。 */
export async function persistSourceCache(source: string): Promise<void> {
    const dump = await crawl<Record<string, unknown>>("cache_dump", source, {});
    if (Object.keys(dump).length === 0) return;
    const store = await getStore(FILES.sourceCache);
    const all = (await store.get<Record<string, unknown>>("caches")) ?? {};
    all[source] = dump;
    await store.set("caches", all);
}
