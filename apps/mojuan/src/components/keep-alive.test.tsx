import { useEffect, useState } from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter, useNavigate, useParams } from "react-router-dom";
import { KeepAliveRoutes, type PageRoute } from "./keep-alive";

// vitest 不开 globals → RTL 不会自动 cleanup，DOM 会跨用例泄漏，手动清理。

/** 各页面实例的挂载次数（用来判断实例是被保留还是重建）。 */
const mounted = new Map<string, number>();

function useMountCount(name: string) {
    useEffect(() => {
        mounted.set(name, (mounted.get(name) ?? 0) + 1);
    }, [name]);
}

/** 带本地输入状态的页面：输入内容在就说明实例没被重建。 */
function NotePage({ name }: { name: string }) {
    useMountCount(name);
    const [text, setText] = useState("");
    return (
        <input
            aria-label={name}
            value={text}
            onChange={(e) => setText(e.target.value)}
        />
    );
}

/** 参数页：显示自己那次导航拿到的参数。 */
function ParamPage() {
    const { id } = useParams();
    useMountCount(`param:${id}`);
    const [text, setText] = useState("");
    return (
        <div>
            <span>id:{id}</span>
            <input
                aria-label={`param-${id}`}
                value={text}
                onChange={(e) => setText(e.target.value)}
            />
        </div>
    );
}

function Harness({ pages }: { pages: PageRoute[] }) {
    const navigate = useNavigate();
    return (
        <>
            {["/a", "/b", "/p/1", "/p/2", "/p/3", "/r/1", "/r/2"].map((to) => (
                <button key={to} onClick={() => navigate(to)}>
                    go{to}
                </button>
            ))}
            <KeepAliveRoutes pages={pages} />
        </>
    );
}

function renderApp(pages: PageRoute[], initial = "/a") {
    return render(
        <MemoryRouter initialEntries={[initial]}>
            <Harness pages={pages} />
        </MemoryRouter>,
    );
}

const go = (to: string) => fireEvent.click(screen.getByText(`go${to}`));

const slot = (container: HTMLElement, page: string) =>
    container.querySelector<HTMLElement>(`[data-page="${page}"]`);

beforeEach(() => {
    mounted.clear();
});

afterEach(() => {
    cleanup();
});

describe("KeepAliveRoutes 页面保留", () => {
    const pages: PageRoute[] = [
        { path: "/a", element: <NotePage name="a" />, keep: 1 },
        { path: "/b", element: <NotePage name="b" />, keep: 1 },
        {
            path: "/p/:id",
            element: <ParamPage />,
            keep: 2,
        },
        { path: "/r/:id", element: <NotePage name="r" />, keep: 0 },
    ];

    it("返回上一个页面时保留组件状态，且实例没有重建", () => {
        const { container } = renderApp(pages);
        fireEvent.change(screen.getByLabelText("a"), {
            target: { value: "海贼王" },
        });

        go("/b");
        expect(slot(container, "/a")?.style.display).toBe("none");
        expect(slot(container, "/b")?.style.display).toBe("");

        go("/a");
        expect(slot(container, "/a")?.style.display).toBe("");
        expect((screen.getByLabelText("a") as HTMLInputElement).value).toBe(
            "海贼王",
        );
        expect(mounted.get("a")).toBe(1);
    });

    it("隐藏的页面留在 DOM 里，但移出可访问性树", () => {
        const { container } = renderApp(pages);
        go("/b");
        const hidden = slot(container, "/a");
        expect(hidden?.isConnected).toBe(true);
        expect(hidden?.querySelector("input")).not.toBeNull();
        expect(screen.queryByRole("textbox", { name: "a" })).toBeNull();
        expect(screen.queryByRole("textbox", { name: "b" })).not.toBeNull();
    });

    it("返回时恢复离开前的滚动位置", () => {
        const { container } = renderApp(pages);
        const a = slot(container, "/a")!;
        a.scrollTop = 260;
        fireEvent.scroll(a);

        go("/b");
        go("/a");
        expect(slot(container, "/a")!.scrollTop).toBe(260);
    });

    it("滚动后立刻离开（没有派发 scroll 事件）也能记住位置", () => {
        const { container } = renderApp(pages);
        slot(container, "/a")!.scrollTop = 180;

        go("/b");
        go("/a");
        expect(slot(container, "/a")!.scrollTop).toBe(180);
    });

    it("显示时内容还没铺满（位置被夹回 0）会在随后的帧里补上", async () => {
        const { container } = renderApp(pages);
        const a = slot(container, "/a")!;

        // 让这个槽位像真实浏览器那样夹住滚动位置：内容铺满之前只能停在 0
        let held = 0;
        let max = 1000;
        Object.defineProperty(a, "scrollTop", {
            configurable: true,
            get: () => Math.min(max, held),
            set: (v: number) => {
                held = Math.max(0, Math.min(max, v));
            },
        });
        a.scrollTop = 260;
        fireEvent.scroll(a);

        go("/b");
        max = 0; // 返回时内容还没铺满
        go("/a");
        expect(a.scrollTop).toBe(0);

        max = 1000; // 内容铺上了
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        expect(a.scrollTop).toBe(260);
    });

    it("keep: 0 的页面离开即卸载", () => {
        renderApp(pages, "/r/1");
        expect(mounted.get("r")).toBe(1);

        go("/a");
        go("/r/1");
        expect(mounted.get("r")).toBe(2);
    });

    it("同一路由按参数各占一个实例，超出上限淘汰最久未用的", () => {
        const { container } = renderApp(pages, "/p/1");
        fireEvent.change(screen.getByLabelText("param-1"), {
            target: { value: "记一下" },
        });
        go("/p/2");
        fireEvent.change(screen.getByLabelText("param-2"), {
            target: { value: "第二部" },
        });

        // 两个实例并存，各读自己那次导航的参数
        expect(slot(container, "/p/1")?.textContent).toContain("id:1");
        expect(slot(container, "/p/2")?.textContent).toContain("id:2");

        // 再回 /p/1 不重建实例，输入的草稿还在
        go("/p/1");
        expect(mounted.get("param:1")).toBe(1);
        expect((screen.getByLabelText("param-1") as HTMLInputElement).value).toBe(
            "记一下",
        );

        // /p/3 进来后按最近使用淘汰 /p/2（上限 2）
        go("/p/3");
        expect(slot(container, "/p/2")).toBeNull();
        go("/p/2");
        expect(mounted.get("param:2")).toBe(2);
    });
});
