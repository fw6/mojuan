// 源文档的共享测试驱动：与 Rust 侧 tests/source_doc_test.rs 跑同一批 fixture、同一批断言。
//
// 这里跑在 node（jsdom 实现 __host.select），验证文档与运行时的语义；引擎差异
// （真 QuickJS + 真 scraper）由 Rust 那侧兜底。

import { describe, it, expect } from "vitest";
import {
    loadRuntime,
    planStep,
    readDoc,
    readFixture,
    runOp,
    runSingle,
} from "./source-harness.js";

const webtoons = readDoc("webtoons");

const SEARCH_CARD = readFixture("search-card.html");
const DETAIL_HTML = readFixture("detail.html");
const VIEWER = readFixture("viewer.html");

const SERIES = "https://www.webtoons.com/en/action/eleceed/list?title_no=1571";
/** 隐藏值经 ctx.hidden 交给运行时：名 → 键 → 值。 */
const withSeries = { hidden: { seriesUrl: { "webtoons-1571": SERIES } } };

describe("webtoons 文档", () => {
    it("categories 是静态分类表", () => {
        expect(runOp(webtoons, "categories", {}).data).toHaveLength(8);
        expect(runOp(webtoons, "categories", {}).data).toContain("恋爱");
    });

    it("search 构造 URL 并解析卡片", () => {
        expect(planStep(webtoons, "search", { keyword: "eleceed" }).url).toBe(
            "https://www.webtoons.com/en/search?keyword=eleceed",
        );
        const out = runSingle(webtoons, "search", { keyword: "eleceed" }, SEARCH_CARD);
        expect(out.data).toHaveLength(1);
        expect(out.data[0].id).toBe("webtoons-1571");
        expect(out.data[0].title).toBe("Eleceed");
        expect(out.data[0].source).toBe("webtoons");
        expect(out.data[0].sourceTitle).toBe("Webtoons");
        expect(out.data[0].status).toBe("serial");
        expect(out.data[0].cover).toContain("webtoon-phinf.pstatic.net");
        expect(out.data[0].tags).toEqual([]);
    });

    it("search 把系列 URL 作为隐藏值交出去（不进前端数据）", () => {
        const out = runSingle(webtoons, "search", { keyword: "eleceed" }, SEARCH_CARD);
        expect(out.data[0].seriesUrl).toBeUndefined();
        expect(out.hidden).toEqual([
            { name: "seriesUrl", key: "webtoons-1571", value: SERIES },
        ]);
    });

    it("category 用静态分类表里的 URL；未知分类不抓取", () => {
        expect(planStep(webtoons, "category", { label: "恋爱" }).url).toBe(
            "https://www.webtoons.com/en/genres/romance",
        );
        expect(planStep(webtoons, "category", { label: "不存在的分类" }).abort).toBe(true);
    });

    it("detail 的 URL 优先用缓存的系列 URL，否则 any 兜底", () => {
        expect(
            planStep(webtoons, "detail", { comicId: "webtoons-1571" }, { ctx: withSeries }).url,
        ).toBe(SERIES);
        expect(planStep(webtoons, "detail", { comicId: "webtoons-1571" }).url).toBe(
            "https://www.webtoons.com/en/any/list?title_no=1571",
        );
    });

    it("detail 解析标题/作者/简介/封面/章节（降序）", () => {
        const out = runSingle(
            webtoons,
            "detail",
            { comicId: "webtoons-1571" },
            DETAIL_HTML,
            withSeries,
        );
        const { comic, chapters } = out.data;
        expect(comic.id).toBe("webtoons-1571");
        expect(comic.title).toBe("Eleceed");
        expect(comic.author).toBe("Jeho Son");
        expect(comic.intro).toContain("Jiwoo is a kind-hearted young man");
        expect(comic.cover).toContain("swebtoon-phinf.pstatic.net");
        expect(comic.lastChapter).toBe("Episode 398");
        expect(comic.tags).toEqual(["Webtoons"]);
        expect(chapters.map((c) => c.index)).toEqual([398, 397, 396]);
        expect(chapters[0].title).toBe("Episode 398");
        expect(chapters[0].external).toBe(false);
        expect(chapters[0].pages).toEqual([]);
    });

    it("images 用系列 URL 里的 slug 拼 viewer 路径，并带 Referer", () => {
        const step = planStep(
            webtoons,
            "images",
            { comicId: "webtoons-1571", chapterIndex: 398 },
            { ctx: withSeries },
        );
        expect(step.url).toBe(
            "https://www.webtoons.com/en/action/eleceed/episode-398/viewer?title_no=1571&episode_no=398",
        );
        expect(step.headers.Referer).toBe(SERIES);
    });

    it("images 没有缓存时落到 any 路径，Referer 也回退", () => {
        const step = planStep(webtoons, "images", {
            comicId: "webtoons-1571",
            chapterIndex: 398,
        });
        expect(step.url).toBe(
            "https://www.webtoons.com/en/any/episode-398/viewer?title_no=1571&episode_no=398",
        );
        expect(step.headers.Referer).toBe(
            "https://www.webtoons.com/en/any/list?title_no=1571",
        );
    });

    it("images 解析 data-url", () => {
        const urls = runSingle(
            webtoons,
            "images",
            { comicId: "webtoons-1571", chapterIndex: 398 },
            VIEWER,
            withSeries,
        ).data;
        expect(urls).toHaveLength(3);
        for (const u of urls) {
            expect(u).toMatch(/^https:\/\/webtoon-phinf\.pstatic\.net\//);
        }
    });
});

// ---------- mangadex：JSON API + 多步请求 ----------

const mangadex = readDoc("mangadex");
const MD_SEARCH = readFixture("mangadex-search.json");
const MD_DETAIL = readFixture("mangadex-detail.json");
const MD_FEED = readFixture("mangadex-feed.json");
const MD_HOME = readFixture("mangadex-at-home.json");
const MD_TAGS = readFixture("mangadex-tags.json");

const MD_ID = "7e544761-7d3d-4fce-8137-719814d7d138";

describe("mangadex 文档", () => {
    it("search 构造 URL", () => {
        const step = planStep(mangadex, "search", { keyword: "eleceed" });
        expect(step.url).toBe(
            "https://api.mangadex.org/manga?title=eleceed&limit=24&includes[]=cover_art&includes[]=author" +
                "&contentRating[]=safe&contentRating[]=suggestive&order[relevance]=desc",
        );
        expect(step.input).toBe("json");
    });

    it("search 解析漫画（本地化标题、作者关系、封面拼接、只留 genre 标签）", () => {
        const comics = runOp(mangadex, "search", { keyword: "eleceed" }, { responses: { list: MD_SEARCH } }).data;
        expect(comics).toHaveLength(2);
        const c = comics[0];
        expect(c.id).toBe(`mangadex-${MD_ID}`);
        expect(c.title).toBe("Eleceed");
        expect(c.author).toBe("Son Jae-Ho");
        expect(c.intro).toContain("Jiwoo is a kind-hearted");
        expect(c.cover).toBe(
            `https://uploads.mangadex.org/covers/${MD_ID}/52cf193d-6862-43e8-9de4-1025c0e6e297.jpg.256.jpg`,
        );
        expect(c.status).toBe("serial");
        expect(c.tags).toEqual(["Action"]);
    });

    it("categories 从标签表里只取 genre 组", () => {
        const cats = runOp(mangadex, "categories", {}, { responses: { tags: MD_TAGS } }).data;
        expect(cats).toEqual(["Action", "Romance", "Fantasy"]);
    });

    it("category 先查标签表拿 tagId，再按 tagId 列漫画", () => {
        const steps = [];
        let responses = {};
        const runtime = loadRuntime(mangadex);
        for (;;) {
            const step = JSON.parse(
                runtime.plan(JSON.stringify({ op: "category", payload: { label: "Romance" }, ctx: {}, responses })),
            );
            if (step.done || step.abort) break;
            steps.push(step);
            responses[step.name] = step.name === "tags" ? MD_TAGS : MD_SEARCH;
        }
        expect(steps.map((s) => s.name)).toEqual(["tags", "list"]);
        expect(steps[1].url).toContain("includedTags[]=423e2eae-a7a2-4a8b-ac03-a8351462d71d");
    });

    it("category 的标签表里没有该分类时不抓取", () => {
        const step = planStep(mangadex, "category", { label: "不存在" }, { responses: { tags: MD_TAGS } });
        expect(step.abort).toBe(true);
    });

    it("detail 两步请求（漫画 + 章节 feed），章节升序且标记外链", () => {
        const out = runOp(
            mangadex,
            "detail",
            { comicId: `mangadex-${MD_ID}` },
            { responses: { manga: MD_DETAIL, feed: MD_FEED } },
        ).data;
        expect(out.comic.title).toBe("Eleceed");
        expect(out.comic.intro).not.toContain("<p>");
        expect(out.chapters.map((c) => c.index)).toEqual([1, 2, 3]);
        expect(out.chapters[0].title).toBe("Welcome");
        expect(out.chapters[1].title).toBe("第 2 话");
        expect(out.chapters[1].external).toBe(true);
        expect(out.chapters[2].external).toBe(false);
        expect(out.comic.lastChapter).toBe("Rival");
    });

    it("images 从 feed 里按章节号找 chapterId，再拼 at-home 的图片地址", () => {
        const steps = [];
        let responses = {};
        const runtime = loadRuntime(mangadex);
        for (;;) {
            const step = JSON.parse(
                runtime.plan(
                    JSON.stringify({
                        op: "images",
                        payload: { comicId: `mangadex-${MD_ID}`, chapterIndex: 2 },
                        ctx: {},
                        responses,
                    }),
                ),
            );
            if (step.done || step.abort) break;
            steps.push(step);
            responses[step.name] = step.name === "feed" ? MD_FEED : MD_HOME;
        }
        expect(steps.map((s) => s.name)).toEqual(["feed", "home"]);
        // 章节 2 的 id 来自 feed
        expect(steps[1].url).toBe(
            "https://api.mangadex.org/at-home/server/aaaaaaaa-1111-2222-3333-444444444444",
        );
        const out = JSON.parse(
            runtime.parse(
                JSON.stringify({
                    op: "images",
                    payload: { comicId: `mangadex-${MD_ID}`, chapterIndex: 2 },
                    ctx: {},
                    responses,
                }),
            ),
        ).data;
        expect(out).toEqual([
            "https://cmdxd98sb0x3yprd.mangadex.network/data/5ee6f31f3c96d13aa97b854fce823aef/f1-ca82099f1deec340ac0d9edf6a180d6f161753c79ee2fdd2c45a0bd9b854dcfd.png",
            "https://cmdxd98sb0x3yprd.mangadex.network/data/5ee6f31f3c96d13aa97b854fce823aef/f2-3019726164ca78ccab0c17c802c9dd12f5310f46eb8f2936d9f43bc867621fe7.png",
        ]);
    });

    it("章节号在 feed 里找不到时不抓取", () => {
        const step = planStep(
            mangadex,
            "images",
            { comicId: `mangadex-${MD_ID}`, chapterIndex: 99 },
            { responses: { feed: MD_FEED } },
        );
        expect(step.abort).toBe(true);
    });
});

// ---------- copymanga：JSON API + 静态分类表 + 两处数组查找 ----------

const copymanga = readDoc("copymanga");
const CM_SEARCH = readFixture("copymanga-search.json");
const CM_DETAIL = readFixture("copymanga-detail.json");
const CM_FEED = readFixture("copymanga-feed.json");
const CM_CHAPTER = readFixture("copymanga-chapter.json");

const CM_FIELDS = {
    title: "海贼王",
    author: "尾田栄一郎",
    cover: "https://sh.mangafunb.fun/h/haizeiwang/cover/1651422982.jpg.328x422.jpg",
};

describe("copymanga 文档", () => {
    it("categories 是静态主题表，category 用表里的 URL", () => {
        const cats = runOp(copymanga, "categories", {}).data;
        expect(cats).toHaveLength(17);
        expect(cats[0]).toBe("冒险");
        expect(planStep(copymanga, "category", { label: "热血" }).url).toBe(
            "https://api.mangacopy.com/api/v3/comics?platform=3&limit=20&offset=0&theme=rexue",
        );
        expect(planStep(copymanga, "category", { label: "没有这个分类" }).abort).toBe(true);
    });

    it("search 构造 URL 并解析（作者数组拼接、status 是对象时取 display）", () => {
        const step = planStep(copymanga, "search", { keyword: "海贼王" });
        expect(step.url).toBe(
            "https://api.mangacopy.com/api/v3/search/comic?format=json&platform=3&q=" +
                encodeURIComponent("海贼王") +
                "&offset=0&limit=20",
        );
        const comics = runOp(copymanga, "search", { keyword: "海贼王" }, {
            responses: { list: CM_SEARCH },
        }).data;
        expect(comics.length).toBeGreaterThan(0);
        const c = comics[0];
        expect(c.id).toBe("copymanga-haizeiwang");
        expect(c.title).toBe(CM_FIELDS.title);
        expect(c.author).toBe(CM_FIELDS.author);
        expect(c.cover).toBe(CM_FIELDS.cover);
        // 搜索结果里没有 status / theme 字段
        expect(c.status).toBe("serial");
        expect(c.tags).toEqual([]);
    });

    it("detail 两步请求：comic2 + 章节 feed；status 取 display，tags 取主题名", () => {
        const out = runOp(
            copymanga,
            "detail",
            { comicId: "copymanga-haizeiwang" },
            { responses: { comic: CM_DETAIL, feed: CM_FEED } },
        ).data;
        expect(out.comic.title).toBe("海贼王");
        expect(out.comic.status).toBe("serial");
        expect(out.comic.tags).toEqual(["热血", "冒险"]);
        expect(out.comic.lastChapter).toBe("第 1000 话");
        expect(out.chapters.map((c) => c.index)).toEqual([1, 2, 3]);
        expect(out.chapters[0].title).toBe("第 1 话");
    });

    it("images 从 feed 里按章节号找 uuid，再取 contents 的 url", () => {
        const steps = [];
        let responses = {};
        const runtime = loadRuntime(copymanga);
        for (;;) {
            const step = JSON.parse(
                runtime.plan(
                    JSON.stringify({
                        op: "images",
                        payload: { comicId: "copymanga-haizeiwang", chapterIndex: 1 },
                        ctx: {},
                        responses,
                    }),
                ),
            );
            if (step.done || step.abort) break;
            steps.push(step);
            responses[step.name] = step.name === "feed" ? CM_FEED : CM_CHAPTER;
        }
        expect(steps.map((s) => s.name)).toEqual(["feed", "chapter"]);
        expect(steps[1].url).toBe(
            "https://api.mangacopy.com/api/v3/comic/haizeiwang/chapter2/ch-1?platform=3",
        );
        const out = JSON.parse(
            runtime.parse(
                JSON.stringify({
                    op: "images",
                    payload: { comicId: "copymanga-haizeiwang", chapterIndex: 1 },
                    ctx: {},
                    responses,
                }),
            ),
        ).data;
        expect(out).toEqual([
            "https://sh.mangafunb.fun/h/haizeiwang/chapter/1651422982/0.jpg",
            "https://sh.mangafunb.fun/h/haizeiwang/chapter/1651422982/1.jpg",
        ]);
    });
});

// ---------- dongman：HTML + 首页榜单同构元素的过滤 + 章节页的两步请求 ----------

const dongman = readDoc("dongman");
const DM_SEARCH = readFixture("dongman-search.html");
const DM_DETAIL = readFixture("dongman-detail.html");
const DM_VIEWER = readFixture("dongman-viewer.html");

describe("dongman 文档", () => {
    it("search 只取带 data-title-no 的卡片（首页榜单同构 li 被排除）", () => {
        const comics = runOp(dongman, "search", { keyword: "甜蜜" }, {
            responses: { list: DM_SEARCH },
        }).data;
        expect(comics.length).toBeGreaterThan(0);
        // 首页榜单那条没有 data-title-no，且标题是「男男同居记」
        expect(comics.map((c) => c.title)).not.toContain("男男同居记");
        expect(comics[0].id).toBe("dongman-1418");
        expect(comics[0].title).toBe("甜蜜保质期");
        expect(comics[0].author).toBe("黑琪可可 / 惊歌");
        expect(comics[0].cover).toContain("cdn.dongmanmanhua.cn");
    });

    it("categories 是静态分类表", () => {
        const cats = runOp(dongman, "categories", {}).data;
        expect(cats).toHaveLength(10);
        expect(cats).toContain("恋爱");
        expect(planStep(dongman, "category", { label: "都市" }).url).toBe(
            "https://www.dongmanmanhua.cn/METROPOLIS",
        );
    });

    it("detail 解析标题/多位作者/封面（http 升级）/简介/章节（降序）", () => {
        const out = runSingle(dongman, "detail", { comicId: "dongman-2859" }, DM_DETAIL).data;
        expect(out.comic.title).toBe("跳槽日志");
        expect(out.comic.author).toBe("Woo Si-mok, Lee Ha-an");
        expect(out.comic.cover).toBe(
            "https://cdn-sns.dongmanmanhua.cn/e452801b-3c10-4680-beae-63c3535baae3.jpg",
        );
        expect(out.comic.intro).toContain("社恐打工人撞破危险秘密");
        expect(out.chapters.map((c) => c.index)).toEqual([55, 10, 9]);
        expect(out.chapters[0].title).toBe("【免费】第1季后记");
        expect(out.chapters[2].title).toBe("第9话");
        expect(out.comic.lastChapter).toBe("【免费】第1季后记");
    });

    it("images 先从章节列表里按话号找 viewer URL，再取阅读页图片", () => {
        const steps = [];
        let responses = {};
        const runtime = loadRuntime(dongman);
        for (;;) {
            const step = JSON.parse(
                runtime.plan(
                    JSON.stringify({
                        op: "images",
                        payload: { comicId: "dongman-2859", chapterIndex: 9 },
                        ctx: {},
                        responses,
                    }),
                ),
            );
            if (step.done || step.abort) break;
            steps.push(step);
            responses[step.name] = step.name === "list" ? DM_DETAIL : DM_VIEWER;
        }
        expect(steps.map((s) => s.name)).toEqual(["list", "viewer"]);
        // 话号 9 的 viewer URL 从章节列表里取出，相对协议补成 https
        expect(steps[1].url).toBe(
            "https://www.dongmanmanhua.cn/METROPOLIS/tiaocaorizhi/%E7%AC%AC9%E8%AF%9D-parsing-error/viewer?title_no=2859&episode_no=9",
        );
        const out = JSON.parse(
            runtime.parse(
                JSON.stringify({
                    op: "images",
                    payload: { comicId: "dongman-2859", chapterIndex: 9 },
                    ctx: {},
                    responses,
                }),
            ),
        ).data;
        expect(out.length).toBeGreaterThan(0);
        for (const u of out) expect(u).toContain("cdn.dongmanmanhua.cn");
    });
});

// ---------- kxmanhua：HTML + 区域内状态判定 + 最后一个 p 当简介 ----------

const kxmanhua = readDoc("kxmanhua");
const KX_SEARCH = readFixture("kxmanhua-search.html");
const KX_DETAIL = readFixture("kxmanhua-detail.html");
const KX_CHAPTER = readFixture("kxmanhua-chapter.html");

describe("kxmanhua 文档", () => {
    it("search 从 onclick 里取 id，状态只看卡片内的 epgreen", () => {
        const comics = runOp(kxmanhua, "search", { keyword: "最棒" }, {
            responses: { list: KX_SEARCH },
        }).data;
        expect(comics).toHaveLength(2);
        expect(comics[0].id).toBe("kxmanhua-7067");
        expect(comics[0].title).toBe("最棒的她");
        expect(comics[0].cover).toBe(
            "https://img.imh99.top/webtoon/cover-image/4085_1790735521874.webp",
        );
        expect(comics[0].status).toBe("serial");
        // 第二张卡片的封面区里是 epgreen
        expect(comics[1].id).toBe("kxmanhua-3915");
        expect(comics[1].title).toBe("[3D]奸魔再世");
        expect(comics[1].status).toBe("finish");
    });

    it("detail 的作者取「作者：」那一段，简介取最后一个 p，章节升序", () => {
        const out = runSingle(kxmanhua, "detail", { comicId: "kxmanhua-7067" }, KX_DETAIL).data;
        expect(out.comic.title).toBe("最棒的她");
        expect(out.comic.author).toBe("BYUK CHA");
        expect(out.comic.cover).toBe(
            "https://img.imh99.top/webtoon/cover-image/4085_1790735521874.webp",
        );
        expect(out.comic.intro).toBe(
            "青梅竹马的妈妈跑来哀求我,只为了让她的女儿不再沈迷网路,让我不禁赞叹她真是最棒的妈妈",
        );
        // 详情封面区是 ep（连载）；页面别处的 epgreen（同类推荐）不能算进来
        expect(out.comic.status).toBe("serial");
        expect(out.chapters.map((c) => c.index)).toEqual([173803, 173804, 173805, 173806, 173807]);
        expect(out.chapters[0].title).toBe("第1话");
        expect(out.comic.lastChapter).toBe("第5话");
    });

    it("images 只取 /webtoon/content/ 的图，广告图与站内图排除", () => {
        const urls = runSingle(
            kxmanhua,
            "images",
            { comicId: "kxmanhua-7067", chapterIndex: 173803 },
            KX_CHAPTER,
        ).data;
        expect(urls).toHaveLength(3);
        for (const u of urls) {
            expect(u).toContain("/webtoon/content/");
        }
    });
});

// ---------- hentara：JSON 数据接口 + 本地搜索（items 钩子）+ 预渲染列表页 ----------

const hentara = readDoc("hentara");
const HT_INDEX = readFixture("hentara-index.json");
const HT_BROWSE = readFixture("hentara-browse.html");
const HT_GENRE = readFixture("hentara-genre.html");
const HT_DETAIL = readFixture("hentara-detail.json");
const HT_EPISODE = readFixture("hentara-episode.json");

describe("hentara 文档", () => {
    it("categories 是分类 + 题材的静态表", () => {
        const cats = runOp(hentara, "categories", {}).data;
        expect(cats).toHaveLength(18);
        expect(cats.slice(0, 6)).toEqual(["全部", "热门", "最新", "无修正", "最热", "Hentai"]);
        expect(cats).toContain("Harem");
        expect(planStep(hentara, "category", { label: "Harem" }).url).toBe(
            "https://hentara.com/genres/harem-manhwa",
        );
        expect(planStep(hentara, "category", { label: "没有" }).abort).toBe(true);
    });

    it("search 用 items 钩子在全站索引上过滤、按更新时间降序、截 60 条", () => {
        const comics = runOp(hentara, "search", { keyword: "harem" }, {
            responses: { index: HT_INDEX },
        }).data;
        // 命中 2 部；按 updated_at 降序 → Capitalist Harem(09-26) 在 Harem King(09-20) 前
        expect(comics.map((c) => c.id)).toEqual(["hentara-capitalist-harem", "hentara-harem-king"]);
        expect(comics[0].title).toBe("Capitalist Harem");
        expect(comics[0].lastChapter).toBe("Chapter 14");
        expect(comics[0].cover).toBe(
            "https://cdn.hentara.com/capitalist-harem/thumbnail.jpg",
        );
    });

    it("search 的关键词大小写不敏感，没命中就是空列表", () => {
        const hit = runOp(hentara, "search", { keyword: "CAPITALIST" }, {
            responses: { index: HT_INDEX },
        }).data;
        expect(hit).toHaveLength(1);
        const miss = runOp(hentara, "search", { keyword: "zzz" }, {
            responses: { index: HT_INDEX },
        }).data;
        expect(miss).toEqual([]);
    });

    it("category 从预渲染列表页取卡片", () => {
        const comics = runSingle(hentara, "category", { label: "全部" }, HT_BROWSE).data;
        expect(comics.length).toBeGreaterThan(0);
        expect(comics[0].id).toBe("hentara-heart-pounding-s-matching");
        expect(comics[0].title).toBe("Heart Pounding S Matching (Uncensored)");
        expect(comics[0].cover).toBe(
            "https://cdn.hentara.com/heart-pounding-s-matching/thumbnail.jpg",
        );
    });

    it("detail 解析章节（升序、空标题补 Chapter N）", () => {
        const out = runSingle(
            hentara,
            "detail",
            { comicId: "hentara-capitalist-harem" },
            HT_DETAIL,
        ).data;
        expect(out.comic.title).toBe("Capitalist Harem");
        expect(out.comic.cover).toBe(
            "https://cdn.hentara.com/capitalist-harem/thumbnail.jpg",
        );
        expect(out.chapters).toHaveLength(14);
        expect(out.chapters[0].index).toBe(1);
        expect(out.chapters[0].title).toBe("Chapter 1");
        expect(out.comic.lastChapter).toBe("Chapter 14");
    });

    it("images 取 pages[].image_url", () => {
        const urls = runSingle(
            hentara,
            "images",
            { comicId: "hentara-capitalist-harem", chapterIndex: 1 },
            HT_EPISODE,
        ).data;
        expect(urls.length).toBeGreaterThan(0);
        expect(urls[0]).toBe("https://cdn.hentara.com/capitalist-harem/chapter-001/001.jpg");
    });
});

// ---------- manhuagui：HTML + 章节链接过滤 + 解包 p.a.c.k.e.r（images 整 op 钩子） ----------

const manhuagui = readDoc("manhuagui");
const MH_SEARCH = readFixture("manhuagui-search.html");
const MH_DETAIL = readFixture("manhuagui-detail.html");
const MH_CHAPTER = readFixture("manhuagui-chapter.html");

describe("manhuagui 文档", () => {
    it("categories 是静态分类表", () => {
        const cats = runOp(manhuagui, "categories", {}).data;
        expect(cats).toHaveLength(38);
        expect(cats[0]).toBe("热血");
        expect(planStep(manhuagui, "category", { label: "校园" }).url).toBe(
            "https://www.manhuagui.com/list/xiaoyuan/",
        );
    });

    it("search 解析卡片（封面补协议、状态、作者、简介、最新章）", () => {
        const comics = runOp(manhuagui, "search", { keyword: "音速" }, {
            responses: { list: MH_SEARCH },
        }).data;
        expect(comics.length).toBeGreaterThan(0);
        const c = comics[0];
        expect(c.id).toBe("manhuagui-48320");
        expect(c.title).toBe("用最强天赋开始经营领地慢生活");
        expect(c.cover).toBe("https://cf.mhgui.com/cpic/b/48320.jpg");
        expect(c.author).toBe("眠田睑");
        expect(c.status).toBe("serial");
        expect(c.lastChapter).toBe("更新至4.2话");
    });

    it("detail 取 h1 标题、hcover 封面、intro-all 简介，章节只认本章链接且要有 title", () => {
        const out = runSingle(manhuagui, "detail", { comicId: "manhuagui-43847" }, MH_DETAIL).data;
        expect(out.comic.title).toBe("脑洞学生会");
        expect(out.comic.cover).toBe("https://cf.mhgui.com/cpic/h/43847_14.jpg");
        expect(out.comic.author).toBe("むちまろ（无知麻吕）");
        expect(out.comic.intro).toContain("高一的文艺青年水之江梅");
        expect(out.comic.status).toBe("serial");
        // 4 条真实章节（章节栏「更新至」快捷链接无 title；同类推荐的其它漫画被排除）
        expect(out.chapters.map((c) => c.index)).toEqual([628732, 633620, 755107, 901676]);
        expect(out.chapters[0].title).toBe("第01话");
        expect(out.comic.lastChapter).toBe("第180话");
    });

    it("images 用整 op 钩子解包 p.a.c.k.e.r 后拼图片地址", () => {
        const urls = runSingle(
            manhuagui,
            "images",
            { comicId: "manhuagui-43847", chapterIndex: 901676 },
            MH_CHAPTER,
        ).data;
        // 解包后 path=/02/43847/901676/、files=[1_abc.jpg …]、e/m 取自 sl 对象
        expect(urls).toEqual([
            "https://us.hamreus.com/02/43847/901676/1_abc.jpg?e=1651837515&m=1111111111",
            "https://us.hamreus.com/02/43847/901676/2_def.jpg?e=1651837515&m=1111111111",
            "https://us.hamreus.com/02/43847/901676/3_ghi.jpg?e=1651837515&m=1111111111",
            "https://us.hamreus.com/02/43847/901676/4_jkl.jpg?e=1651837515&m=1111111111",
        ]);
    });
});

// ---------- nnhanman：渲染源（页面由隐藏 webview 取回）+ 列表 info 区分日期与最新话 ----------

const nnhanman = readDoc("nnhanman");
const NN_SEARCH = readFixture("nnhanman-search.html");
const NN_DETAIL = readFixture("nnhanman-detail.html");
const NN_CHAPTER = readFixture("nnhanman-chapter.html");

describe("nnhanman 文档", () => {
    it("声明为渲染源，分类表是「栏目 + 题材」两组", () => {
        expect(nnhanman.renderChannel).toBe(true);
        const cats = runOp(nnhanman, "categories", {}).data;
        expect(cats).toHaveLength(24);
        expect(cats.slice(0, 4)).toEqual(["最新更新", "热门", "已完结", "连载中"]);
        expect(cats).toContain("恋爱");
        // 题材名要百分号编码（站内路径是中文目录名）
        expect(planStep(nnhanman, "category", { label: "恋爱" }).url).toBe(
            "https://nnhanman.xyz/comics/%E6%81%8B%E7%88%B1/ob/time/st/all",
        );
        expect(planStep(nnhanman, "category", { label: "没有" }).abort).toBe(true);
    });

    it("search 只取带封面锚的卡片；info 是日期时不当成最新话", () => {
        const comics = runOp(nnhanman, "search", { keyword: "韓" }, {
            responses: { list: NN_SEARCH },
        }).data;
        expect(comics.length).toBeGreaterThan(0);
        expect(comics[0].id).toBe("nnhanman-lian-ai-zuo-bi-bai-ke");
        expect(comics[0].title).toBe("戀愛作弊百科");
        expect(comics[0].cover).toBe(
            "https://new.niaopic.com/202608/20260818135631986.jpg",
        );
        expect(comics[0].lastChapter).toBe("");
    });

    it("detail 去掉书名号、作者取第一段 txtItme、题材取 /comics/ 链接、章节升序", () => {
        const out = runSingle(
            nnhanman,
            "detail",
            { comicId: "nnhanman-zui-bang-de-ta" },
            NN_DETAIL,
        ).data;
        expect(out.comic.title).toBe("最棒的她");
        expect(out.comic.author).toBe("BYUK CHA");
        expect(out.comic.intro).toBe(
            "青梅竹馬的媽媽跑來哀求我,只為了讓她的女兒不再沈迷網路,讓我不禁贊嘆她真是最棒的媽媽",
        );
        expect(out.comic.cover).toBe(
            "https://new.niaopic.com/202609/20260929145709400.jpg",
        );
        expect(out.comic.status).toBe("serial");
        expect(out.comic.tags).toEqual(["正妹", "恋爱", "浪漫", "巨乳", "女大生", "同居"]);
        expect(out.chapters.map((c) => c.index)).toEqual([85989, 85990, 85991, 85992, 85993]);
        expect(out.chapters[0].title).toBe("第1話");
        expect(out.comic.lastChapter).toBe("第5話");
    });

    it("images 只取带 data-index 的图（站内 logo 与统计像素不带）", () => {
        const urls = runSingle(
            nnhanman,
            "images",
            { comicId: "nnhanman-zui-bang-de-ta", chapterIndex: 85989 },
            NN_CHAPTER,
        ).data;
        expect(urls.length).toBeGreaterThan(0);
        for (const u of urls) {
            expect(u).toContain("new.niaopic.com");
        }
    });
});

// ---------- baozimh：渲染源 + 章节按槽位排序合成序号 + 中转链作为隐藏值 ----------

const baozimh = readDoc("baozimh");
const BZ_SEARCH = readFixture("baozimh-search.html");
const BZ_DETAIL = readFixture("baozimh-detail.html");
const BZ_CHAPTER = readFixture("baozimh-chapter.html");

describe("baozimh 文档", () => {
    it("声明为渲染源；分类是静态表", () => {
        expect(baozimh.renderChannel).toBe(true);
        const cats = runOp(baozimh, "categories", {}).data;
        expect(cats).toHaveLength(25);
        expect(cats[0]).toBe("热血");
        expect(planStep(baozimh, "category", { label: "恋爱" }).url).toBe(
            "https://cn.baozimh.com/classify?type=lianai&region=all&state=all&filter=%2a",
        );
    });

    it("search 从卡片锚取标题与封面，作者取同卡片的 info 锚", () => {
        const comics = runOp(baozimh, "search", { keyword: "海贼" }, {
            responses: { list: BZ_SEARCH },
        }).data;
        expect(comics.length).toBeGreaterThan(0);
        const c = comics[0];
        expect(c.id).toBe("baozimh-haizeiwang-weitianrongyilang");
        expect(c.title).toBe("海贼王");
        // 首个 amp-img 是真封面（其后是 placeholder 默认图）
        expect(c.cover).toBe(
            "https://static-tw.baozimh.com/cover/haizeiwang-weitianrongyilang.jpg?w=285&h=375&q=100",
        );
    });

    it("detail 取标题/作者/简介/封面，状态取 tag 列表首个，标签取其余", () => {
        const out = runSingle(
            baozimh,
            "detail",
            { comicId: "baozimh-hanghaiwang-weitianrongyilang" },
            BZ_DETAIL,
        ).data;
        expect(out.comic.title).toBe("航海王");
        expect(out.comic.author).toBe("尾田荣一郎");
        expect(out.comic.status).toBe("serial");
        expect(out.comic.cover).toBe(
            "https://static-tw.baozimh.com/cover/hanghaiwang-weitianrongyilang.jpg?w=285&h=375&q=100",
        );
        expect(out.comic.tags).toEqual(["日本", "剧情", "少年", "热血"]);
        expect(out.comic.lastChapter).toContain("第1186话");
    });

    it("chapters 按 (section_slot, chapter_slot) 升序、去重、序号从 1 起，pageUrl 作为隐藏值交出", () => {
        const out = runSingle(
            baozimh,
            "detail",
            { comicId: "baozimh-hanghaiwang-weitianrongyilang" },
            BZ_DETAIL,
        );
        const chapters = out.data.chapters;
        expect(chapters.length).toBeGreaterThan(0);
        expect(chapters.map((c) => c.index)).toEqual(chapters.map((_, i) => i + 1));
        // 章节号不进前端数据，只作为隐藏值（键 = 漫画 id:序号）
        for (const c of chapters) expect(c.pageUrl).toBeUndefined();
        expect(out.hidden.length).toBe(chapters.length);
        expect(out.hidden[0].name).toBe("pageUrl");
        expect(out.hidden[0].key).toBe(
            `baozimh-hanghaiwang-weitianrongyilang:${chapters[0].index}`,
        );
        expect(out.hidden[0].value).toContain("https://cn.baozimh.com/user/page_direct?");
    });

    it("images 用缓存的章节中转链取页面，只认 chapter-img 的 amp-img", () => {
        const pageUrl =
            "https://cn.baozimh.com/user/page_direct?comic_id=x&section_slot=0&chapter_slot=1186";
        const ctx = { hidden: { pageUrl: { "baozimh-hangha:1": pageUrl } } };
        const step = planStep(
            baozimh,
            "images",
            { comicId: "baozimh-hangha", chapterIndex: 1 },
            { ctx },
        );
        expect(step.url).toBe(pageUrl);
        const urls = runSingle(
            baozimh,
            "images",
            { comicId: "baozimh-hangha", chapterIndex: 1 },
            BZ_CHAPTER,
            ctx,
        ).data;
        expect(urls.length).toBeGreaterThan(0);
        for (const u of urls) expect(u).toContain("bzcdn.net");
    });

    it("章节中转链缺失时不抓取（提示先重进详情页）", () => {
        const step = planStep(baozimh, "images", {
            comicId: "baozimh-hangha",
            chapterIndex: 1,
        });
        expect(step.abort).toBe(true);
    });
});
