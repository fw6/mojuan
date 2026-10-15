import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { EditorView } from "@codemirror/view";
import SourceDebugger from "./SourceDebugger";
import type { DebugRun } from "../api";

// seam：源调试台页面。测的是页面的外部行为——编辑器里的文档、选的 op、填的参数与会话隐藏值
// 交给 crawl_debug，运行记录按步骤渲染出来，失败时说清停在哪一步；起点从已装源的安装记录里取，
// 安装把文档交给设置页「手动导入」那条路径（写进已装源 + 同步进 Rust 注册表）。
// 命令边界在 ../api（与仓库里其它 screens 测试同一形状），存储域用 test-doubles 的内存 store。

vi.mock("../api", () => ({
    crawlDebug: vi.fn(),
    sourceSchema: vi.fn(),
    syncSources: vi.fn(),
    imgSrc: (url: string) => url,
}));

vi.mock("@tauri-apps/plugin-store", async () =>
    (await import("../lib/storage/test-doubles")).storePlugin,
);

import { crawlDebug, sourceSchema, syncSources } from "../api";
import { PAGES } from "../App";
import { KeepAliveRoutes } from "../components/keep-alive";
import { NAV } from "../lib/nav";
import { resetDoubles, storePlugin } from "../lib/storage/test-doubles";
import type { SourceEntry } from "../lib/storage/sources";

const mockedDebug = vi.mocked(crawlDebug);
const mockedSchema = vi.mocked(sourceSchema);
const mockedSync = vi.mocked(syncSources);

/** 编辑器补全与校验用的 schema（这一页测的是运行流程，给它一份最小 schema）。 */
const SCHEMA = {
    type: "object",
    properties: { id: { type: "string" } },
};

/** 一次跑通的 search 运行记录：校验 → 计划 → 抓取 → 解析。 */
function searchRun(): DebugRun {
    return {
        ok: true,
        data: [{ id: "demo-1", title: "甲" }],
        hidden: { seriesUrl: { "demo-1": "http://example.com/1" } },
        steps: [
            { stage: "validate", ok: true },
            {
                stage: "plan",
                name: "list",
                url: "http://example.com/search?q=%E6%B5%B7%E8%B4%BC",
                headers: { Referer: "http://example.com/" },
            },
            {
                stage: "fetch",
                name: "list",
                url: "http://example.com/search?q=%E6%B5%B7%E8%B4%BC",
                body: '<div class="item" data-id="1"><h3>甲</h3></div>',
                truncated: false,
            },
            {
                stage: "parse",
                data: [{ id: "demo-1", title: "甲" }],
                hidden: [
                    { name: "seriesUrl", key: "demo-1", value: "http://example.com/1" },
                ],
            },
        ],
        error: null,
    };
}

/** 跑一次（默认 op 是 categories）。 */
function run() {
    fireEvent.click(screen.getByRole("button", { name: "运行" }));
}

/** 跑一次并等它跑完：运行中的按钮叫「运行中…」，回到「运行」就是这一次结束了。 */
async function runAndSettle() {
    run();
    await waitFor(() => screen.getByRole("button", { name: "运行" }));
}

/** 一步的内容区（折叠按钮所在的那个步骤块）。 */
function stepBody(header: HTMLElement): HTMLElement {
    const block = header.parentElement;
    if (!block) throw new Error("步骤块没有渲染出来");
    return block;
}

/** 把编辑器里的文档换成给定原文（CodeMirror 的公开 API，相当于作者写进一份文档）。 */
function setEditorText(container: HTMLElement, text: string) {
    const view = EditorView.findFromDOM(container);
    if (!view) throw new Error("编辑器没有渲染出来");
    act(() => {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    });
}

/** 编辑器里现在是什么（单行文档的 textContent 就是原文）。 */
function editorText(container: HTMLElement): string {
    return container.querySelector(".cm-content")?.textContent ?? "";
}

/** 往安装记录里放一份已装源（调试台起点的来源）。 */
async function seedInstalled(id: string, document: string) {
    const store = await storePlugin.load("sources.json");
    await store.set("sources", {
        [id]: { sourceId: id, version: 1, document, updatedAt: 1 },
    });
    await store.set("order", [id]);
}

/** 安装记录里的全部源（断言「装上之后出现在已装源里」用）。 */
async function installedRecords(): Promise<Record<string, SourceEntry>> {
    const store = await storePlugin.load("sources.json");
    return ((await store.get("sources")) ?? {}) as Record<string, SourceEntry>;
}

beforeEach(() => {
    vi.clearAllMocks();
    resetDoubles();
    mockedSchema.mockResolvedValue(JSON.stringify(SCHEMA));
    mockedSync.mockResolvedValue({ sources: [], rejected: [] });
});

afterEach(() => {
    cleanup();
});

describe("源调试台的步骤日志", () => {
    it("按顺序列出这次运行的每一步：计划步给出 URL 与请求头、抓取步给出响应体、解析步给出输出", async () => {
        mockedDebug.mockResolvedValue(searchRun());
        render(<SourceDebugger />);
        fireEvent.click(screen.getByRole("button", { name: "search" }));
        fireEvent.change(screen.getByLabelText("keyword"), {
            target: { value: "海贼" },
        });
        run();

        // 每一步一行，顺序就是运行走过的顺序
        const headers = await screen.findAllByRole("button", { expanded: true });
        const labels = headers.map((el) => el.textContent ?? "");
        expect(labels[0]).toContain("文档校验");
        expect(labels[1]).toContain("请求计划");
        expect(labels[2]).toContain("抓取响应");
        expect(labels[3]).toContain("解析输出");

        // 计划步：求出的 URL 与请求头
        const plan = stepBody(headers[1]);
        expect(
            within(plan).getByText("http://example.com/search?q=%E6%B5%B7%E8%B4%BC"),
        ).toBeTruthy();
        expect(within(plan).getByText("Referer: http://example.com/")).toBeTruthy();

        // 抓取步：响应体
        const fetch = stepBody(headers[2]);
        expect(
            within(fetch).getByText('<div class="item" data-id="1"><h3>甲</h3></div>'),
        ).toBeTruthy();

        // 解析步：输出
        const parse = stepBody(headers[3]);
        expect(within(parse).getByText(/"title": "甲"/)).toBeTruthy();

        // 编辑器里的文档、选的 op 与填的参数一起交给命令
        expect(mockedDebug).toHaveBeenCalledWith("", "search", { keyword: "海贼" }, {});
    });

    it("把编辑器里的文档原文交给命令", async () => {
        mockedDebug.mockResolvedValue(searchRun());
        const { container } = render(<SourceDebugger />);
        const content = container.querySelector<HTMLElement>(".cm-content");
        if (!content) throw new Error("编辑器没有渲染出内容区");
        // 在编辑器里敲一次回车：文档从空变成一行空行，这一行就是随后交给命令的原文
        fireEvent.keyDown(content, { key: "Enter", code: "Enter", keyCode: 13 });

        run();

        await waitFor(() =>
            expect(mockedDebug).toHaveBeenCalledWith("\n", "categories", {}, {}),
        );
    });

    it("响应体过长时给预览，「展开全文」才渲染全文", async () => {
        const body = `<html>${"x".repeat(4000)}</html>`;
        mockedDebug.mockResolvedValue({
            ok: true,
            data: [],
            hidden: {},
            steps: [
                { stage: "validate", ok: true },
                { stage: "fetch", name: "list", url: "http://example.com/1", body },
            ],
            error: null,
        });
        render(<SourceDebugger />);
        run();

        const headers = await screen.findAllByRole("button", { expanded: true });
        const fetch = stepBody(headers[1]);
        // 预览里有开头，没有结尾
        expect(within(fetch).getByText(/^<html>x/)).toBeTruthy();
        expect(within(fetch).queryByText(/<\/html>/)).toBeNull();

        fireEvent.click(within(fetch).getByRole("button", { name: "展开全文" }));
        expect(within(fetch).getByText(/<\/html>/)).toBeTruthy();
    });

    it("core 截断过的响应体标明已截断", async () => {
        mockedDebug.mockResolvedValue({
            ok: true,
            data: [],
            hidden: {},
            steps: [
                { stage: "validate", ok: true },
                {
                    stage: "fetch",
                    name: "list",
                    url: "http://example.com/1",
                    body: "x".repeat(3000),
                    truncated: true,
                },
            ],
            error: null,
        });
        render(<SourceDebugger />);
        run();

        const headers = await screen.findAllByRole("button", { expanded: true });
        expect(within(stepBody(headers[1])).getByText(/已截断/)).toBeTruthy();
    });
});

describe("源调试台的失败提示", () => {
    it("抓取失败时显示停在哪一步与原因", async () => {
        const message = "fetch(search): 连接被拒绝";
        mockedDebug.mockResolvedValue({
            ok: false,
            data: null,
            hidden: {},
            steps: [
                { stage: "validate", ok: true },
                { stage: "plan", name: "list", url: "http://127.0.0.1:1/s", headers: {} },
                {
                    stage: "fetch",
                    name: "list",
                    url: "http://127.0.0.1:1/s",
                    error: message,
                },
            ],
            error: { stage: "fetch", message },
        });
        render(<SourceDebugger />);
        run();

        const alert = await screen.findByRole("alert");
        expect(alert.textContent).toContain("停在 fetch 步");
        expect(alert.textContent).toContain(message);

        // 失败的那一步也把原因写在内容里
        const headers = screen.getAllByRole("button", { expanded: true });
        expect(within(stepBody(headers[2])).getByText(message)).toBeTruthy();
    });

    it("文档没通过校验时只有校验一步，并给出校验错误", async () => {
        const message = "validate(search): missing field `ops`";
        mockedDebug.mockResolvedValue({
            ok: false,
            data: null,
            hidden: {},
            steps: [{ stage: "validate", ok: false, error: message }],
            error: { stage: "validate", message },
        });
        render(<SourceDebugger />);
        fireEvent.click(screen.getByRole("button", { name: "search" }));
        run();

        const alert = await screen.findByRole("alert");
        expect(alert.textContent).toContain("停在 validate 步");
        expect(alert.textContent).toContain(message);
        // 校验没过就没有后续步骤：没有请求、没有解析
        expect(screen.queryByText("请求计划")).toBeNull();
        expect(screen.queryByText("抓取响应")).toBeNull();
    });

    it("命令本身报错时也给出原因", async () => {
        mockedDebug.mockRejectedValue(new Error("没有可用的源运行时"));
        render(<SourceDebugger />);
        run();

        const alert = await screen.findByRole("alert");
        expect(alert.textContent).toContain("没有可用的源运行时");
    });
});

describe("源调试台的参数输入", () => {
    it("按 op 渲染参数输入", async () => {
        mockedDebug.mockResolvedValue(searchRun());
        render(<SourceDebugger />);

        // 默认 categories：没有参数
        expect(screen.getByText("这个 op 不需要参数")).toBeTruthy();
        expect(screen.queryByLabelText("keyword")).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "search" }));
        expect(screen.getByLabelText("keyword")).toBeTruthy();
        expect(screen.getByLabelText("page")).toBeTruthy();
        expect(screen.queryByLabelText("comicId")).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "category" }));
        expect(screen.getByLabelText("label")).toBeTruthy();
        expect(screen.getByLabelText("url")).toBeTruthy();
        expect(screen.getByLabelText("page")).toBeTruthy();

        fireEvent.click(screen.getByRole("button", { name: "detail" }));
        expect(screen.getByLabelText("comicId")).toBeTruthy();
        expect(screen.queryByLabelText("chapterIndex")).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "images" }));
        expect(screen.getByLabelText("comicId")).toBeTruthy();
        expect(screen.getByLabelText("chapterIndex")).toBeTruthy();
    });

    it("把填好的参数按 payload 交给命令，留空的字段不放进去", async () => {
        mockedDebug.mockResolvedValue(searchRun());
        render(<SourceDebugger />);
        fireEvent.click(screen.getByRole("button", { name: "images" }));
        fireEvent.change(screen.getByLabelText("comicId"), {
            target: { value: "demo-1" },
        });
        fireEvent.change(screen.getByLabelText("chapterIndex"), {
            target: { value: "3" },
        });

        run();

        await waitFor(() =>
            expect(mockedDebug).toHaveBeenCalledWith(
                "",
                "images",
                { comicId: "demo-1", chapterIndex: 3 },
                {},
            ),
        );
    });

    it("换 op 之后按新 op 的参数提交", async () => {
        mockedDebug.mockResolvedValue(searchRun());
        render(<SourceDebugger />);
        fireEvent.click(screen.getByRole("button", { name: "search" }));
        fireEvent.change(screen.getByLabelText("keyword"), {
            target: { value: "海贼" },
        });
        fireEvent.change(screen.getByLabelText("page"), { target: { value: "2" } });
        fireEvent.click(screen.getByRole("button", { name: "detail" }));
        fireEvent.change(screen.getByLabelText("comicId"), {
            target: { value: "demo-9" },
        });

        run();

        await waitFor(() =>
            expect(mockedDebug).toHaveBeenCalledWith(
                "",
                "detail",
                { comicId: "demo-9" },
                {},
            ),
        );
    });
});

describe("源调试台的会话隐藏值", () => {
    /** 一次产出隐藏值的 detail 运行：详情页交出系列 URL，键是漫画 id。 */
    function detailRun(): DebugRun {
        return {
            ok: true,
            data: { id: "demo-1", title: "甲" },
            hidden: { seriesUrl: { "demo-1": "http://example.com/series/1" } },
            steps: [
                { stage: "validate", ok: true },
                {
                    stage: "parse",
                    data: { id: "demo-1" },
                    hidden: [
                        {
                            name: "seriesUrl",
                            key: "demo-1",
                            value: "http://example.com/series/1",
                        },
                    ],
                },
            ],
            error: null,
        };
    }

    /** 一次消费隐藏值的 images 运行：入参带进来的系列 URL 仍在返回的快照里。 */
    function imagesRun(): DebugRun {
        return {
            ok: true,
            data: ["http://example.com/1.jpg"],
            hidden: { seriesUrl: { "demo-1": "http://example.com/series/1" } },
            steps: [
                { stage: "validate", ok: true },
                { stage: "parse", data: ["http://example.com/1.jpg"], hidden: [] },
            ],
            error: null,
        };
    }

    it("一次运行产出的隐藏值记进会话，下一次运行带回去", async () => {
        mockedDebug.mockResolvedValueOnce(detailRun());
        mockedDebug.mockResolvedValueOnce(imagesRun());
        render(<SourceDebugger />);

        fireEvent.click(screen.getByRole("button", { name: "detail" }));
        fireEvent.change(screen.getByLabelText("comicId"), {
            target: { value: "demo-1" },
        });
        await runAndSettle();

        fireEvent.click(screen.getByRole("button", { name: "images" }));
        fireEvent.change(screen.getByLabelText("chapterIndex"), {
            target: { value: "0" },
        });
        await runAndSettle();

        // 第一次运行还没有会话隐藏值可带
        expect(mockedDebug).toHaveBeenNthCalledWith(
            1,
            "",
            "detail",
            { comicId: "demo-1" },
            {},
        );
        // 第二次运行带上了第一次产出的值
        expect(mockedDebug).toHaveBeenNthCalledWith(
            2,
            "",
            "images",
            { comicId: "demo-1", chapterIndex: 0 },
            { seriesUrl: { "demo-1": "http://example.com/series/1" } },
        );
    });

    it("页面显示当前会话累积的隐藏值：名字、键、值", async () => {
        mockedDebug.mockResolvedValue(detailRun());
        render(<SourceDebugger />);

        // 一次运行都没跑过：会话是空的
        const empty = screen.getByRole("group", { name: "会话隐藏值" });
        expect(within(empty).queryByText(/seriesUrl/)).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "detail" }));
        fireEvent.change(screen.getByLabelText("comicId"), {
            target: { value: "demo-1" },
        });
        await runAndSettle();

        const session = screen.getByRole("group", { name: "会话隐藏值" });
        expect(
            within(session).getByText(
                "seriesUrl[demo-1] = http://example.com/series/1",
            ),
        ).toBeTruthy();
    });

    it("「清空会话缓存」清空累积值，之后一次运行的入参为空", async () => {
        mockedDebug.mockResolvedValue(detailRun());
        render(<SourceDebugger />);
        fireEvent.click(screen.getByRole("button", { name: "detail" }));
        fireEvent.change(screen.getByLabelText("comicId"), {
            target: { value: "demo-1" },
        });
        await runAndSettle();
        expect(
            within(screen.getByRole("group", { name: "会话隐藏值" })).getByText(
                "seriesUrl[demo-1] = http://example.com/series/1",
            ),
        ).toBeTruthy();

        fireEvent.click(
            screen.getByRole("button", { name: "清空会话缓存" }),
        );
        expect(
            within(screen.getByRole("group", { name: "会话隐藏值" })).queryByText(
                /seriesUrl/,
            ),
        ).toBeNull();

        await runAndSettle();
        expect(mockedDebug).toHaveBeenLastCalledWith(
            "",
            "detail",
            { comicId: "demo-1" },
            {},
        );
    });

    it("改编辑器里的文档不清空会话（隐藏值按名字与键存，与文档版本无关）", async () => {
        mockedDebug.mockResolvedValue(detailRun());
        const { container } = render(<SourceDebugger />);
        fireEvent.click(screen.getByRole("button", { name: "detail" }));
        fireEvent.change(screen.getByLabelText("comicId"), {
            target: { value: "demo-1" },
        });
        await runAndSettle();

        // 在编辑器里敲一次回车：文档从空变成一行空行
        const content = container.querySelector<HTMLElement>(".cm-content");
        if (!content) throw new Error("编辑器没有渲染出内容区");
        fireEvent.keyDown(content, { key: "Enter", code: "Enter", keyCode: 13 });

        expect(
            within(screen.getByRole("group", { name: "会话隐藏值" })).getByText(
                "seriesUrl[demo-1] = http://example.com/series/1",
            ),
        ).toBeTruthy();

        await runAndSettle();
        expect(mockedDebug).toHaveBeenLastCalledWith(
            "\n",
            "detail",
            { comicId: "demo-1" },
            { seriesUrl: { "demo-1": "http://example.com/series/1" } },
        );
    });
});

describe("源调试台的起点", () => {
    /** 一份合法的源文档（单行，编辑器里读回来的原文就是它）。 */
    const DOC = '{"schema":1,"id":"mysite","title":"我的漫画"}';

    it("选一个已装源，把它的文档复制进编辑器", async () => {
        await seedInstalled("mysite", DOC);
        const { container } = render(<SourceDebugger />);

        const select = await screen.findByLabelText("起点");
        await waitFor(() =>
            expect(within(select).getByRole("option", { name: "mysite" })).toBeTruthy(),
        );
        fireEvent.change(select, { target: { value: "mysite" } });

        await waitFor(() => expect(editorText(container)).toBe(DOC));
    });

    it("没有已装源时只有「空白」一项", async () => {
        render(<SourceDebugger />);
        const select = await screen.findByLabelText("起点");
        expect(
            within(select)
                .getAllByRole("option")
                .map((o) => o.textContent),
        ).toEqual(["空白"]);
    });

    it("换回空白清空编辑器", async () => {
        await seedInstalled("mysite", DOC);
        const { container } = render(<SourceDebugger />);
        const select = await screen.findByLabelText("起点");
        await waitFor(() =>
            expect(within(select).getByRole("option", { name: "mysite" })).toBeTruthy(),
        );
        fireEvent.change(select, { target: { value: "mysite" } });
        await waitFor(() => expect(editorText(container)).toBe(DOC));

        fireEvent.change(select, { target: { value: "" } });
        await waitFor(() => expect(editorText(container)).toBe(""));
    });
});

describe("源调试台的安装出口", () => {
    /** 一份合法的源文档（单行，编辑器里读回来的原文就是它）。 */
    const DOC = '{"schema":1,"id":"mysite","title":"我的漫画"}';
    /** 编辑器里的文档不是合法 JSON 时的原文。 */
    const BROKEN = "{ 不是 JSON";
    /** 合法的 JSON、但没有 id。 */
    const NO_ID = '{"schema":1,"title":"没有 id"}';

    function install() {
        fireEvent.click(screen.getByRole("button", { name: "安装这份文档" }));
    }

    it("点安装把编辑器里的文档交给导入路径（写进已装源并同步），装上之后出现在已装源里", async () => {
        const { container } = render(<SourceDebugger />);
        setEditorText(container, DOC);
        install();

        await waitFor(() =>
            expect(mockedSync).toHaveBeenCalledWith({
                sources: [{ id: "mysite", document: DOC }],
            }),
        );
        expect((await installedRecords()).mysite.document).toBe(DOC);
        expect(await screen.findByText("已安装 我的漫画")).toBeTruthy();
    });

    it("文档不是合法 JSON 时不安装，并给出原因", async () => {
        const { container } = render(<SourceDebugger />);
        setEditorText(container, BROKEN);
        install();

        const alert = await screen.findByRole("alert");
        expect(alert.textContent).toContain("安装失败：");
        // 没有走导入路径，也没有写进已装源
        expect(mockedSync).not.toHaveBeenCalled();
        expect(await installedRecords()).toEqual({});
    });

    it("文档缺 id 时不安装，并给出原因", async () => {
        const { container } = render(<SourceDebugger />);
        setEditorText(container, NO_ID);
        install();

        expect((await screen.findByRole("alert")).textContent).toContain(
            "安装失败：源文档缺少 id",
        );
        expect(mockedSync).not.toHaveBeenCalled();
        expect(await installedRecords()).toEqual({});
    });

    it("Rust 侧校验没过时不装上，并给出原因", async () => {
        mockedSync.mockResolvedValue({
            sources: [],
            rejected: [{ id: "mysite", reason: "missing field `ops`" }],
        });
        const { container } = render(<SourceDebugger />);
        setEditorText(container, DOC);
        install();

        expect((await screen.findByRole("alert")).textContent).toContain(
            "文档未通过校验：missing field `ops`",
        );
        expect(await installedRecords()).toEqual({});
    });

    it("Rust 侧拒了这份文档时，原先装着的版本留在已装源里", async () => {
        const OLD = '{"schema":1,"id":"mysite","title":"旧版"}';
        await seedInstalled("mysite", OLD);
        mockedSync.mockResolvedValue({
            sources: [],
            rejected: [{ id: "mysite", reason: "missing field `ops`" }],
        });
        const { container } = render(<SourceDebugger />);
        setEditorText(container, DOC);
        install();

        await screen.findByRole("alert");
        expect((await installedRecords()).mysite.document).toBe(OLD);
    });

    it("编辑器里没有文档时不能点安装", async () => {
        render(<SourceDebugger />);
        expect(
            screen.getByRole("button", { name: "安装这份文档" }).hasAttribute("disabled"),
        ).toBe(true);
    });
});

describe("源调试台的路由", () => {
    /** 从调试台离开（去一个没有页面的路径）再回来。 */
    function Harness() {
        const navigate = useNavigate();
        return (
            <>
                <button onClick={() => navigate("/nowhere")}>离开</button>
                <button onClick={() => navigate("/debug")}>回来</button>
                <KeepAliveRoutes pages={PAGES} />
            </>
        );
    }

    it("挂在 /debug 上，离开即卸载（keep: 0）", () => {
        mockedDebug.mockResolvedValue(searchRun());
        const { container } = render(
            <MemoryRouter initialEntries={["/debug"]}>
                <Harness />
            </MemoryRouter>,
        );
        expect(container.querySelector(".cm-content")).toBeTruthy();

        fireEvent.click(screen.getByText("离开"));
        expect(container.querySelector(".cm-content")).toBeNull();

        fireEvent.click(screen.getByText("回来"));
        expect(container.querySelector(".cm-content")).toBeTruthy();
    });

    it("侧边栏的导航表里没有这一条", () => {
        expect(NAV.some((entry) => entry.to === "/debug")).toBe(false);
    });
});
