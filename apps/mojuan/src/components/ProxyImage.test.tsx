import { describe, it, expect, vi, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import ProxyImage from "./ProxyImage";

// vitest 不开 globals（vite.config.ts：#10 seam 测试显式 import）→ RTL 不会自动
// cleanup，DOM 会跨用例泄漏。手动在 afterEach 清理 + 恢复真实计时器。

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

/** 推进假计时器并 flush React 更新（RTL 的 fireEvent 才自动包 act，计时器回调不会）。 */
function advance(ms: number) {
    act(() => {
        vi.advanceTimersByTime(ms);
    });
}

describe("ProxyImage（本机代理图失败重试，research #31）", () => {
    it("加载失败后按退避重建 <img> 重试同一 src", () => {
        vi.useFakeTimers();
        const proxySrc = "http://127.0.0.1:49913/img?url=x&ref=y";
        render(<ProxyImage src={proxySrc} alt="p1" />);
        const first = screen.getByAltText("p1");
        fireEvent.error(first);
        advance(300); // 首次退避 300ms
        const second = screen.getByAltText("p1");
        expect(second).not.toBe(first); // key 变化 → 新元素重建请求
        expect(second.getAttribute("src")).toBe(proxySrc);
    });

    it("达到最大尝试次数后停止重试", () => {
        vi.useFakeTimers();
        render(<ProxyImage src="s" alt="p" />);
        for (let i = 0; i < 5; i++) {
            fireEvent.error(screen.getByAltText("p"));
            advance(10_000); // 覆盖最大退避（2400ms）
        }
        const settled = screen.getByAltText("p");
        fireEvent.error(settled);
        advance(10_000);
        expect(screen.getByAltText("p")).toBe(settled); // 不再重建
    });

    it("src 变化后重置重试计数", () => {
        vi.useFakeTimers();
        const { rerender } = render(<ProxyImage src="a" alt="p" />);
        fireEvent.error(screen.getByAltText("p"));
        rerender(<ProxyImage src="b" alt="p" />);
        // 立即重置 → 新 <img>（key=0）指向新 src
        expect(screen.getByAltText("p").getAttribute("src")).toBe("b");
    });
});
