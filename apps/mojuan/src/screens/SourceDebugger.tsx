import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import {
    crawlDebug,
    type DebugHidden,
    type DebugHiddenEntry,
    type DebugRun,
    type DebugStep,
} from "../api";
import { SourceDocEditor } from "../components/source-doc-editor";
import { Button } from "../components/beui/button";
import { Input } from "../components/beui/input";
import { Panel } from "../components/ui";
import { cn } from "../lib/utils";

/**
 * 源调试台：左边写一份源文档，右边选 op、填参数、跑一次，下面按顺序列出这次运行走过的每一步。
 *
 * 与「手动导入」的分工：导入是「我信这份文档，装上」，调试台是「我不确定，先跑一次看看」。
 * 运行走 crawl_debug——真实网络、真实请求头、真实渲染通道，不做重试也不读缓存，
 * 调试台里的文档与已装源完全隔离。
 */

/** 可调试的 op（与 core 的 OPS 一致）。 */
const OPS = ["categories", "search", "category", "detail", "images"] as const;

type DebugOp = (typeof OPS)[number];

/** 参数输入的字段名就是 payload 的键名（与 core 的取数契约一致）。 */
type ParamName =
    | "keyword"
    | "page"
    | "label"
    | "url"
    | "comicId"
    | "chapterIndex";

interface ParamField {
    name: ParamName;
    /** 输入框里的提示：这个值在源文档的哪里用得上。 */
    hint: string;
    /** 数字字段：填成数字就按数字放进 payload（页码、话序号都是数字）。 */
    number?: boolean;
}

/** 每个 op 渲染哪些参数输入——作者不必手写 JSON。 */
const OP_FIELDS: Record<DebugOp, ParamField[]> = {
    categories: [],
    search: [
        { name: "keyword", hint: "搜索词（模板里的 {keyword}）" },
        { name: "page", hint: "第几页（模板里的 {page}）", number: true },
    ],
    category: [
        { name: "label", hint: "分类表里的名字（{categoryUrl} 按它查表）" },
        { name: "url", hint: "直接给分类页地址（模板里的 {url}）" },
        { name: "page", hint: "第几页（模板里的 {page}）", number: true },
    ],
    detail: [{ name: "comicId", hint: "漫画 id（模板里的 {comicId}）" }],
    images: [
        { name: "comicId", hint: "漫画 id（模板里的 {comicId}）" },
        { name: "chapterIndex", hint: "话序号（模板里的 {chapterIndex}）", number: true },
    ],
};

/** 参数输入的初值：全部留空（留空即不放进 payload）。 */
const NO_VALUES: Record<ParamName, string> = {
    keyword: "",
    page: "",
    label: "",
    url: "",
    comicId: "",
    chapterIndex: "",
};

/** 会话隐藏值的初值：一次运行都没跑过，会话是空的。 */
const NO_HIDDEN: DebugHidden = {};

/** 响应体在步骤日志里的预览长度；更长的部分由「展开全文」按需渲染。 */
const PREVIEW_CHARS = 1200;

const STAGE_LABEL: Record<DebugStep["stage"], string> = {
    validate: "文档校验",
    plan: "请求计划",
    fetch: "抓取响应",
    parse: "解析输出",
};

/** 按 op 把填好的参数拼成 payload：留空的字段不放进去。 */
function buildPayload(
    op: DebugOp,
    values: Record<ParamName, string>,
): Record<string, unknown> {
    const payload: Record<string, unknown> = {};
    for (const field of OP_FIELDS[op]) {
        const raw = values[field.name].trim();
        if (!raw) continue;
        const n = Number(raw);
        payload[field.name] =
            field.number && Number.isFinite(n) ? n : raw;
    }
    return payload;
}

export default function SourceDebugger() {
    const [document, setDocument] = useState("");
    const [op, setOp] = useState<DebugOp>("categories");
    const [values, setValues] = useState<Record<ParamName, string>>({
        ...NO_VALUES,
    });
    const [running, setRunning] = useState(false);
    const [result, setResult] = useState<DebugRun | null>(null);
    // 会话累积的隐藏值：一次运行交出来的值留下来，下一次运行带进去（与文档版本无关）
    const [hidden, setHidden] = useState<DebugHidden>(NO_HIDDEN);
    // 命令本身报错（不是运行记录里的失败）：Rust 侧抛出的原因
    const [thrown, setThrown] = useState<string | null>(null);

    async function run() {
        setRunning(true);
        // 上一次的记录属于上一次运行，先清掉，免得读成这一次的步骤
        setResult(null);
        setThrown(null);
        try {
            const record = await crawlDebug(
                document,
                op,
                buildPayload(op, values),
                hidden,
            );
            setResult(record);
            // core 交回的是一次运行之后的完整快照，会话就按它更新
            setHidden(record.hidden);
        } catch (e) {
            setThrown(e instanceof Error ? e.message : String(e));
        } finally {
            setRunning(false);
        }
    }

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            {/* 窄屏的标题由外壳的顶部栏给出（子页面），这一行只留副标题 */}
            <header className="flex shrink-0 items-baseline gap-3 border-b border-border px-4 py-3 md:px-6">
                <h1 className="hidden text-sm font-semibold text-foreground md:block">
                    源调试台
                </h1>
                <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    写一份源文档，选一个 op，对真实站点跑一次
                </p>
            </header>

            <div className="flex min-h-0 flex-1 flex-col md:flex-row">
                <section className="flex min-h-[45vh] flex-1 flex-col p-4 md:min-h-0 md:border-r md:border-border md:p-6">
                    <SourceDocEditor value={document} onChange={setDocument} />
                </section>

                <section className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
                    <Panel
                        title="运行"
                        desc="走真实网络、真实请求头与渲染通道；不重试、不读缓存"
                    >
                        <div role="group" aria-label="op" className="flex flex-wrap gap-1.5">
                            {OPS.map((name) => (
                                <Button
                                    key={name}
                                    variant={op === name ? "primary" : "secondary"}
                                    size="sm"
                                    aria-pressed={op === name}
                                    onClick={() => setOp(name)}
                                >
                                    {name}
                                </Button>
                            ))}
                        </div>

                        <div className="mt-4 flex flex-col gap-3">
                            {OP_FIELDS[op].length === 0 ? (
                                <p className="text-xs text-muted-foreground">
                                    这个 op 不需要参数
                                </p>
                            ) : (
                                OP_FIELDS[op].map((field) => (
                                    <Input
                                        key={field.name}
                                        label={field.name}
                                        placeholder={field.hint}
                                        inputMode={field.number ? "numeric" : undefined}
                                        value={values[field.name]}
                                        onChange={(v) =>
                                            setValues((prev) => ({
                                                ...prev,
                                                [field.name]: v,
                                            }))
                                        }
                                    />
                                ))
                            )}
                        </div>

                        <div className="mt-4">
                            <Button
                                variant="primary"
                                size="sm"
                                onClick={() => void run()}
                                disabled={running}
                            >
                                {running ? "运行中…" : "运行"}
                            </Button>
                        </div>

                        <div className="mt-4 border-t border-border pt-3">
                            <SessionHidden
                                hidden={hidden}
                                onClear={() => setHidden(NO_HIDDEN)}
                            />
                        </div>
                    </Panel>

                    <div className="mt-4 flex flex-col gap-4">
                        {thrown && (
                            <Banner kind="fail" title="运行失败">
                                <span className="break-all font-mono">{thrown}</span>
                            </Banner>
                        )}
                        {result && <RunLog run={result} />}
                    </div>
                </section>
            </div>
        </div>
    );
}

/** 会话累积的隐藏值：一次运行交出来的值留下来，下一次运行作为入参带进去。 */
function SessionHidden({
    hidden,
    onClear,
}: {
    hidden: DebugHidden;
    onClear: () => void;
}) {
    const entries = hiddenEntries(hidden);
    return (
        <div role="group" aria-label="会话隐藏值" className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground">会话隐藏值</span>
                <Button variant="ghost" size="sm" onClick={onClear}>
                    清空会话缓存
                </Button>
            </div>
            {entries.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                    还没有累积的隐藏值：跑一次产出隐藏值的 op，它会在下一次运行里带回去
                </p>
            ) : (
                entries.map((entry) => (
                    <div
                        key={`${entry.name}:${entry.key}`}
                        className="break-all font-mono text-xs text-foreground"
                    >
                        {`${entry.name}[${entry.key}] = ${entry.value}`}
                    </div>
                ))
            )}
        </div>
    );
}

/** 会话快照摊平成条目：名 → 键 → 值（core 交回的顺序就是名字与键排序后的）。 */
function hiddenEntries(hidden: DebugHidden): DebugHiddenEntry[] {
    const entries: DebugHiddenEntry[] = [];
    for (const [name, byKey] of Object.entries(hidden)) {
        for (const [key, value] of Object.entries(byKey)) {
            entries.push({ name, key, value });
        }
    }
    return entries;
}

/** 一次运行的记录：结论 + 步骤日志。 */
function RunLog({ run }: { run: DebugRun }) {
    return (
        <>
            {run.ok ? (
                <Banner kind="ok" title="运行成功" />
            ) : (
                <Banner
                    kind="fail"
                    title={run.error ? `停在 ${run.error.stage} 步` : "运行失败"}
                >
                    {run.error && (
                        <span className="break-all font-mono">{run.error.message}</span>
                    )}
                </Banner>
            )}

            <Panel
                title="步骤日志"
                desc={`这次运行走了 ${run.steps.length} 步`}
            >
                <div className="flex flex-col gap-2">
                    {run.steps.map((step, i) => (
                        <StepBlock key={i} index={i + 1} step={step} />
                    ))}
                </div>
            </Panel>
        </>
    );
}

/** 一条结论提示：成功用状态角色、失败用警报角色。 */
function Banner({
    kind,
    title,
    children,
}: {
    kind: "ok" | "fail";
    title: string;
    children?: ReactNode;
}) {
    return (
        <div
            role={kind === "ok" ? "status" : "alert"}
            className={cn(
                "rounded-2xl border px-4 py-3 text-sm text-foreground",
                kind === "ok"
                    ? "border-success/30 bg-success/10"
                    : "border-destructive/30 bg-destructive/10",
            )}
        >
            <div className="font-medium">{title}</div>
            {children && <div className="mt-1 text-xs">{children}</div>}
        </div>
    );
}

/** 一步：一行摘要常驻，内容可折叠。 */
function StepBlock({ index, step }: { index: number; step: DebugStep }) {
    const [open, setOpen] = useState(true);
    return (
        <div className="overflow-hidden rounded-lg border border-border">
            <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen((v) => !v)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-secondary/50"
            >
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {index}
                </span>
                <span className="shrink-0 text-xs font-medium text-foreground">
                    {STAGE_LABEL[step.stage]}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                    {stepSummary(step)}
                </span>
                <ChevronDown
                    className={cn(
                        "size-3.5 shrink-0 text-muted-foreground transition-transform",
                        open && "rotate-180",
                    )}
                />
            </button>
            {open && (
                <div className="border-t border-border px-3 py-2.5">
                    <StepBody step={step} />
                </div>
            )}
        </div>
    );
}

/** 折叠着的那一行摘要：这一步在做什么，细节留给展开后的内容。 */
function stepSummary(step: DebugStep): string {
    switch (step.stage) {
        case "validate":
            return step.ok ? "文档通过校验" : "文档未通过校验";
        case "plan":
            return step.name;
        case "fetch":
            return step.error ? `${step.name}：抓取失败` : step.name;
        case "parse":
            return "解析结果";
    }
}

function StepBody({ step }: { step: DebugStep }) {
    switch (step.stage) {
        case "validate":
            return step.ok ? (
                <p className="text-xs text-muted-foreground">文档通过校验</p>
            ) : (
                <p className="break-all text-xs text-destructive">
                    {step.error ?? "文档未通过校验"}
                </p>
            );
        case "plan":
            return (
                <div className="flex flex-col gap-2.5">
                    <Field label="URL">
                        <code className="break-all font-mono">{step.url}</code>
                    </Field>
                    <Field label="请求头">
                        {Object.keys(step.headers).length === 0 ? (
                            <span className="text-muted-foreground">没有请求头</span>
                        ) : (
                            Object.entries(step.headers).map(([name, value]) => (
                                <div key={name} className="break-all font-mono">
                                    {`${name}: ${value}`}
                                </div>
                            ))
                        )}
                    </Field>
                </div>
            );
        case "fetch":
            return <FetchBody step={step} />;
        case "parse":
            return (
                <div className="flex flex-col gap-2.5">
                    <Field label="输出">
                        <pre className="max-h-80 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-[11px]">
                            {pretty(step.data)}
                        </pre>
                    </Field>
                    {step.hidden.length > 0 && (
                        <Field label="这次运行产出的隐藏值">
                            {step.hidden.map((entry) => (
                                <div
                                    key={`${entry.name}:${entry.key}`}
                                    className="break-all font-mono"
                                >
                                    {`${entry.name}[${entry.key}] = ${entry.value}`}
                                </div>
                            ))}
                        </Field>
                    )}
                </div>
            );
    }
}

/** 抓取步：URL 加响应体。响应体先给预览，更长的部分按需展开；被 core 截断过的标明。 */
function FetchBody({ step }: { step: Extract<DebugStep, { stage: "fetch" }> }) {
    const [expanded, setExpanded] = useState(false);
    const body = step.body ?? "";
    const longer = body.length > PREVIEW_CHARS;

    return (
        <div className="flex flex-col gap-2.5">
            <Field label="URL">
                <code className="break-all font-mono">{step.url}</code>
            </Field>
            {step.error ? (
                <Field label="失败原因">
                    <span className="break-all text-destructive">{step.error}</span>
                </Field>
            ) : (
                <Field label="响应体">
                    {step.truncated && (
                        <p className="mb-1.5 text-warning">
                            响应体超过 512 KB，core 已截断，这里看到的是截断后的内容
                        </p>
                    )}
                    <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/40 p-2 font-mono text-[11px]">
                        {expanded ? body : body.slice(0, PREVIEW_CHARS)}
                    </pre>
                    {longer && (
                        <Button
                            variant="ghost"
                            size="sm"
                            className="mt-1.5"
                            onClick={() => setExpanded((v) => !v)}
                        >
                            {expanded ? "收起" : "展开全文"}
                        </Button>
                    )}
                </Field>
            )}
        </div>
    );
}

/** 一条带名字的内容（URL、请求头、响应体、输出）。 */
function Field({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">{label}</span>
            <div className="text-foreground">{children}</div>
        </div>
    );
}

/** 输出的可读形式：JSON 缩进。 */
function pretty(value: unknown): string {
    return JSON.stringify(value, null, 2) ?? String(value);
}
