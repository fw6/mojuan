import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { SourceDocEditor } from "./source-doc-editor";

// S2 seam：源文档编辑器。测的是编辑器的外部行为——呈现的文档内容、外部值变化时同步、
// 按 source_schema 给出的 schema 补全与校验、变更回调与只读标志。
// schema 走 source_schema 命令，所以 mock 的是命令层（../api）。

vi.mock("../api", () => ({
    sourceSchema: vi.fn(),
}));

import { sourceSchema } from "../api";

const mockedSchema = vi.mocked(sourceSchema);

/** 测试用的文档 schema：已知键 id 与 title，别的键不认。 */
const SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: {
        id: { type: "string", description: "sourceId" },
        title: { type: "string" },
    },
};

beforeEach(() => {
    mockedSchema.mockReset();
    mockedSchema.mockResolvedValue(JSON.stringify(SCHEMA));
});

afterEach(() => {
    cleanup();
});

/** 编辑器呈现出来的文档文本（CodeMirror 每行一个 div，拼接即文档去掉换行）。 */
function editorText(container: HTMLElement): string {
    return content(container).textContent ?? "";
}

function content(container: HTMLElement): HTMLElement {
    const el = container.querySelector<HTMLElement>(".cm-content");
    if (!el) throw new Error("编辑器没有渲染出内容区");
    return el;
}

/** 去掉空白再比较：CodeMirror 的行是 div，拼接时换行与缩进不保留。 */
function compact(text: string): string {
    return text.replace(/\s+/g, "");
}

function pressKey(target: Element, init: KeyboardEventInit): void {
    target.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
    );
}

const RIGHT = { key: "ArrowRight", code: "ArrowRight", keyCode: 39 };
const ENTER = { key: "Enter", code: "Enter", keyCode: 13 };
const CTRL_SPACE = { key: " ", code: "Space", keyCode: 32, ctrlKey: true };

/** 光标从文档开头右移 n 个字符。 */
function moveCaret(container: HTMLElement, chars: number): void {
    for (let i = 0; i < chars; i++) pressKey(content(container), RIGHT);
}

/** 编辑器里的校验提示（零长度的语法错误是 lintPoint，跨字符的 schema 错误是 lintRange）。 */
function errorMarks(container: HTMLElement): Element[] {
    return Array.from(
        container.querySelectorAll(".cm-lintPoint-error, .cm-lintRange-error"),
    );
}

/** 补全浮层里列出的候选（label 是键名，detail 是类型）。 */
function completionLabels(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll(".cm-completionLabel")).map(
        (el) => el.textContent ?? "",
    );
}

/** CodeMirror 把主题与高亮的样式注入文档，这里取回它们的 CSS 文本。 */
function injectedStyles(): string {
    const sheets = Array.from(document.styleSheets)
        .map((sheet) => {
            try {
                return Array.from(sheet.cssRules)
                    .map((rule) => rule.cssText)
                    .join("\n");
            } catch {
                return "";
            }
        })
        .join("\n");
    const tags = Array.from(document.head.querySelectorAll("style"))
        .map((el) => el.textContent ?? "")
        .join("\n");
    return `${sheets}\n${tags}`;
}

describe("SourceDocEditor 呈现文档", () => {
    it("挂载后渲染出传入的文档内容", async () => {
        const doc = '{\n  "id": "demo"\n}';
        const { container } = render(
            <SourceDocEditor value={doc} onChange={() => {}} />,
        );
        expect(compact(editorText(container))).toBe(compact(doc));
    });

    it("外部传入的值变化时把新文档同步进编辑器", async () => {
        const { container, rerender } = render(
            <SourceDocEditor value='{"id": "a"}' onChange={() => {}} />,
        );
        rerender(<SourceDocEditor value='{"id": "b"}' onChange={() => {}} />);
        expect(compact(editorText(container))).toBe(compact('{"id": "b"}'));
    });

    it("同步外部值时不再回调 onChange", async () => {
        const onChange = vi.fn();
        const { rerender } = render(
            <SourceDocEditor value='{"id": "a"}' onChange={onChange} />,
        );
        rerender(<SourceDocEditor value='{"id": "b"}' onChange={onChange} />);
        expect(onChange).not.toHaveBeenCalled();
    });

    it("配色取自应用令牌", async () => {
        render(<SourceDocEditor value={'{"id": "demo"}'} onChange={() => {}} />);
        const css = injectedStyles();
        // 编辑器底色、正文与 JSON 各记号的颜色都是应用令牌
        for (const token of [
            "var(--card)",
            "var(--foreground)",
            "var(--primary)",
            "var(--success)",
            "var(--accent)",
            "var(--warning)",
        ]) {
            expect(css).toContain(token);
        }
    });
});

describe("SourceDocEditor 校验与补全", () => {
    it("文档不是合法 JSON 时报出语法错误", async () => {
        const { container } = render(
            <SourceDocEditor value={'{"id": }'} onChange={() => {}} />,
        );
        await waitFor(
            () => {
                expect(errorMarks(container).length).toBeGreaterThan(0);
            },
            { timeout: 3000 },
        );
    });

    it("按 source_schema 给出的 schema 校验：未知键名给出提示", async () => {
        const { container } = render(
            <SourceDocEditor value={'{"id": "x", "nope": 1}'} onChange={() => {}} />,
        );
        await waitFor(
            () => {
                const marked = errorMarks(container)
                    .map((el) => el.textContent ?? "")
                    .join(" ");
                expect(marked).toContain("nope");
            },
            { timeout: 3000 },
        );
        expect(mockedSchema).toHaveBeenCalled();
    });

    it("按 schema 提供补全：属性名里给出文档的键名", async () => {
        // 文档合法（空键名），光标停在两个引号之间时补全应给出 schema 里的键名
        const { container } = render(
            <SourceDocEditor value={'{\n  "": 1\n}'} onChange={() => {}} />,
        );
        // schema 生效后才有校验提示，等它出现再要补全
        await waitFor(
            () => {
                expect(errorMarks(container).length).toBeGreaterThan(0);
            },
            { timeout: 3000 },
        );
        moveCaret(container, 5);
        pressKey(content(container), CTRL_SPACE);
        await waitFor(
            () => {
                expect(completionLabels(container)).toEqual(["id", "title"]);
            },
            { timeout: 3000 },
        );
    });
});

describe("SourceDocEditor 变更回调与只读", () => {
    it("编辑文档时把新文档交给 onChange", async () => {
        const onChange = vi.fn();
        const { container } = render(
            <SourceDocEditor value="{}" onChange={onChange} />,
        );
        moveCaret(container, 1);
        pressKey(content(container), ENTER);
        expect(onChange).toHaveBeenLastCalledWith("{\n  \n}");
        expect(compact(editorText(container))).toBe(compact("{\n  \n}"));
    });

    it("只读时仍呈现文档，但不接受输入", async () => {
        const onChange = vi.fn();
        const { container } = render(
            <SourceDocEditor value="{}" onChange={onChange} readOnly />,
        );
        expect(compact(editorText(container))).toBe("{}");
        expect(content(container).getAttribute("contenteditable")).toBe("false");

        moveCaret(container, 1);
        pressKey(content(container), ENTER);
        expect(onChange).not.toHaveBeenCalled();
        expect(compact(editorText(container))).toBe("{}");
    });
});
