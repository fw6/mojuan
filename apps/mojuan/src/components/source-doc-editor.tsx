import { useEffect, useRef } from "react";
import { basicSetup } from "codemirror";
import {
    Annotation,
    Compartment,
    EditorState,
    type Extension,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { jsonSchema } from "codemirror-json-schema";
import { sourceSchema } from "../api";

/**
 * 源文档编辑器：一个可以嵌进页面的 JSON 编辑器，带结构补全与校验。
 *
 * CodeMirror 6 的 React 接线：挂载时建 `EditorView`，卸载时销毁，
 * 外部传入的值变化时把新文档 dispatch 进去，不在每次渲染重建编辑器。
 * 补全与校验的 schema 取 Rust 侧的 `source_schema` 命令，与源文档的校验规则同源。
 */

/** 外部值同步进来的事务：这类变更不再回调 onChange（值本来就是调用方给的）。 */
const externalSync = Annotation.define<boolean>();

/** 编辑器主题：配色全部取自应用令牌（两套主题由令牌自己切换），不新增颜色。 */
const editorTheme = EditorView.theme({
    "&": {
        height: "100%",
        backgroundColor: "var(--card)",
        color: "var(--foreground)",
        fontSize: "0.8125rem",
    },
    ".cm-scroller": {
        fontFamily: "var(--font-mono)",
        lineHeight: "1.6",
    },
    ".cm-content": { padding: "0.5rem 0" },
    ".cm-gutters": {
        backgroundColor: "var(--card)",
        color: "var(--muted-foreground)",
        border: "none",
    },
    ".cm-activeLine": { backgroundColor: "var(--input)" },
    ".cm-activeLineGutter": {
        backgroundColor: "transparent",
        color: "var(--foreground)",
    },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--primary)" },
    ".cm-selectionBackground, .cm-content ::selection": {
        backgroundColor: "color-mix(in oklab, var(--primary) 20%, transparent)",
    },
    "&.cm-focused .cm-selectionBackground": {
        backgroundColor: "color-mix(in oklab, var(--primary) 28%, transparent)",
    },
    ".cm-tooltip": {
        backgroundColor: "var(--popover)",
        color: "var(--popover-foreground)",
        border: "1px solid var(--border)",
    },
    ".cm-tooltip-autocomplete ul li[aria-selected]": {
        backgroundColor: "color-mix(in oklab, var(--primary) 16%, transparent)",
        color: "var(--foreground)",
    },
    // 校验提示的下划线换成应用的失败色（默认那支红不在令牌里）
    ".cm-lintRange-error": {
        backgroundImage: "none",
        textDecoration: "underline wavy var(--destructive)",
    },
});

/** JSON 各记号的颜色：取自应用令牌的语义色。 */
const tokenColors = HighlightStyle.define([
    { tag: tags.propertyName, color: "var(--primary)" },
    { tag: tags.string, color: "var(--success)" },
    { tag: tags.number, color: "var(--accent)" },
    { tag: [tags.bool, tags.null], color: "var(--warning)" },
    {
        tag: [tags.brace, tags.squareBracket, tags.separator],
        color: "var(--muted-foreground)",
    },
    { tag: tags.invalid, color: "var(--destructive)" },
]);

/** 只读的两个面：状态上的 readOnly 让命令与输入处理不改文档，
 * 视图上的 editable 让内容区不接受输入（光标与输入法都不出现）。 */
function readOnlyExtensions(readOnly: boolean): Extension {
    if (!readOnly) return [];
    return [EditorState.readOnly.of(true), EditorView.editable.of(false)];
}

export function SourceDocEditor({
    value,
    onChange,
    readOnly = false,
}: {
    value: string;
    onChange: (value: string) => void;
    /** 只读：编辑器照常呈现文档与校验提示，但不接受输入。 */
    readOnly?: boolean;
}) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const viewRef = useRef<EditorView | null>(null);
    const onChangeRef = useRef(onChange);
    const schemaSlot = useRef(new Compartment()).current;
    const readOnlySlot = useRef(new Compartment()).current;

    // onChange 每次渲染都可能是新函数，编辑器只建一次，把最新的回调交给 updateListener。
    useEffect(() => {
        onChangeRef.current = onChange;
    }, [onChange]);

    useEffect(() => {
        const host = hostRef.current;
        if (!host) return;
        const view = new EditorView({
            doc: value,
            parent: host,
            extensions: [
                basicSetup,
                // schema 还没到时先用空的补全与校验扩展，JSON 高亮照常
                schemaSlot.of(jsonSchema()),
                readOnlySlot.of(readOnlyExtensions(readOnly)),
                editorTheme,
                syntaxHighlighting(tokenColors),
                EditorView.updateListener.of((update) => {
                    if (!update.docChanged) return;
                    if (update.transactions.some((tr) => tr.annotation(externalSync))) return;
                    onChangeRef.current(update.state.doc.toString());
                }),
            ],
        });
        viewRef.current = view;
        return () => {
            viewRef.current = null;
            view.destroy();
        };
        // 挂载时建一次编辑器；value / readOnly 的后续变化走下面的 effect
    }, [schemaSlot, readOnlySlot]);

    // 文档校验与补全的规则来自 Rust 侧的 source_schema 命令，两边同源。
    useEffect(() => {
        let cancelled = false;
        void sourceSchema().then((json) => {
            if (cancelled) return;
            const view = viewRef.current;
            if (!view) return;
            const schema = JSON.parse(json) as Parameters<typeof jsonSchema>[0];
            view.dispatch({
                effects: schemaSlot.reconfigure(jsonSchema(schema)),
            });
        });
        return () => {
            cancelled = true;
        };
    }, [schemaSlot]);

    // 外部值变化（从已装源复制、格式化、换起点）时把新文档同步进来。
    // 值已经一致就不动，免得用户正在输入时被重置光标。
    useEffect(() => {
        const view = viewRef.current;
        if (!view || view.state.doc.toString() === value) return;
        view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: value },
            annotations: externalSync.of(true),
        });
    }, [value]);

    useEffect(() => {
        viewRef.current?.dispatch({
            effects: readOnlySlot.reconfigure(readOnlyExtensions(readOnly)),
        });
    }, [readOnly, readOnlySlot]);

    return (
        <div
            ref={hostRef}
            className="h-full overflow-hidden rounded-md border border-input"
        />
    );
}
