import { useCallback, useEffect, useState } from "react";
import {
    clearImageCache,
    clearResultCache,
    setImageCacheLimit,
    storageUsage,
    type StorageUsage,
} from "../api";
import { getSettings, setSettings } from "../lib/storage/settings";
import { usePageActive } from "../lib/page-active";
import { cn, formatBytes } from "../lib/utils";
import { Button } from "./beui/button";
import { SettingRow } from "./ui";

/**
 * 存储占用与缓存控制：图片缓存、结果缓存与下载三项占用，两个缓存各自一键清空，
 * 图片缓存上限一个下拉。设置页的「存储」段与整屏存储页顶部渲染的是同一份东西，
 * 数据来自同一个 `storage_usage` 命令。
 * `refreshKey` 由消费方在别处改动磁盘之后（存储页删掉几部下载）递增，触发重新统计。
 */

/** 图片缓存上限的可选档位（字节；0 表示不限制）。 */
const LIMIT_OPTIONS: { value: number; label: string }[] = [
    { value: 0, label: "不限制" },
    { value: 500 * 1024 * 1024, label: "500 MB" },
    { value: 1024 * 1024 * 1024, label: "1 GB" },
    { value: 2 * 1024 * 1024 * 1024, label: "2 GB" },
    { value: 5 * 1024 * 1024 * 1024, label: "5 GB" },
];

export function StorageOverview({ refreshKey = 0 }: { refreshKey?: number }) {
    const [usage, setUsage] = useState<StorageUsage | null>(null);
    const [limit, setLimit] = useState(0);
    const [busy, setBusy] = useState<"image" | "result" | null>(null);
    const [error, setError] = useState<string | null>(null);
    // 设置页与存储页都是保留/整屏页面：再次打开时重取占用（下载目录可能改过）
    const active = usePageActive();

    const refresh = useCallback(async () => {
        try {
            const s = await getSettings();
            setLimit(s.imageCacheLimit);
            setUsage(await storageUsage(s.downloadDir ?? ""));
        } catch (e) {
            setError(String(e));
        }
    }, []);

    useEffect(() => {
        if (!active) return;
        void refresh();
    }, [active, refresh, refreshKey]);

    async function clear(kind: "image" | "result") {
        setBusy(kind);
        setError(null);
        try {
            await (kind === "image" ? clearImageCache() : clearResultCache());
            await refresh();
        } catch (e) {
            setError(String(e));
        } finally {
            setBusy(null);
        }
    }

    async function changeLimit(bytes: number) {
        setError(null);
        setLimit(bytes);
        try {
            // 上限写进设置域（重启后仍然生效），同时推给 Rust 就地整理
            await setSettings({ imageCacheLimit: bytes });
            await setImageCacheLimit(bytes);
            await refresh();
        } catch (e) {
            setError(String(e));
        }
    }

    /** 一行的占用文本；还没取到显示「计算中」。 */
    const occupancy = (entry: StorageUsage["image"] | undefined, unit: string) =>
        usage && entry ? (
            <span className="text-xs tabular-nums text-muted-foreground">
                <span>{formatBytes(entry.bytes)}</span>
                <span className="mx-1.5">·</span>
                <span>
                    {entry.count} {unit}
                </span>
            </span>
        ) : (
            <span className="text-xs text-muted-foreground">计算中…</span>
        );

    return (
        <>
            <SettingRow label="图片缓存">
                {occupancy(usage?.image, "张")}
                <Button
                    variant="secondary"
                    size="sm"
                    aria-label="清空图片缓存"
                    onClick={() => void clear("image")}
                    disabled={busy !== null}
                >
                    {busy === "image" ? "清空中…" : "清空"}
                </Button>
            </SettingRow>
            <SettingRow label="结果缓存">
                {occupancy(usage?.result, "条")}
                <Button
                    variant="secondary"
                    size="sm"
                    aria-label="清空结果缓存"
                    onClick={() => void clear("result")}
                    disabled={busy !== null}
                >
                    {busy === "result" ? "清空中…" : "清空"}
                </Button>
            </SettingRow>
            <SettingRow label="下载">{occupancy(usage?.download, "部")}</SettingRow>
            <SettingRow label="图片缓存上限" hint="超出后按最久没看过的先删">
                <select
                    aria-label="图片缓存上限"
                    value={String(limit)}
                    onChange={(e) => void changeLimit(Number(e.target.value))}
                    className={cn(
                        "h-8 rounded-full border border-input bg-transparent px-3 text-xs text-foreground",
                        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                    )}
                >
                    {LIMIT_OPTIONS.map((option) => (
                        <option key={option.value} value={String(option.value)}>
                            {option.label}
                        </option>
                    ))}
                </select>
            </SettingRow>
            {error && <p className="pt-2 text-xs text-destructive">{error}</p>}
        </>
    );
}
