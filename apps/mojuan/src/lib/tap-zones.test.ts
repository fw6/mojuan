import { describe, expect, it } from "vitest";
import { tapZone } from "./tap-zones";

describe("阅读区三分带", () => {
    it("按三等分判定左、中、右带", () => {
        const width = 300;
        expect(tapZone(0, width)).toBe("prev");
        expect(tapZone(99, width)).toBe("prev");
        expect(tapZone(100, width)).toBe("center");
        expect(tapZone(199, width)).toBe("center");
        expect(tapZone(200, width)).toBe("next");
        expect(tapZone(300, width)).toBe("next");
    });

    it("宽度为 0 时按中带处理（不凭空翻页）", () => {
        expect(tapZone(10, 0)).toBe("center");
        expect(tapZone(0, 0)).toBe("center");
    });
});
