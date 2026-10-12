#!/usr/bin/env node
/**
 * 端到端核对（UI 层）：已下载章节在断网场景下的两条阅读入口都从磁盘取图。
 *
 * 用法（应用已在跑）：
 *   node scripts/verify-offline-reading.mjs
 *
 * 造一份假的下载数据放进默认下载目录（~/Downloads/mojuan），索引里的图 URL 指向
 * 不存在的域名：图片能渲染出来（naturalWidth > 0）只可能是代理读了本地文件。
 * 跑完删掉假数据。两条入口分别是：
 *   /local/<source>/<comicId>/<chapter>  书架「下载」tab 的本地阅读器
 *   /reader/<source>/<comicId>/<chapter> 「继续阅读」走的在线阅读器
 */
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

const PORT = process.env.MOJUAN_MCP_PORT ?? "9223";
const DOWNLOAD_DIR = join(process.env.HOME, "Downloads", "mojuan");
const COMIC_DIR = join(DOWNLOAD_DIR, "webtoons", "e2e-comic");
const IMG_URL = "https://not-a-real-host.invalid/0.jpg";
// 1x1 的合法 JPEG
const JPEG = Buffer.from(
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
    "base64",
);

await rm(COMIC_DIR, { recursive: true, force: true });
await mkdir(join(COMIC_DIR, "chapter_1"), { recursive: true });
await writeFile(join(COMIC_DIR, "chapter_1/0.jpg"), JPEG);
await writeFile(join(COMIC_DIR, "chapter_1/1.jpg"), JPEG);
// 只有第 0 页有索引记录，第 1 页走相对路径回落
await writeFile(
    join(COMIC_DIR, "download_index.json"),
    JSON.stringify({ map: { [IMG_URL]: "chapter_1/0.jpg" } }),
);

const setDir = await probe(
    `await window.__TAURI_INTERNALS__.invoke("img_proxy_set_download_dir", { dir: ${JSON.stringify(DOWNLOAD_DIR)} });
     return "ok";`,
);
if (!setDir.success) throw new Error(`设置下载目录失败: ${setDir.error}`);

const results = [];
for (const route of ["local", "reader"]) {
    await probe(
        `location.hash = "#/${route}/webtoons/e2e-comic/1";
         await new Promise((r) => setTimeout(r, 1500));
         return location.hash;`,
    );
    await sleep(3000);
    const view = await probe(
        `const root = document.querySelector(".bg-reader-canvas");
         const imgs = root ? [...root.querySelectorAll("img")] : [];
         return JSON.stringify({
             total: imgs.length,
             loaded: imgs.filter((el) => el.naturalWidth > 0).length,
             srcs: imgs.map((el) => el.getAttribute("src")),
         });`,
    );
    const out = JSON.parse(view.data);
    const ok = out.total === 2 && out.loaded === 2;
    console.log(`/${route}/: 页数=${out.total} 渲染成功=${out.loaded} ${ok ? "PASS" : "FAIL"}`);
    console.log(out.srcs.map((s) => `  ${s}`).join("\n"));
    results.push(ok);
}

await rm(COMIC_DIR, { recursive: true, force: true });
const ok = results.every(Boolean);
console.log(ok ? "PASS：两条入口都从下载目录取图" : "FAIL");
process.exit(ok ? 0 : 1);

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

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
