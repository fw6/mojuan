import { useCallback, useEffect, useRef, useState } from "react";
import { crawl, crawlCached, sourceErrors, type SourceError } from "../../api";
import { errorFirstLine } from "../errors";
import { persistSourceCache, whenSourcesReady } from "../storage/sources";

/** 缓存新鲜窗口的缺省值：0 表示每次都拉最新，缓存只用于首屏渲染。 */
const DEFAULT_MAX_AGE_MS = 0;

/** 抓取抛出但没有带错误文本时给页面的兜底说明。 */
const FALLBACK_ERROR = "源没有返回错误信息";

export interface CrawlOptions {
    /** 新鲜窗口（毫秒）：窗口内的缓存直接用、不发请求。 */
    maxAge?: number;
    /** false 时不发请求（发现页在没选中分类前用）。 */
    enabled?: boolean;
}

export interface CrawlState<T> {
    /** 当前请求的数据；没取到时为 null（上一个请求的数据会留到本次读缓存有结果为止）。 */
    data: T | null;
    /** 有未完成的抓取。 */
    loading: boolean;
    /** 数据来自缓存、后台正在拉最新（页面据此不把加载态压在已有内容上）。 */
    stale: boolean;
    /** 源最近一次错误的首行：抛出的错误优先，没有抛出但结果为空时取源错误登记表。 */
    error: string | null;
    /** 重跑当前请求（详情页与发现页横幅上的「重试」）。 */
    reload: () => void;
}

interface CrawlData<T> {
    data: T | null;
    loading: boolean;
    stale: boolean;
    error: string | null;
}

const EMPTY: CrawlData<never> = {
    data: null,
    loading: false,
    stale: false,
    error: null,
};

/** 抓取结果算不算「空」：空结果不覆盖已有缓存（源失败与源确实没有内容是同一个表现）。 */
function isEmptyResult(op: string, data: unknown): boolean {
    if (Array.isArray(data)) return data.length === 0;
    if (op === "detail") return !(data as { comic?: unknown } | null)?.comic;
    return false;
}

/**
 * 两段式加载：先渲染抓取结果缓存（stale-while-revalidate 的 stale 一侧），再拉最新覆盖。
 * 窗口内的缓存直接收工；缓存未命中时清空数据，页面显示加载态。
 * 源错误登记表与「抓取成功后回灌源进程内缓存」都在这里，页面只拿数据与状态。
 */
export function useCrawl<T>(
    op: string,
    source: string,
    payload: unknown,
    opts: CrawlOptions = {},
): CrawlState<T> {
    const { maxAge = DEFAULT_MAX_AGE_MS, enabled = true } = opts;
    // payload 是对象字面量、每次渲染都是新引用；序列化结果相同即视为同一个请求
    const payloadJson = JSON.stringify(payload);
    const key = `${op}\u0000${source}\u0000${payloadJson}`;
    const [state, setState] = useState<CrawlData<T>>(EMPTY);
    const [nonce, setNonce] = useState(0);
    // 已经取到结果的请求：effect 被重放（React 开发期、页面保留后重新显示）时不再重复取
    const loaded = useRef<string | null>(null);

    const reload = useCallback(() => {
        loaded.current = null;
        setNonce((n) => n + 1);
    }, []);

    useEffect(() => {
        if (!enabled) {
            loaded.current = null;
            setState(EMPTY);
            return;
        }
        if (loaded.current === key) return;
        let cancelled = false;
        const alive = () => !cancelled;
        setState((s) => ({ ...s, loading: true, stale: false, error: null }));
        void (async () => {
            // 等源脚本同步完成：registry 未就绪时脚本源的 op 会返回空
            await whenSourcesReady();
            if (!alive()) return;
            const args = JSON.parse(payloadJson) as unknown;
            const cached = await crawlCached<T>(op, source, args);
            if (!alive()) return;
            if (cached) {
                // 缓存先上屏；窗口内不再拉网络
                setState({
                    data: cached.data,
                    loading: true,
                    stale: true,
                    error: null,
                });
                if (Date.now() - cached.fetchedAt < maxAge) {
                    loaded.current = key;
                    setState({
                        data: cached.data,
                        loading: false,
                        stale: false,
                        error: null,
                    });
                    return;
                }
            } else {
                // 没有缓存：清掉上一个请求的数据，页面显示加载态
                setState({ data: null, loading: true, stale: false, error: null });
            }
            let fresh: T | null = null;
            let thrown: string | null = null;
            try {
                fresh = await crawl<T>(op, source, args);
            } catch (e) {
                thrown = e instanceof Error ? e.message : String(e);
                console.error("crawl failed", op, source, e);
            }
            if (!alive()) return;
            loaded.current = key;
            if (thrown === null) {
                void persistSourceCache(source).catch((e) =>
                    console.error("源缓存写入失败", e),
                );
            }
            const errors = await sourceErrors().catch((e) => {
                console.error("源错误登记表读取失败", e);
                return {} as Record<string, SourceError>;
            });
            if (!alive()) return;
            const empty = fresh !== null && isEmptyResult(op, fresh);
            const registry = errors[source]
                ? errorFirstLine(errors[source].message)
                : null;
            setState({
                data: fresh !== null && !empty ? fresh : (cached?.data ?? null),
                loading: false,
                stale: false,
                error:
                    thrown !== null
                        ? errorFirstLine(thrown) || FALLBACK_ERROR
                        : empty
                          ? registry
                          : null,
            });
        })();
        return () => {
            cancelled = true;
        };
    }, [key, op, source, payloadJson, enabled, maxAge, nonce]);

    return { ...state, reload };
}
