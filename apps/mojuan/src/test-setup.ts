/**
 * vitest（jsdom）环境补丁：jsdom 没有实现 IntersectionObserver，
 * 而 beui 的 ScrollReveal 进入动效依赖它。这里提供一个什么都不触发的桩：
 * 元素保持初始状态，测试断言的是文本与角色，不依赖动画是否播放。
 */
class IntersectionObserverStub implements IntersectionObserver {
    readonly root: Element | Document | null = null;
    readonly rootMargin: string = "";
    readonly thresholds: ReadonlyArray<number> = [];
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): IntersectionObserverEntry[] {
        return [];
    }
}

if (typeof globalThis.IntersectionObserver === "undefined") {
    globalThis.IntersectionObserver =
        IntersectionObserverStub as unknown as typeof IntersectionObserver;
}

/** jsdom 也没有 matchMedia，beui 组件与 useIsMobile 都用到。 */
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
    window.matchMedia = ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
}

/** ResizeObserver 同样缺失（虚拟列表与阅读列宽度测量用到）。 */
if (typeof globalThis.ResizeObserver === "undefined") {
    class ResizeObserverStub {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
    }
    globalThis.ResizeObserver =
        ResizeObserverStub as unknown as typeof ResizeObserver;
}

/** jsdom 的 window.scrollTo 是「未实现」占位（调用只打警告）；BottomSheet 的滚动锁
 * 在关闭时调用它恢复位置，这里换成空实现。 */
window.scrollTo = (() => {}) as typeof window.scrollTo;

/** jsdom 也没有 Element.scrollTo（虚拟列表用它滚动、阅读器恢复阅读位置也走它）。
 * 补成「写 scrollTop」——浏览器里这一步就是滚动容器，读 scrollTop 即可观察。 */
Element.prototype.scrollTo = function (
    this: Element,
    optionsOrX?: ScrollToOptions | number,
    y?: number,
): void {
    const top =
        typeof optionsOrX === "object" ? optionsOrX?.top : y;
    if (typeof top === "number") this.scrollTop = top;
} as typeof Element.prototype.scrollTo;
