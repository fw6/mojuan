import { describe, it, expect, beforeEach } from "vitest";
import {
    SOURCES,
    applySources,
    hotlinkRefererFor,
    sourceReferer,
    sourceTitle,
    type SourceFacts,
} from "./sources";

// 源清单与按源事实（显示名、图片热链对）由 Rust 侧解析源文档后给出，
// 同步就绪后填充一次。这里验证填充与两个查询。

const FACTS: SourceFacts[] = [
    { id: "mangadex", title: "MangaDex", hotlinkReferers: [] },
    {
        id: "webtoons",
        title: "Webtoons",
        hotlinkReferers: [{ domain: "pstatic.net", referer: "https://www.webtoons.com/" }],
    },
    {
        id: "dongman",
        title: "咚漫",
        hotlinkReferers: [
            { domain: "dongmanmanhua.cn", referer: "https://www.dongmanmanhua.cn/" },
        ],
    },
];

beforeEach(() => {
    applySources(FACTS);
});

describe("applySources", () => {
    it("清单按同步顺序填充", () => {
        expect(SOURCES.map((s) => s.id)).toEqual(["mangadex", "webtoons", "dongman"]);
    });

    it("显示名取自源文档的 title", () => {
        expect(sourceTitle("webtoons")).toBe("Webtoons");
        expect(sourceTitle("dongman")).toBe("咚漫");
    });

    it("重复填充重置清单，不累加", () => {
        applySources(FACTS);
        applySources(FACTS);
        expect(SOURCES).toHaveLength(3);
    });

    it("未知源的标题回退到 id", () => {
        expect(sourceTitle("nope")).toBe("nope");
    });
});

describe("热链对查询", () => {
    it("imgSrc 用：按 URL 子串命中域名", () => {
        expect(hotlinkRefererFor("https://s.pstatic.net/a/1.webp")).toBe(
            "https://www.webtoons.com/",
        );
        expect(hotlinkRefererFor("https://cdn.dongmanmanhua.cn/a/1.jpg")).toBe(
            "https://www.dongmanmanhua.cn/",
        );
        expect(hotlinkRefererFor("https://uploads.mangadex.org/a.jpg")).toBeNull();
    });

    it("下载用：取该源声明的 Referer，没有声明返回空串", () => {
        expect(sourceReferer("webtoons")).toBe("https://www.webtoons.com/");
        expect(sourceReferer("mangadex")).toBe("");
        expect(sourceReferer("nope")).toBe("");
    });
});
