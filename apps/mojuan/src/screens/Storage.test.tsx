import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import StoragePage from "./Storage";
import type { Settings } from "../lib/storage/settings";
import type { DownloadComic, ChapterCheck } from "../api";

// S1 seam：存储页。mock api 层与存储域，验证顶部三项占用、两个清空按钮与上限下拉，
// 以及下载列表的排序、选择模式与批量删除。

vi.mock("../api", () => ({
    storageUsage: vi.fn(),
    clearImageCache: vi.fn(),
    clearResultCache: vi.fn(),
    setImageCacheLimit: vi.fn(),
    downloadComics: vi.fn(),
    checkDownload: vi.fn(),
    repairDownload: vi.fn(),
    readComicMeta: vi.fn(),
    deleteDownloaded: vi.fn(),
    imgSrc: vi.fn((url: string) => url),
    FLAT_SOURCE: "local",
}));

vi.mock("../lib/storage/settings", () => ({
    getSettings: vi.fn(),
    setSettings: vi.fn(),
}));

vi.mock("../lib/sources", () => ({
    sourceTitle: (id: string) => id,
    sourceReferer: () => "https://ref/",
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
    confirm: vi.fn(),
}));

import {
    storageUsage,
    clearResultCache,
    setImageCacheLimit,
    downloadComics,
    checkDownload,
    repairDownload,
    readComicMeta,
    deleteDownloaded,
    imgSrc,
} from "../api";
import { getSettings, setSettings } from "../lib/storage/settings";
import { confirm } from "@tauri-apps/plugin-dialog";

const mockedUsage = vi.mocked(storageUsage);
const mockedClearResult = vi.mocked(clearResultCache);
const mockedSetLimit = vi.mocked(setImageCacheLimit);
const mockedDownloadComics = vi.mocked(downloadComics);
const mockedCheckDownload = vi.mocked(checkDownload);
const mockedRepairDownload = vi.mocked(repairDownload);
const mockedReadComicMeta = vi.mocked(readComicMeta);
const mockedDeleteDownloaded = vi.mocked(deleteDownloaded);
const mockedImgSrc = vi.mocked(imgSrc);
const mockedConfirm = vi.mocked(confirm);
const mockedGetSettings = vi.mocked(getSettings);
const mockedSetSettings = vi.mocked(setSettings);

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;
const DOWNLOAD_DIR = "/mock/Downloads/mojuan";

function settings(patch: Partial<Settings> = {}): Settings {
    return {
        downloadDir: DOWNLOAD_DIR,
        darkMode: false,
        autoTrim: false,
        followUpdate: true,
        lastSource: null,
        lastCategory: {},
        followCheckedAt: null,
        imageCacheLimit: GB,
        ...patch,
    };
}

/** 一部已下载作品的占用记录；只有 source 与 comicId 必填。 */
function downloadComic(
    patch: Partial<DownloadComic> & { source: string; comicId: string },
): DownloadComic {
    return { title: "", cover: "", chapters: 1, pages: 1, bytes: 0, ...patch };
}

function renderStorage() {
    return render(
        <MemoryRouter>
            <StoragePage />
        </MemoryRouter>,
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    mockedGetSettings.mockResolvedValue(settings());
    mockedSetSettings.mockResolvedValue(undefined);
    mockedUsage.mockResolvedValue({
        image: { bytes: GB, count: 5 },
        result: { bytes: 2 * MB, count: 12 },
        download: { bytes: 3 * GB, count: 4 },
    });
    mockedClearResult.mockResolvedValue(undefined);
    mockedSetLimit.mockResolvedValue(undefined);
    mockedDownloadComics.mockResolvedValue([]);
    mockedCheckDownload.mockResolvedValue({
        chapters: [],
        missingPages: 0,
        brokenFiles: 0,
        unchecked: 0,
    });
    mockedReadComicMeta.mockResolvedValue(null);
    mockedDeleteDownloaded.mockResolvedValue(undefined);
    mockedRepairDownload.mockResolvedValue({ result: "queued", pages: 2, progress: null });
    mockedConfirm.mockResolvedValue(true);
});

afterEach(() => {
    cleanup();
});

describe("存储页顶部", () => {
    it("显示三项占用与两个清空按钮", async () => {
        renderStorage();
        expect(await screen.findByText("图片缓存")).toBeTruthy();
        expect(screen.getByText("结果缓存")).toBeTruthy();
        expect(screen.getByText("4 部")).toBeTruthy();
        expect(await screen.findByText("1.0 GB")).toBeTruthy();
        expect(screen.getByRole("button", { name: "清空图片缓存" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "清空结果缓存" })).toBeTruthy();
        expect(mockedUsage).toHaveBeenCalledWith(DOWNLOAD_DIR);
    });

    it("清空结果缓存会调用命令并重新取数", async () => {
        renderStorage();
        const button = await screen.findByRole("button", { name: "清空结果缓存" });
        mockedUsage.mockClear();
        fireEvent.click(button);
        await waitFor(() => expect(mockedClearResult).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(mockedUsage).toHaveBeenCalledTimes(1));
    });

    it("改上限写进设置并推给 Rust 命令", async () => {
        renderStorage();
        const select = await screen.findByLabelText("图片缓存上限");
        fireEvent.change(select, { target: { value: String(2 * GB) } });
        await waitFor(() =>
            expect(mockedSetSettings).toHaveBeenCalledWith({ imageCacheLimit: 2 * GB }),
        );
        expect(mockedSetLimit).toHaveBeenCalledWith(2 * GB);
    });
});

describe("存储页的下载列表", () => {
    it("按占用从大到小列出，每行有封面、标题、源、话数与占用", async () => {
        mockedDownloadComics.mockResolvedValue([
            downloadComic({
                source: "webtoons",
                comicId: "c1",
                title: "作品甲",
                cover: "https://x/a.jpg",
                chapters: 2,
                pages: 10,
                bytes: 100 * MB,
            }),
            downloadComic({
                source: "mangadex",
                comicId: "c2",
                title: "作品乙",
                chapters: 5,
                pages: 30,
                bytes: 1.5 * GB,
            }),
        ]);
        renderStorage();

        // 占用最大的排在最前面
        const titles = await screen.findAllByText(/作品[甲乙]/);
        expect(titles.map((t) => t.textContent)).toEqual(["作品乙", "作品甲"]);
        expect(screen.getByText("mangadex")).toBeTruthy();
        expect(screen.getByText("5 话")).toBeTruthy();
        expect(screen.getByText("1.5 GB")).toBeTruthy();
        expect(screen.getByText("100 MB")).toBeTruthy();
        // 封面经 imgSrc 拼地址
        expect(mockedImgSrc).toHaveBeenCalledWith("https://x/a.jpg", {
            source: "webtoons",
            comicId: "c1",
        });
    });

    it("标题为空时回落到 comicId，封面为空时给占位", async () => {
        mockedDownloadComics.mockResolvedValue([
            downloadComic({ source: "webtoons", comicId: "c1", title: "", cover: "" }),
        ]);
        const { container } = renderStorage();

        expect(await screen.findByText("c1")).toBeTruthy();
        // 空封面不拼地址，Cover 收到空串走占位（不发图片请求）
        expect(mockedImgSrc).not.toHaveBeenCalled();
        expect(container.querySelector("img")).toBeNull();
    });

    it("统计中显示加载态", async () => {
        mockedDownloadComics.mockImplementation(() => new Promise(() => {}));
        renderStorage();
        expect((await screen.findAllByText("正在统计下载占用")).length).toBeGreaterThan(0);
    });

    it("还没有下载时给空状态", async () => {
        renderStorage();
        expect(await screen.findByText("还没有下载的漫画")).toBeTruthy();
        expect(screen.getByText("在作品页选中章节下载，没网也能看")).toBeTruthy();
    });

    it("没有设置下载位置时指向设置页", async () => {
        mockedGetSettings.mockResolvedValue(settings({ downloadDir: null }));
        renderStorage();
        expect(await screen.findByText("还没有设置下载位置")).toBeTruthy();
        expect(mockedDownloadComics).not.toHaveBeenCalled();
    });

    it("统计失败时给出错误横幅", async () => {
        mockedDownloadComics.mockRejectedValue("读取目录失败");
        renderStorage();
        expect(await screen.findByText(/读取下载列表失败/)).toBeTruthy();
    });
});

describe("存储页的批量删除", () => {
    const items = [
        downloadComic({
            source: "webtoons",
            comicId: "c1",
            title: "作品甲",
            chapters: 2,
            bytes: GB,
        }),
        downloadComic({
            source: "mangadex",
            comicId: "c2",
            title: "作品乙",
            chapters: 5,
            bytes: GB,
        }),
    ];

    async function enterSelection() {
        renderStorage();
        await screen.findByText("作品甲");
        fireEvent.click(screen.getByRole("button", { name: "选择" }));
    }

    it("选择模式下每行出现勾选框，整行点击切换选中", async () => {
        mockedDownloadComics.mockResolvedValue(items);
        await enterSelection();

        expect(screen.getAllByRole("checkbox")).toHaveLength(2);
        expect(screen.getByText("已选 0 部 · 合计 0 B")).toBeTruthy();

        // 点行的任何位置（这里点标题）都算选中
        fireEvent.click(screen.getByText("作品乙").closest("label")!);
        expect(screen.getByText("已选 1 部 · 合计 1.0 GB")).toBeTruthy();

        // 再点一次取消选中
        fireEvent.click(screen.getByText("作品乙").closest("label")!);
        expect(screen.getByText("已选 0 部 · 合计 0 B")).toBeTruthy();
    });

    it("全选与取消全选，未选中时删除按钮禁用", async () => {
        mockedDownloadComics.mockResolvedValue(items);
        await enterSelection();

        expect((screen.getByRole("button", { name: "删除所选" }) as HTMLButtonElement).disabled).toBe(
            true,
        );

        fireEvent.click(screen.getByRole("button", { name: "全选" }));
        expect(screen.getByText("已选 2 部 · 合计 2.0 GB")).toBeTruthy();

        fireEvent.click(screen.getByRole("button", { name: "取消全选" }));
        expect(screen.getByText("已选 0 部 · 合计 0 B")).toBeTruthy();
        expect((screen.getByRole("button", { name: "删除所选" }) as HTMLButtonElement).disabled).toBe(
            true,
        );
    });

    it("删除所选：确认框给出部数与将释放的字节数，逐部删除并刷新列表与占用", async () => {
        mockedDownloadComics.mockResolvedValue(items);
        await enterSelection();
        fireEvent.click(screen.getByRole("button", { name: "全选" }));

        const listCalls = mockedDownloadComics.mock.calls.length;
        const usageCalls = mockedUsage.mock.calls.length;
        fireEvent.click(screen.getByRole("button", { name: "删除所选" }));

        await waitFor(() => expect(mockedConfirm).toHaveBeenCalledTimes(1));
        expect(mockedConfirm.mock.calls[0][0]).toBe(
            "删除所选 2 部作品？将释放 2.0 GB，删除后需要重新下载。",
        );

        await waitFor(() => expect(mockedDeleteDownloaded).toHaveBeenCalledTimes(2));
        expect(mockedDeleteDownloaded).toHaveBeenCalledWith(DOWNLOAD_DIR, "webtoons", "c1");
        expect(mockedDeleteDownloaded).toHaveBeenCalledWith(DOWNLOAD_DIR, "mangadex", "c2");

        // 列表与占用都重新取，选择模式退出
        await waitFor(() => expect(mockedDownloadComics.mock.calls.length).toBeGreaterThan(listCalls));
        await waitFor(() => expect(mockedUsage.mock.calls.length).toBeGreaterThan(usageCalls));
        await waitFor(() => expect(screen.queryAllByRole("checkbox")).toHaveLength(0));
    });

    it("确认框里点取消就不删除", async () => {
        mockedDownloadComics.mockResolvedValue(items);
        mockedConfirm.mockResolvedValue(false);
        await enterSelection();
        fireEvent.click(screen.getByRole("button", { name: "全选" }));

        fireEvent.click(screen.getByRole("button", { name: "删除所选" }));

        await waitFor(() => expect(mockedConfirm).toHaveBeenCalledTimes(1));
        expect(mockedDeleteDownloaded).not.toHaveBeenCalled();
    });

    it("取消退出选择模式并清空选中", async () => {
        mockedDownloadComics.mockResolvedValue(items);
        await enterSelection();
        fireEvent.click(screen.getByRole("button", { name: "全选" }));

        fireEvent.click(screen.getByRole("button", { name: "取消" }));
        expect(screen.queryAllByRole("checkbox")).toHaveLength(0);

        fireEvent.click(screen.getByRole("button", { name: "选择" }));
        expect(screen.getByText("已选 0 部 · 合计 0 B")).toBeTruthy();
    });
});

describe("存储页的完整性检查", () => {
    const item = downloadComic({
        source: "webtoons",
        comicId: "c1",
        title: "作品甲",
        chapters: 3,
        bytes: GB,
    });

    /** 一话的检查结果；只有 chapterIndex 必填。 */
    function chapterCheck(
        patch: Partial<ChapterCheck> & { chapterIndex: number },
    ): ChapterCheck {
        return { pages: 10, missing: [], broken: [], manifest: true, ...patch };
    }

    async function expandRow() {
        renderStorage();
        await screen.findByText("作品甲");
        fireEvent.click(screen.getByText("作品甲").closest("button")!);
    }

    it("展开一行自动跑检查，渲染汇总、逐话状态与页号", async () => {
        mockedDownloadComics.mockResolvedValue([item]);
        mockedCheckDownload.mockResolvedValue({
            chapters: [
                chapterCheck({ chapterIndex: 1, pages: 40, missing: [12, 13], broken: [30] }),
                chapterCheck({ chapterIndex: 2, pages: 5, missing: [], broken: [], manifest: false }),
                chapterCheck({ chapterIndex: 3, pages: 10 }),
            ],
            missingPages: 2,
            brokenFiles: 1,
            unchecked: 1,
        });
        mockedReadComicMeta.mockResolvedValue({
            source: "webtoons",
            comicId: "c1",
            title: "作品甲",
            cover: "",
            chapters: { "1": "第 1 话·起点" },
        });

        await expandRow();

        // 展开即检查
        await waitFor(() =>
            expect(mockedCheckDownload).toHaveBeenCalledWith(DOWNLOAD_DIR, "webtoons", "c1"),
        );
        expect(await screen.findByText("3 话 · 缺 2 页 · 损坏 1 个")).toBeTruthy();
        // 有未核对的话时如实说明
        expect(screen.getByText("其中 1 话没有页清单，只核对了已有的页")).toBeTruthy();
        // 话名取作品元数据，取不到回落到话序号
        expect(await screen.findByText("第 1 话·起点")).toBeTruthy();
        expect(screen.getByText("第 2 话")).toBeTruthy();
        expect(screen.getByText("第 3 话")).toBeTruthy();
        // 四态徽标
        expect(screen.getByText("缺 2 页")).toBeTruthy();
        expect(screen.getByText("未核对")).toBeTruthy();
        expect(screen.getByText("正常")).toBeTruthy();
        // 页号显示时加 1
        expect(screen.getByText("缺第 13、14 页 · 损坏第 31 页")).toBeTruthy();
        expect(mockedReadComicMeta).toHaveBeenCalledWith(DOWNLOAD_DIR, "webtoons", "c1");
    });

    it("页号很多时只列前几个并补等 N 页", async () => {
        mockedDownloadComics.mockResolvedValue([item]);
        mockedCheckDownload.mockResolvedValue({
            chapters: [
                chapterCheck({
                    chapterIndex: 1,
                    pages: 12,
                    missing: [0, 1, 2, 3, 4, 5, 6],
                }),
            ],
            missingPages: 7,
            brokenFiles: 0,
            unchecked: 0,
        });

        await expandRow();

        expect(await screen.findByText("缺第 1、2、3、4、5 页 等 7 页")).toBeTruthy();
    });

    it("重新检查再跑一次命令", async () => {
        mockedDownloadComics.mockResolvedValue([item]);
        mockedCheckDownload.mockResolvedValue({
            chapters: [chapterCheck({ chapterIndex: 1 })],
            missingPages: 0,
            brokenFiles: 0,
            unchecked: 0,
        });

        await expandRow();
        await screen.findByText("1 话 · 缺 0 页 · 损坏 0 个");
        const calls = mockedCheckDownload.mock.calls.length;

        fireEvent.click(screen.getByRole("button", { name: "重新检查" }));
        await waitFor(() =>
            expect(mockedCheckDownload.mock.calls.length).toBeGreaterThan(calls),
        );
    });

    it("检查失败时给出错误文案，不假装正常", async () => {
        mockedDownloadComics.mockResolvedValue([item]);
        mockedCheckDownload.mockRejectedValue("读取目录失败");

        await expandRow();

        expect(await screen.findByText(/检查失败：读取目录失败/)).toBeTruthy();
    });

    it("选择模式下没有检查入口，点行是选中", async () => {
        mockedDownloadComics.mockResolvedValue([item]);
        renderStorage();
        await screen.findByText("作品甲");
        fireEvent.click(screen.getByRole("button", { name: "选择" }));

        expect(screen.queryByRole("button", { name: /检查结果/ })).toBeNull();
        fireEvent.click(screen.getByText("作品甲").closest("label")!);
        expect(screen.getByText("已选 1 部 · 合计 1.0 GB")).toBeTruthy();
        expect(mockedCheckDownload).not.toHaveBeenCalled();
    });
});

describe("存储页的补下", () => {
    const item = downloadComic({
        source: "webtoons",
        comicId: "c1",
        title: "作品甲",
        chapters: 3,
        bytes: GB,
    });

    /** 一话的检查结果；只有 chapterIndex 必填。 */
    function chapterCheck(
        patch: Partial<ChapterCheck> & { chapterIndex: number },
    ): ChapterCheck {
        return { pages: 10, missing: [], broken: [], manifest: true, ...patch };
    }

    async function expandRow() {
        renderStorage();
        await screen.findByText("作品甲");
        fireEvent.click(screen.getByText("作品甲").closest("button")!);
    }

    it("有问题的章节数大于 0 时出现补下按钮，点它逐话入队并说清去哪看进度", async () => {
        mockedDownloadComics.mockResolvedValue([item]);
        mockedCheckDownload.mockResolvedValue({
            chapters: [
                chapterCheck({ chapterIndex: 1, missing: [12, 13] }),
                chapterCheck({ chapterIndex: 2, broken: [30] }),
                chapterCheck({ chapterIndex: 3 }),
            ],
            missingPages: 2,
            brokenFiles: 1,
            unchecked: 0,
        });

        await expandRow();
        const button = await screen.findByRole("button", { name: "补下缺失的页（2 话）" });
        expect(mockedRepairDownload).not.toHaveBeenCalled();

        fireEvent.click(button);

        await waitFor(() => expect(mockedRepairDownload).toHaveBeenCalledTimes(2));
        expect(mockedRepairDownload).toHaveBeenCalledWith({
            dir: DOWNLOAD_DIR,
            source: "webtoons",
            comicId: "c1",
            chapterIndex: 1,
            referer: "https://ref/",
        });
        expect(mockedRepairDownload).toHaveBeenCalledWith({
            dir: DOWNLOAD_DIR,
            source: "webtoons",
            comicId: "c1",
            chapterIndex: 2,
            referer: "https://ref/",
        });
        expect(
            await screen.findByText("已把 2 话加入下载队列，进度到「下载」页查看"),
        ).toBeTruthy();
    });

    it("每一话都正常时没有补下按钮", async () => {
        mockedDownloadComics.mockResolvedValue([item]);
        mockedCheckDownload.mockResolvedValue({
            chapters: [
                chapterCheck({ chapterIndex: 1 }),
                chapterCheck({ chapterIndex: 2, manifest: false }),
            ],
            missingPages: 0,
            brokenFiles: 0,
            unchecked: 1,
        });

        await expandRow();
        await screen.findByText("2 话 · 缺 0 页 · 损坏 0 个");

        expect(screen.queryByRole("button", { name: /补下缺失的页/ })).toBeNull();
        expect(mockedRepairDownload).not.toHaveBeenCalled();
    });

    it("没有要补的页与入队失败都如实说出来", async () => {
        mockedDownloadComics.mockResolvedValue([item]);
        mockedCheckDownload.mockResolvedValue({
            chapters: [
                chapterCheck({ chapterIndex: 1, missing: [0] }),
                chapterCheck({ chapterIndex: 2, broken: [1] }),
            ],
            missingPages: 1,
            brokenFiles: 1,
            unchecked: 0,
        });
        mockedRepairDownload
            .mockResolvedValueOnce({ result: "nothingToRepair", pages: 0, progress: null })
            .mockRejectedValueOnce("没有页清单，源也没有给出第 2 话的页表");

        await expandRow();
        fireEvent.click(await screen.findByRole("button", { name: "补下缺失的页（2 话）" }));

        expect(
            await screen.findByText(
                "1 话已无缺失，1 话入队失败：没有页清单，源也没有给出第 2 话的页表",
            ),
        ).toBeTruthy();
    });
});
