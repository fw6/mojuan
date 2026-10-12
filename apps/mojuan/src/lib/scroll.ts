/** 卷纸流滚动窗口计算（S4 seam，纯函数；jsdom 测不了真实滚动，逻辑抽出来测）。 */

/** 距底部不足 marginPx 像素（触发预取下一话）。内容未溢出视口视为在底部。 */
export function nearBottomByPx(
    scrollTop: number,
    clientHeight: number,
    scrollHeight: number,
    marginPx: number,
): boolean {
    if (scrollHeight <= clientHeight) return true;
    return scrollHeight - (scrollTop + clientHeight) <= marginPx;
}

/** 视口中心偏移所在页（按已测页面高度累计定位）。heights 为空返回 0。 */
export function pageIndexAt(centerOffset: number, heights: number[]): number {
    if (heights.length === 0) return 0;
    let acc = 0;
    for (let i = 0; i < heights.length; i++) {
        acc += heights[i];
        if (centerOffset < acc) return i;
    }
    return heights.length - 1;
}

/** 视口中心在该页内的位置 0..1（长条漫一页好几屏，只记页码不够）。
 * 页高为 0（还没测出高度）时返回 0。 */
export function offsetWithinPage(
    centerOffset: number,
    heights: number[],
    index: number,
): number {
    const size = heights[index] ?? 0;
    if (size <= 0) return 0;
    const within = Math.min(size, Math.max(0, centerOffset - sum(heights, 0, index)));
    return within / size;
}

function sum(heights: number[], from: number, to: number): number {
    let s = 0;
    for (let i = from; i < to && i < heights.length; i++) s += heights[i];
    return s;
}
