/** 阅读区三分带的判定（S4 seam，纯函数；jsdom 测不了布局，逻辑抽出来测）。 */

export type TapZone = "prev" | "center" | "next";

/** 阅读区横向三分：左带翻上一页、中带切换沉浸式、右带翻下一页。
 *
 * `x` 是点击位置相对阅读区左边缘的距离，`width` 是阅读区宽度。宽度为 0（还没布局）
 * 时按中带处理：宁可什么都不做，也不要凭空翻页。 */
export function tapZone(x: number, width: number): TapZone {
    if (width <= 0) return "center";
    if (x < width / 3) return "prev";
    if (x < (width * 2) / 3) return "center";
    return "next";
}
