#!/usr/bin/env node
/**
 * 端到端核对（UI 层）：真实作品的在线阅读路径没被改坏。
 *
 * 用法（应用已在跑、能联网）：
 *   node scripts/verify-online-reader-network.mjs
 *
 * 从发现页拿一部真实作品 → 进详情（拉最新详情、写结果缓存）→ 进阅读器，
 * 图片应当渲染出来（这一部没有下载，走 images op + 网络取图）。
 * 每次探测都在应用的 5 秒执行上限内，等待放在 Node 侧。
 */
const PORT = process.env.MOJUAN_MCP_PORT ?? "9223";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const nav = async (hash) => {
    const res = await probe(
        `location.hash = ${JSON.stringify(hash)}; await new Promise((r) => setTimeout(r, 800)); return location.hash;`,
    );
    if (!res.success) throw new Error(`导航失败 ${hash}: ${res.error}`);
};

await nav("#/");
await sleep(1500);
const comic = await probe(
    `const link = document.querySelector('a[href*="#/comic/"]');
     return link ? link.getAttribute("href") : "";`,
);
if (!comic.data) throw new Error("发现页没有作品链接");
console.log("作品:", comic.data);

await nav(comic.data.slice(comic.data.indexOf("#") + 1));
await sleep(4000);
const chapter = await probe(
    `const tiles = [...document.querySelectorAll("a[href*='/reader/']")];
     return JSON.stringify({ href: tiles[0]?.getAttribute("href") ?? "", n: tiles.length });`,
);
const { href, n } = JSON.parse(chapter.data || "{}");
if (!href) throw new Error("详情页没有章节链接");
console.log("章节数:", n, "进第:", href);

await nav(href.slice(href.indexOf("#") + 1));
await sleep(6000);
const view = await probe(
    `const root = document.querySelector(".bg-reader-canvas");
     const imgs = root ? [...root.querySelectorAll("img")] : [];
     return JSON.stringify({
         total: imgs.length,
         loaded: imgs.filter((el) => el.naturalWidth > 0).length,
         first: imgs[0]?.getAttribute("src") ?? null,
         text: (root?.innerText ?? "").slice(0, 160),
     });`,
);
const out = JSON.parse(view.data);
console.log(JSON.stringify(out, null, 2));
const ok = out.loaded > 0;
console.log(ok ? "PASS：真实作品的在线阅读照常渲染" : "FAIL");
process.exit(ok ? 0 : 1);

function probe(script) {
    return send({ id: "probe", command: "execute_js", args: { script } });
}

function send(payload) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
        const timer = setTimeout(() => {
            try {
                ws.close();
            } catch {}
            reject(new Error("等待应用响应超时（应用没在运行？）"));
        }, 20000);
        ws.onopen = () => ws.send(JSON.stringify(payload));
        ws.onmessage = (event) => {
            clearTimeout(timer);
            resolve(JSON.parse(String(event.data)));
            ws.close();
        };
        ws.onerror = () => {
            clearTimeout(timer);
            reject(new Error(`无法连接 ws://127.0.0.1:${PORT}`));
        };
    });
}
