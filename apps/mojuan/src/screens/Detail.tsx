import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useScroll } from "motion/react";
import { ArrowLeft, BookOpen, Check, Download, Heart, X } from "lucide-react";
import {
    crawl,
    enqueueDownload,
    imgSrc,
    listDownloaded,
    type Chapter,
    type Comic,
} from "../api";
import { useCrawl } from "../lib/hooks/use-crawl";
import { filterExternalChapters } from "../lib/chapters";
import { isFavorite, toggleFavorite } from "../lib/storage/favorites";
import { getProgress } from "../lib/storage/progress";
import { getSettings } from "../lib/storage/settings";
import { cn } from "../lib/utils";
import { sourceReferer, sourceTitle } from "../lib/sources";
import { useScrollContainerRef } from "../lib/scroll-container";
import {
    Banner,
    Cover,
    EmptyState,
    LinkButton,
    Loading,
    Reveal,
    Tag,
} from "../components/ui";
import { useToast } from "../components/toast";
import { Button } from "../components/beui/button";
import { ScrollProgress } from "../components/beui/scroll-progress";

const STATUS_LABEL: Record<string, string> = {
    serial: "连载中",
    completed: "已完结",
    hiatus: "停更",
};

export default function Detail() {
    const { source, comicId } = useParams();
    const navigate = useNavigate();
    const toast = useToast();
    const id = comicId ? decodeURIComponent(comicId) : "";
    const [favorite, setFavorite] = useState(false);
    const [resume, setResume] = useState<number | null>(null);
    // 下载（多选）：磁盘上已有的章节 + 用户勾选 + 提交进度
    const [downloadDir, setDownloadDir] = useState<string | null>(null);
    const [onDisk, setOnDisk] = useState<Set<number>>(new Set());
    const [queued, setQueued] = useState<Set<number>>(new Set());
    const [selecting, setSelecting] = useState(false);
    const [selected, setSelected] = useState<Set<number>>(new Set());
    const [submitting, setSubmitting] = useState<{
        done: number;
        total: number;
    } | null>(null);
    const container = useScrollContainerRef();
    const { scrollYProgress } = useScroll(
        container ? { container } : { container: undefined },
    );

    // 详情每次都拉网络（新鲜窗口为 0）：渲染源的章节中转链经 post_process 写入进程内
    // 缓存（baozimh 的 images 依赖它），跳过抓取会让章节打不开。
    const detail = useCrawl<{ comic: Comic; chapters: Chapter[] }>(
        "detail",
        source ?? "",
        { comicId: id },
    );
    const comic = detail.data?.comic ?? null;
    const chapters = filterExternalChapters(detail.data?.chapters ?? []);

    // 收藏 / 阅读进度 / 下载目录 / 磁盘上已有的章节：与抓取无关，各取一次
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            const [fav, prog, settings] = await Promise.all([
                isFavorite(source!, id),
                getProgress(source!, id),
                getSettings(),
            ]);
            if (cancelled) return;
            setFavorite(fav);
            if (prog) setResume(prog.chapterIndex);
            setDownloadDir(settings.downloadDir);
            setSelecting(false);
            setSelected(new Set());
            setQueued(new Set());
            setOnDisk(
                settings.downloadDir
                    ? new Set(
                          Object.keys(
                              await listDownloaded(settings.downloadDir, source!, id),
                          ).map(Number),
                      )
                    : new Set(),
            );
        })();
        return () => {
            cancelled = true;
        };
    }, [source, id]);

    async function onToggleFavorite() {
        if (!comic) return;
        setFavorite(await toggleFavorite(comic));
    }

    /** 本地已有的章节（已下载或排队中）不再参与勾选。 */
    const taken = (index: number) => onDisk.has(index) || queued.has(index);
    const selectable = chapters.filter((ch) => !taken(ch.index));
    const allSelected = selectable.length > 0 && selected.size === selectable.length;

    function toggleChapter(index: number) {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(index)) next.delete(index);
            else next.add(index);
            return next;
        });
    }

    function exitSelection() {
        setSelecting(false);
        setSelected(new Set());
    }

    /**
     * 逐话取图片列表并入队：每话拿到 url 就入队，下载立刻开始，不必等全部提交完。
     * 入队后本页按「排队中」标记，进度到「下载」页看。
     */
    async function startDownload() {
        if (!comic || selected.size === 0) return;
        const dir = downloadDir;
        if (!dir) {
            toast.show("请先到「设置」里选一个下载位置", "error");
            return;
        }
        const indexes = [...selected].sort((a, b) => a - b);
        const referer = sourceReferer(source!);
        setSubmitting({ done: 0, total: indexes.length });
        let queuedCount = 0;
        let skipped = 0;
        let failed = 0;
        for (const [i, chapterIndex] of indexes.entries()) {
            setSubmitting({ done: i, total: indexes.length });
            try {
                const urls = await crawl<string[]>("images", source!, {
                    comicId: id,
                    chapterIndex,
                });
                if (urls.length === 0) {
                    failed += 1;
                    continue;
                }
                const out = await enqueueDownload({
                    source: source!,
                    comicId: id,
                    comicTitle: comic.title,
                    chapterIndex,
                    dir,
                    referer,
                    urls,
                });
                if (out.result === "alreadyDownloaded") {
                    skipped += 1;
                    setOnDisk((prev) => new Set(prev).add(chapterIndex));
                } else {
                    queuedCount += 1;
                    setQueued((prev) => new Set(prev).add(chapterIndex));
                }
            } catch (e) {
                console.error("提交下载失败", e);
                failed += 1;
            }
        }
        setSubmitting(null);
        exitSelection();
        const parts = [`已排队下载 ${queuedCount} 话`];
        if (skipped > 0) parts.push(`${skipped} 话本地已有`);
        if (failed > 0) parts.push(`${failed} 话没能添加`);
        toast.show(parts.join("，"), failed > 0 ? "error" : "success");
    }

    // 抓取失败时横幅挂在页面上，缓存里的作品与章节照常显示；没有可显示的内容时只剩它
    const failure = detail.error ? (
        <Banner>
            加载失败：{detail.error}
            <Button
                variant="ghost"
                size="sm"
                className="ml-2"
                onClick={() => detail.reload()}
            >
                重试
            </Button>
        </Banner>
    ) : null;

    if (!comic) {
        return (
            <div className="mx-auto w-full max-w-5xl px-4 py-6 md:px-8">
                <BackButton onClick={() => navigate(-1)} />
                {failure ?? <Loading label="正在加载作品信息" />}
            </div>
        );
    }

    return (
        <>
            <ScrollProgress
                progress={scrollYProgress}
                fixed
                height={2}
                className="bg-primary"
            />
            <div
                className="mx-auto w-full max-w-5xl px-4 py-6 md:px-8"
            >
                <BackButton onClick={() => navigate(-1)} />
                {failure}

                <div className="flex flex-col gap-6 md:flex-row md:gap-8">
                    <Cover
                        src={imgSrc(comic.cover)}
                        alt={comic.title}
                        className="mx-auto w-40 shrink-0 rounded-lg md:mx-0 md:w-52"
                    />
                    <div className="min-w-0 flex-1">
                        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                            {comic.title}
                        </h1>
                        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                            <Tag tone="primary">{sourceTitle(comic.source)}</Tag>
                            {comic.author && <span>{comic.author}</span>}
                            {STATUS_LABEL[comic.status] && (
                                <span>· {STATUS_LABEL[comic.status]}</span>
                            )}
                            {comic.updateTime && <span>· {comic.updateTime}</span>}
                        </div>

                        {comic.tags.length > 0 && (
                            <div className="mt-3 flex flex-wrap gap-1.5">
                                {comic.tags.map((t) => (
                                    <Tag key={t}>{t}</Tag>
                                ))}
                            </div>
                        )}

                        {comic.intro && (
                            <p className="mt-4 text-sm leading-6 text-muted-foreground">
                                {comic.intro}
                            </p>
                        )}

                        <div className="mt-5 flex flex-wrap gap-2">
                            {resume !== null && (
                                <LinkButton
                                    to={`/reader/${source}/${encodeURIComponent(id)}/${resume}`}
                                    variant="primary"
                                    size="lg"
                                >
                                    <BookOpen className="size-4" />
                                    继续阅读 第 {resume} 话
                                </LinkButton>
                            )}
                            {resume === null && chapters.length > 0 && (
                                <LinkButton
                                    to={`/reader/${source}/${encodeURIComponent(id)}/${chapters[0].index}`}
                                    variant="primary"
                                    size="lg"
                                >
                                    <BookOpen className="size-4" />
                                    开始阅读
                                </LinkButton>
                            )}
                            <Button
                                variant="secondary"
                                size="lg"
                                onClick={() => void onToggleFavorite()}
                                aria-pressed={favorite}
                            >
                                <Heart
                                    className={cn(
                                        "size-4",
                                        favorite && "fill-primary text-primary",
                                    )}
                                />
                                {favorite ? "已收藏" : "收藏"}
                            </Button>
                        </div>
                    </div>
                </div>

                <section className="mt-8">
                    <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
                        <div>
                            <h2 className="text-sm font-semibold text-foreground">
                                章节
                            </h2>
                            <p className="mt-1 text-xs text-muted-foreground">
                                {chapters.length === 0
                                    ? "只有站外章节，已隐藏"
                                    : `共 ${chapters.length} 话`}
                            </p>
                        </div>
                        {chapters.length > 0 && !selecting && (
                            <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => setSelecting(true)}
                            >
                                <Download className="size-3.5" />
                                下载章节
                            </Button>
                        )}
                    </header>

                    {chapters.length === 0 ? (
                        <EmptyState
                            icon={<BookOpen className="size-7" />}
                            text="没有可看的章节"
                            hint="这类章节在站外，应用打不开"
                        />
                    ) : (
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                            {chapters.map((ch, i) => (
                                <Reveal
                                    key={ch.index}
                                    delay={Math.min(i * 12, 240)}
                                >
                                    <ChapterTile
                                        chapter={ch}
                                        current={ch.index === resume}
                                        state={
                                            onDisk.has(ch.index)
                                                ? "downloaded"
                                                : queued.has(ch.index)
                                                  ? "queued"
                                                  : "none"
                                        }
                                        selecting={selecting}
                                        selected={selected.has(ch.index)}
                                        source={source!}
                                        comicId={id}
                                        onToggle={() => toggleChapter(ch.index)}
                                    />
                                </Reveal>
                            ))}
                        </div>
                    )}

                    {selecting && (
                        <div className="sticky bottom-3 z-20 mt-4 flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-card/95 px-3 py-2 shadow-2xl backdrop-blur-xl">
                            <Button
                                variant="ghost"
                                size="sm"
                                disabled={selectable.length === 0}
                                onClick={() =>
                                    setSelected(
                                        allSelected
                                            ? new Set()
                                            : new Set(
                                                  selectable.map((ch) => ch.index),
                                              ),
                                    )
                                }
                            >
                                {allSelected ? "取消全选" : "全选"}
                            </Button>
                            <span className="flex-1 text-xs tabular-nums text-muted-foreground">
                                已选 {selected.size} 话，可选 {selectable.length} 话
                            </span>
                            <Button
                                variant="primary"
                                size="sm"
                                disabled={selected.size === 0 || submitting !== null}
                                onClick={() => void startDownload()}
                            >
                                {submitting
                                    ? `正在加入下载 ${submitting.done}/${submitting.total}`
                                    : "开始下载"}
                            </Button>
                            <Button
                                variant="ghost"
                                size="icon"
                                aria-label="退出选择"
                                disabled={submitting !== null}
                                onClick={exitSelection}
                            >
                                <X className="size-4" />
                            </Button>
                        </div>
                    )}
                </section>
            </div>
        </>
    );
}

/** 章节块：浏览时是进入阅读的链接，选择模式下是勾选按钮（本地已有的章节不可选）。 */
function ChapterTile({
    chapter: ch,
    current,
    state,
    selecting,
    selected,
    source,
    comicId,
    onToggle,
}: {
    chapter: Chapter;
    current: boolean;
    state: "none" | "downloaded" | "queued";
    selecting: boolean;
    selected: boolean;
    source: string;
    comicId: string;
    onToggle: () => void;
}) {
    /** 本地已有的章节（已下载或排队中）：选择模式下不可勾选。 */
    const local = state !== "none";

    const body = (
        <>
            <span className="min-w-0 flex-1 truncate">{ch.title}</span>
            {state === "downloaded" && (
                <Check
                    className="size-3.5 shrink-0 text-success"
                    aria-label="已下载"
                />
            )}
            {state === "queued" && <Tag>排队中</Tag>}
            {selecting && !local && (
                <span
                    className={cn(
                        "grid size-4 shrink-0 place-items-center rounded-full border",
                        selected
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border-strong",
                    )}
                >
                    {selected && <Check className="size-3" />}
                </span>
            )}
        </>
    );

    const className = cn(
        "flex h-full w-full items-center gap-2 rounded-md border px-3 py-2.5 text-left text-sm transition-colors",
        selecting && selected
            ? "border-primary/60 bg-primary/12 text-foreground"
            : selecting && local
              ? "border-border bg-card/50 text-muted-foreground"
              : current
                ? "border-primary/50 bg-primary/10 text-foreground"
                : "border-border bg-card text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
    );

    if (!selecting) {
        return (
            <Link
                to={`/reader/${source}/${encodeURIComponent(comicId)}/${ch.index}`}
                className={className}
            >
                {body}
            </Link>
        );
    }

    return (
        <button
            type="button"
            disabled={local}
            aria-pressed={selected}
            onClick={onToggle}
            className={cn(className, local && "cursor-default")}
        >
            {body}
        </button>
    );
}

function BackButton({ onClick }: { onClick: () => void }) {
    return (
        <Button
            variant="ghost"
            size="sm"
            onClick={onClick}
            className="mb-4 -ml-2 hidden md:inline-flex"
        >
            <ArrowLeft className="size-4" />
            返回
        </Button>
    );
}
