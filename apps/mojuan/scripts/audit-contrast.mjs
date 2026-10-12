#!/usr/bin/env node
/**
 * 在运行中的应用里扫描文字对比度，输出低于 WCAG 标准的项。
 *
 * 用法（先跑起应用：pnpm dev）：
 *   node apps/mojuan/scripts/audit-contrast.mjs
 *   node apps/mojuan/scripts/audit-contrast.mjs --routes /,/settings --theme light
 *
 * 说明：只看文字对比度（正文 4.5:1、大字 3:1），用 DOM 与计算样式判断，
 * 不截图。主题通过 html[data-theme] 临时切换，不会写入用户设置。
 */
const PORT = process.env.MOJUAN_MCP_PORT ?? "9223";
const args = process.argv.slice(2);
const option = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const ROUTES = option("--routes", "/,/library,/downloads,/settings").split(",");
const THEMES = option("--theme", "light,dark").split(",");
const WAIT_MS = Number(option("--wait", "3500"));

function send(payload, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
        const timer = setTimeout(() => {
            try {
                ws.close();
            } catch {}
            reject(new Error("等待应用响应超时（应用没在运行？）"));
        }, timeoutMs);
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

async function evaluate(script) {
    const res = await send({
        id: "audit",
        command: "execute_js",
        args: { script },
    });
    if (!res.success) throw new Error(res.error ?? "脚本执行失败");
    return res.data;
}

/** 在页面里收集所有低于标准的文字。 */
const SWEEP = `
const cv = document.createElement("canvas");
cv.width = cv.height = 1;
const ctx = cv.getContext("2d", { willReadFrequently: true });
function parse(c) {
  const m = String(c).match(/[\\d.]+/g);
  if (!m) return null;
  return { r: +m[0], g: +m[1], b: +m[2], a: m[3] === undefined ? 1 : +m[3] };
}
function toRgb(color) {
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  return { r: d[0], g: d[1], b: d[2] };
}
function over(fg, bg) {
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  };
}
function effBg(el) {
  const layers = [];
  let n = el;
  while (n && n !== document.documentElement) {
    const raw = getComputedStyle(n).backgroundColor;
    const p = parse(raw);
    if (p && p.a > 0) {
      layers.push(/^rgba?\\(/.test(raw) ? p : { ...toRgb(raw), a: p.a });
      if (p.a === 1) break;
    }
    n = n.parentElement;
  }
  // 一路找到顶都没有不透明底色时用主题底色兜底：有窗口材质的平台上侧边栏是透明的，它下面那层
  // 系统材质按窗口外观取明暗，与主题底色同一明暗档（见 DESIGN.md 的「窗口材质」）；
  // 假定白色会在深色主题下把浅色文字算成 1.1:1 的假阳性。
  const themeBg = getComputedStyle(document.documentElement)
    .getPropertyValue("--background")
    .trim();
  let out = { ...toRgb(themeBg), a: 1 };
  for (let i = layers.length - 1; i >= 0; i--) out = over(layers[i], out);
  return out;
}
function lum({ r, g, b }) {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function ratio(a, b) {
  const l1 = lum(a), l2 = lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
const found = [];
for (const el of document.querySelectorAll("body *")) {
  const direct = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
  if (!direct) continue;
  const st = getComputedStyle(el);
  if (st.visibility === "hidden" || st.display === "none") continue;
  if (el.closest("[aria-hidden=true]")) continue;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) continue;
  const size = parseFloat(st.fontSize);
  const large = size >= 24 || (size >= 18.66 && parseInt(st.fontWeight, 10) >= 700);
  const need = large ? 3 : 4.5;
  const r = ratio(toRgb(st.color), effBg(el));
  if (r < need) {
    found.push({ text: el.textContent.trim().slice(0, 24), size: size + "px", need, ratio: +r.toFixed(2) });
  }
}
return found;
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const originalTheme = await evaluate(
    `return document.documentElement.dataset.theme || "light"`,
);

// 应用窗口不在前台时 WebView 暂停渲染，`transition-colors` 这类过渡会永远停在起点：
// 切换主题后仍读到切换前的颜色，与切换后的底色配成假阳性。扫之前先关掉过渡。
await evaluate(`
const s = document.createElement("style");
s.id = "audit-freeze";
s.textContent = "*{transition:none !important}";
document.head.appendChild(s);
return 1;
`);

let failures = 0;
for (const theme of THEMES) {
    await evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}; return 1`);
    for (const route of ROUTES) {
        await evaluate(`location.hash = ${JSON.stringify("#" + route)}; return 1`);
        await sleep(WAIT_MS);
        const found = await evaluate(SWEEP);
        const label = `${theme} ${route}`;
        if (found.length === 0) {
            console.log(`通过  ${label}`);
        } else {
            failures += found.length;
            console.log(`不足  ${label}（${found.length} 项）`);
            for (const f of found.slice(0, 8)) {
                console.log(`      ${f.ratio}:1 需 ${f.need}  ${f.size}  「${f.text}」`);
            }
        }
    }
}
await evaluate(
    `document.getElementById("audit-freeze")?.remove();
document.documentElement.dataset.theme = ${JSON.stringify(originalTheme)}; return 1`,
);
console.log(failures === 0 ? "\n全部达标" : `\n共 ${failures} 项低于标准`);
process.exit(failures === 0 ? 0 : 1);
