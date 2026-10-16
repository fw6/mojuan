import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Sources from "./Sources";
import type { Comic } from "../api";

// vitest 不开 globals（vite.config.ts：#10 seam 测试显式 import）→ RTL 不会自动
// cleanup，DOM 会跨用例泄漏。手动在 afterEach 清理。

// S1 seam：Sources 页（发现 List 页面，tab 切换）。mock api 层，
// 验证分类 tab / 源 tab / 搜索三种加载路径与错误行展示。

vi.mock("../api", () => ({
    crawl: vi.fn(),
    crawlCached: vi.fn(),
    mojuanVersion: vi.fn().mockResolvedValue("test"),
    sourceErrors: vi.fn().mockResolvedValue({}),
    imgSrc: (url: string) => url,
}));

vi.mock("../lib/storage/settings", () => ({
    getSettings: vi.fn(),
    rememberDiscovery: vi.fn().mockResolvedValue(undefined),
    DEFAULT_IMAGE_CACHE_LIMIT: 1024 * 1024 * 1024,
}));

vi.mock("../lib/storage/sources", () => ({
    persistSourceCache: vi.fn().mockResolvedValue(undefined),
    whenSourcesReady: vi.fn().mockResolvedValue(undefined),
}));

import { crawl, crawlCached, sourceErrors } from "../api";
import { DEFAULT_IMAGE_CACHE_LIMIT, getSettings, rememberDiscovery } from "../lib/storage/settings";
import { persistSourceCache } from "../lib/storage/sources";
import { applySources } from "../lib/sources";

const mockedCrawl = vi.mocked(crawl);
const mockedCached = vi.mocked(crawlCached);
const mockedErrors = vi.mocked(sourceErrors);
const mockedSettings = vi.mocked(getSettings);
const mockedRemember = vi.mocked(rememberDiscovery);

/** 默认设置：没有记忆的浏览位置 → 发现页从第一个源开始。 */
const DEFAULT_SETTINGS = {
    downloadDir: null,
    darkMode: false,
    autoTrim: false,
    followUpdate: true,
    lastSource: null as string | null,
    lastCategory: {} as Record<string, string>,
    followCheckedAt: null as number | null,
    imageCacheLimit: DEFAULT_IMAGE_CACHE_LIMIT,
};

function comic(over: Partial<Comic> = {}): Comic {
    return {
        id: "x",
        source: "mangadex",
        sourceTitle: "MangaDex",
        title: "海贼王",
        author: "尾田荣一郎",
        intro: "",
        cover: "https://example.com/c.jpg",
        status: "serial",
        updateTime: "",
        lastChapter: "",
        tags: [],
        lastReadChapter: 0,
        lastReadTime: 0,
        ...over,
    };
}

/** categories → [动作, 恋爱]；category 按 label 返回单条漫画；search 返回一条。 */
function setupCrawl() {
    mockedCrawl.mockImplementation((op: string, source: string, payload: unknown) => {
        if (op === "categories") return Promise.resolve(["动作", "恋爱"]);
        const p = (payload ?? {}) as { label?: string; keyword?: string };
        if (op === "category") {
            return Promise.resolve([
                comic({ id: `${source}-${p.label}`, title: `${source}-${p.label}` }),
            ]);
        }
        if (op === "search") {
            return Promise.resolve([comic({ id: `s-${p.keyword}`, title: p.keyword ?? "" })]);
        }
        return Promise.resolve([]);
    });
}

function renderSources() {
    return render(
        <MemoryRouter>
            <Sources />
        </MemoryRouter>,
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    setupCrawl();
    // 源清单与热链对来自源文档（真实启动由源同步填充）
    applySources([
        { id: "mangadex", title: "MangaDex", hotlinkReferers: [] },
        { id: "webtoons", title: "Webtoons", hotlinkReferers: [] },
        { id: "copymanga", title: "Copymanga", hotlinkReferers: [] },
        { id: "dongman", title: "咚漫", hotlinkReferers: [] },
        { id: "manhuagui", title: "漫画柜", hotlinkReferers: [] },
        { id: "baozimh", title: "包子漫画", hotlinkReferers: [] },
        { id: "nnhanman", title: "鸟鸟韩漫", hotlinkReferers: [] },
        { id: "kxmanhua", title: "开心看漫画", hotlinkReferers: [] },
        { id: "hentara", title: "Hentara", hotlinkReferers: [] },
    ]);
    // 默认无缓存、无源错误：各用例走干净路径，需要的用例自行覆盖实现
    mockedCached.mockResolvedValue(null);
    mockedErrors.mockResolvedValue({});
    mockedSettings.mockResolvedValue(DEFAULT_SETTINGS);
});

afterEach(() => {
    cleanup();
});

describe("Sources 发现 List 页面（tab 切换）", () => {
    it("挂载即加载分类 tab，默认加载第一个分类的列表", async () => {
        renderSources();
        expect(await screen.findByRole("tab", { name: "动作" })).toBeTruthy();
        expect(screen.getByRole("tab", { name: "恋爱" })).toBeTruthy();
        await waitFor(() =>
            expect(mockedCrawl).toHaveBeenCalledWith("category", "mangadex", {
                label: "动作",
            }),
        );
        expect(await screen.findByText("mangadex-动作")).toBeTruthy();
    });

    it("切换分类 tab 重新加载该分类列表", async () => {
        renderSources();
        await screen.findByRole("tab", { name: "恋爱" });
        fireEvent.click(screen.getByRole("tab", { name: "恋爱" }));
        await waitFor(() =>
            expect(mockedCrawl).toHaveBeenCalledWith("category", "mangadex", {
                label: "恋爱",
            }),
        );
        expect(await screen.findByText("mangadex-恋爱")).toBeTruthy();
    });

    it("经源选择面板切换源，重新加载该源的分类与列表", async () => {
        renderSources();
        await screen.findByRole("tab", { name: "动作" });
        // 页头的当前源按钮打开面板 → 选 Webtoons
        fireEvent.click(screen.getByRole("button", { name: "MangaDex" }));
        fireEvent.click(await screen.findByRole("button", { name: "Webtoons" }));
        await waitFor(() =>
            expect(mockedCrawl).toHaveBeenCalledWith("categories", "webtoons", {}),
        );
        await waitFor(() =>
            expect(mockedCrawl).toHaveBeenCalledWith("category", "webtoons", {
                label: "动作",
            }),
        );
        expect(await screen.findByText("webtoons-动作")).toBeTruthy();
    });

    it("搜索触发 search op，列表加载后回灌当前源的进程内缓存", async () => {
        renderSources();
        await screen.findByRole("tab", { name: "动作" });
        fireEvent.change(screen.getByPlaceholderText("搜索漫画标题…"), {
            target: { value: "海贼王" },
        });
        // 列表还在取时按钮叫「加载中…」且不可点，等它回到「搜索」
        fireEvent.click(await screen.findByRole("button", { name: "搜索" }));
        await waitFor(() =>
            expect(mockedCrawl).toHaveBeenCalledWith("search", "mangadex", {
                keyword: "海贼王",
            }),
        );
        // 回灌的是当前源；没有持久缓存的源 dump 出空对象、不写存储（storage 层测）
        await waitFor(() => expect(persistSourceCache).toHaveBeenCalledWith("mangadex"));
    });

    it("Webtoons 源列表加载后回灌该源缓存", async () => {
        mockedCrawl.mockImplementation((op: string, source: string, payload: unknown) => {
            if (op === "categories") return Promise.resolve(["动作"]);
            const p = (payload ?? {}) as { label?: string };
            if (op === "category") {
                return Promise.resolve([
                    comic({ id: `webtoons-1`, source: "webtoons", title: `${source}-${p.label}` }),
                ]);
            }
            return Promise.resolve([]);
        });
        renderSources();
        await screen.findByRole("tab", { name: "动作" });
        fireEvent.click(screen.getByRole("button", { name: "MangaDex" }));
        fireEvent.click(await screen.findByRole("button", { name: "Webtoons" }));
        await waitFor(() => expect(persistSourceCache).toHaveBeenCalledWith("webtoons"));
    });

    it("源错误行显示最近一次错误（wayfinder #17）", async () => {
        mockedCrawl.mockImplementation((op: string) => {
            if (op === "categories") return Promise.resolve(["动作"]);
            return Promise.resolve([]);
        });
        mockedErrors.mockResolvedValue({
            mangadex: { message: "fetch(category): boom\n@1:2", at: 1 },
        });
        renderSources();
        expect(await screen.findByText(/加载失败：fetch\(category\): boom/)).toBeTruthy();
    });

    // ---- 结果缓存（stale-while-revalidate）----

    it("缓存新鲜时跳过列表请求（SWR：窗口内直接用缓存）", async () => {
        mockedCached.mockImplementation((op: string) =>
            op === "category"
                ? Promise.resolve({
                      data: [comic({ id: "cached-1", title: "缓存漫画" })],
                      fetchedAt: Date.now(),
                  })
                : Promise.resolve(null),
        );
        renderSources();
        expect(await screen.findByText("缓存漫画")).toBeTruthy();
        // 分类列表仍拉最新；该分类的列表请求被新鲜窗口跳过
        await waitFor(() =>
            expect(mockedCrawl).toHaveBeenCalledWith("categories", "mangadex", {}),
        );
        expect(mockedCrawl).not.toHaveBeenCalledWith("category", "mangadex", {
            label: "动作",
        });
    });

    it("缓存过期时拉最新覆盖（SWR：revalidate）", async () => {
        mockedCached.mockImplementation((op: string) =>
            op === "category"
                ? Promise.resolve({
                      data: [comic({ id: "stale-1", title: "旧列表" })],
                      fetchedAt: Date.now() - 10 * 60 * 1000,
                  })
                : Promise.resolve(null),
        );
        renderSources();
        // 缓存过期 → crawl 拉最新，旧列表被替换
        expect(await screen.findByText("mangadex-动作")).toBeTruthy();
        expect(mockedCrawl).toHaveBeenCalledWith("category", "mangadex", {
            label: "动作",
        });
    });

    it("源返回空列表时保留缓存列表（错误行另行提示）", async () => {
        mockedCached.mockImplementation((op: string) =>
            op === "category"
                ? Promise.resolve({
                      data: [comic({ id: "cached-1", title: "缓存漫画" })],
                      fetchedAt: Date.now() - 10 * 60 * 1000,
                  })
                : Promise.resolve(null),
        );
        mockedCrawl.mockImplementation((op: string) => {
            if (op === "categories") return Promise.resolve(["动作"]);
            return Promise.resolve([]);
        });
        renderSources();
        expect(await screen.findByText("缓存漫画")).toBeTruthy();
        await waitFor(() =>
            expect(mockedCrawl).toHaveBeenCalledWith("category", "mangadex", {
                label: "动作",
            }),
        );
        // 空结果不覆盖缓存展示
        expect(screen.getByText("缓存漫画")).toBeTruthy();
    });

    // ---- 源选择面板（切换源收进底部面板）----

    it("面板列出全部源，当前源带标记", async () => {
        renderSources();
        await screen.findByRole("tab", { name: "动作" });
        fireEvent.click(screen.getByRole("button", { name: "MangaDex" }));
        expect(await screen.findByRole("dialog", { name: "漫画源" })).toBeTruthy();
        // 面板里每个源一行（9 个），当前源行标 aria-current
        expect(screen.getAllByRole("listitem")).toHaveLength(9);
        const current = screen
            .getAllByRole("button", { name: "MangaDex" })
            .find((el) => el.getAttribute("aria-current") === "true");
        expect(current).toBeTruthy();
    });

    it("标出最近失败的源（产品原则：源可以坏，应用不能假）", async () => {
        mockedErrors.mockResolvedValue({
            webtoons: { message: "fetch(category): boom\n@1:2", at: 1 },
        });
        renderSources();
        await screen.findByRole("tab", { name: "动作" });
        fireEvent.click(screen.getByRole("button", { name: "MangaDex" }));
        expect(await screen.findByText("上次加载失败")).toBeTruthy();
    });

    it("打开面板焦点落在当前源行，关闭后回到页头按钮", async () => {
        renderSources();
        await screen.findByRole("tab", { name: "动作" });
        const trigger = screen.getByRole("button", { name: "MangaDex" });
        fireEvent.click(trigger);
        const row = (await screen.findAllByRole("button", { name: "MangaDex" })).find(
            (el) => el !== trigger,
        )!;
        await waitFor(() => expect(document.activeElement).toBe(row));
        fireEvent.keyDown(window, { key: "Escape" });
        await waitFor(() => expect(document.activeElement).toBe(trigger));
    });

    // ---- 浏览位置持久化（重启后回到上次的源与分类）----

    it("重启后回到上次的源与该源记忆的分类", async () => {
        mockedSettings.mockResolvedValue({
            ...DEFAULT_SETTINGS,
            lastSource: "webtoons",
            lastCategory: { webtoons: "恋爱" },
        });
        renderSources();
        await waitFor(() =>
            expect(mockedCrawl).toHaveBeenCalledWith("category", "webtoons", {
                label: "恋爱",
            }),
        );
        expect(await screen.findByText("webtoons-恋爱")).toBeTruthy();
    });

    it("记忆的分类已不在该源时退回第一个分类", async () => {
        mockedSettings.mockResolvedValue({
            ...DEFAULT_SETTINGS,
            lastSource: "webtoons",
            lastCategory: { webtoons: "已经下线的分类" },
        });
        renderSources();
        await waitFor(() =>
            expect(mockedCrawl).toHaveBeenCalledWith("category", "webtoons", {
                label: "动作",
            }),
        );
    });

    it("切换源与分类写回浏览位置", async () => {
        renderSources();
        await screen.findByRole("tab", { name: "动作" });
        fireEvent.click(screen.getByRole("button", { name: "MangaDex" }));
        fireEvent.click(await screen.findByRole("button", { name: "Webtoons" }));
        await waitFor(() => expect(mockedRemember).toHaveBeenCalledWith("webtoons"));
        await screen.findByRole("tab", { name: "恋爱" });
        fireEvent.click(screen.getByRole("tab", { name: "恋爱" }));
        await waitFor(() =>
            expect(mockedRemember).toHaveBeenCalledWith("webtoons", "恋爱"),
        );
    });

    // ---- 搜索是独立区块（不与分类 tabs 同屏）----

    async function searchFor(kw: string) {
        fireEvent.change(screen.getByPlaceholderText("搜索漫画标题…"), {
            target: { value: kw },
        });
        fireEvent.click(await screen.findByRole("button", { name: "搜索" }));
    }

    it("搜索时分类 tabs 让位给搜索头", async () => {
        renderSources();
        await screen.findByRole("tab", { name: "动作" });
        await searchFor("海贼王");
        await waitFor(() => expect(screen.queryByRole("tab")).toBeNull());
        expect(screen.getByRole("button", { name: "退出搜索" })).toBeTruthy();
        expect(await screen.findByText("1 部作品")).toBeTruthy();
    });

    it("搜索无结果时给出搜索自己的空状态", async () => {
        mockedCrawl.mockImplementation((op: string) => {
            if (op === "categories") return Promise.resolve(["动作"]);
            if (op === "category") return Promise.resolve([comic({ id: "c1" })]);
            return Promise.resolve([]);
        });
        renderSources();
        await screen.findByRole("tab", { name: "动作" });
        await searchFor("不存在的作品");
        expect(await screen.findByText("没有找到相关作品")).toBeTruthy();
        expect(screen.getByText("换个关键词试试")).toBeTruthy();
    });

    it("退出搜索回到搜索前停留的分类", async () => {
        renderSources();
        await screen.findByRole("tab", { name: "恋爱" });
        fireEvent.click(screen.getByRole("tab", { name: "恋爱" }));
        await screen.findByText("mangadex-恋爱");

        await searchFor("海贼王");
        await screen.findByRole("button", { name: "退出搜索" });

        mockedCrawl.mockClear();
        fireEvent.click(screen.getByRole("button", { name: "退出搜索" }));
        await waitFor(() =>
            expect(mockedCrawl).toHaveBeenCalledWith("category", "mangadex", {
                label: "恋爱",
            }),
        );
        // 分类 tabs 回来，且停在原来的分类上
        const tab = await screen.findByRole("tab", { name: "恋爱" });
        expect(
            tab.getAttribute("aria-selected") === "true" ||
                tab.dataset.state === "active",
        ).toBe(true);
    });
});
