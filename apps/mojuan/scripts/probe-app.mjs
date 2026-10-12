#!/usr/bin/env node
/**
 * 在运行中的墨卷应用里执行一段 JS，并把结果打印出来。
 *
 * 用法：
 *   pnpm dev                     # 先跑起应用（tauri-plugin-mcp-bridge 会在 9223 起 WebSocket）
 *   node apps/mojuan/scripts/probe-app.mjs 'return document.title'
 *   node apps/mojuan/scripts/probe-app.mjs --file .scratch/probe.js
 *
 * 用途：桌面端界面验证走结构化文本（DOM/计算样式），不依赖截图。
 */
import { readFile } from "node:fs/promises";

const PORT = process.env.MOJUAN_MCP_PORT ?? "9223";

const args = process.argv.slice(2);
const resizeAt = args.indexOf("--resize");
if (resizeAt >= 0) {
    const [width, height] = args[resizeAt + 1].split("x").map(Number);
    const res = await send({
        id: "resize",
        command: "resize_window",
        args: { width, height, logical: true },
    });
    console.log(JSON.stringify(res));
    process.exit(res.success ? 0 : 1);
}

let script;
if (args[0] === "--file") {
    script = await readFile(args[1], "utf8");
} else if (args.length > 0) {
    script = args.join(" ");
} else {
    console.error(
        "用法：node scripts/probe-app.mjs '<js>' | --file <path> | --resize <宽x高>",
    );
    process.exit(2);
}

const result = await send({ id: "probe", command: "execute_js", args: { script } });
console.log(JSON.stringify(result, null, 2));

function send(payload) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
        const timer = setTimeout(() => {
            try {
                ws.close();
            } catch {}
            reject(new Error("等待应用响应超时（应用没在运行？）"));
        }, 15000);
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
