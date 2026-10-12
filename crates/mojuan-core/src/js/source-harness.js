// 源文档的共享测试驱动（node 侧）。
//
// 装载源运行时 + 一份文档，HTML 选择器用 jsdom 实现宿主绑定 __host.select。
// Rust 侧的同名端到端（tests/source_doc_test.rs）用真 QuickJS + 真 scraper 跑同一批
// fixture，两侧跑同一批断言，引擎差异由 Rust 那侧兜底。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

// 路径按本文件的位置解析：这个驱动由 apps/mojuan 的 vitest 跨包加载，cwd 是那个包，
// 而 jsdom 环境下的 import.meta.url 不是 file: 协议。
const JS_DIR = import.meta.dirname;
const FIXTURE_DIR = join(JS_DIR, "..", "..", "tests", "fixtures");

/** 源文档目录（webtoons 是内置文档，其余 8 份同时是待发布的文档与回归数据）。 */
export const DOC_DIR = join(JS_DIR, "sources");

const RUNTIME = readFileSync(join(JS_DIR, "runtime.js"), "utf8");

/** 读一份 fixture（站点响应的真实转储）。 */
export function readFixture(name) {
    return readFileSync(join(FIXTURE_DIR, name), "utf8");
}

/** 读一份源文档。 */
export function readDoc(id) {
    return JSON.parse(readFileSync(join(DOC_DIR, `${id}.json`), "utf8"));
}

/** 宿主绑定的 node 实现：jsdom 的 CSS 选择器。 */
function hostSelect(html, selector) {
    const dom = new JSDOM(html);
    const out = [];
    for (const el of dom.window.document.querySelectorAll(selector)) {
        const attrs = {};
        for (const a of el.attributes) attrs[a.name] = a.value;
        out.push({ attrs, text: el.textContent, html: el.innerHTML });
    }
    return JSON.stringify(out);
}

/** 装载一份文档，返回运行时的 plan / parse。 */
export function loadRuntime(doc) {
    const code = `var DOC = ${JSON.stringify(doc)};\n${RUNTIME}\n;return globalThis.__source;`;
    globalThis.__host = { select: hostSelect };
    return new Function(code)();
}

const MAX_STEPS = 8;

/** 跑一个 op：反复 plan → 取响应 → parse，返回 parse 的结果 `{data, hidden}`。 */
export function runOp(doc, op, payload, options = {}) {
    const { ctx = {}, responses = {} } = options;
    const runtime = loadRuntime(doc);
    for (let i = 0; i < MAX_STEPS; i++) {
        const step = JSON.parse(
            runtime.plan(JSON.stringify({ op, payload, ctx, responses })),
        );
        if (step.abort) return { aborted: true, data: null, hidden: [] };
        if (step.done) break;
        if (!(step.name in responses)) {
            throw new Error(`测试没有为 ${op} 的步骤 ${step.name}（${step.url}）提供响应`);
        }
    }
    return JSON.parse(runtime.parse(JSON.stringify({ op, payload, ctx, responses })));
}

/** 同上，只取 data。 */
export function runData(doc, op, payload, options) {
    return runOp(doc, op, payload, options).data;
}

/** 取某一步的 URL（不实际抓取），用于断言 URL 构造。 */
export function planStep(doc, op, payload, options = {}) {
    const { ctx = {}, responses = {} } = options;
    const runtime = loadRuntime(doc);
    return JSON.parse(runtime.plan(JSON.stringify({ op, payload, ctx, responses })));
}

/** 首步响应名（单步请求的 op 用）。 */
export function firstStepName(doc, op) {
    const spec = doc.ops[op];
    if (!spec || !spec.request || !spec.request.length) return "";
    return spec.request[0].name;
}

/** 单步请求的 op：把一份响应体直接喂进去。 */
export function runSingle(doc, op, payload, body, ctx = {}) {
    return runOp(doc, op, payload, {
        ctx,
        responses: { [firstStepName(doc, op)]: body },
    });
}
