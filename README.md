# 墨卷 · Tauri

墨卷漫画阅读器（macOS / Windows / Linux / Android / iOS），基于 **Tauri v2** + **React**（Vite web 前端）。Rust 核心 `mojuan-core` 承载爬虫引擎（源文档 + 源运行时）与 WebDAV / 下载 / 本地文件 IO / 图片缓存，数据层为真实图源链路，不含 mock。

> **2026-08 迁移**：原 Lynx（Sparkling）工程已按 big-bang 决定删除（`sparkling-cimoc/`、根 `src/ android/ dist/`），迁移决策轨迹见 wayfinder 地图：https://github.com/fw6/mojuan/issues/2
>
> **2026-10 布局**：仓库改成 pnpm workspace，一次 `pnpm install` 装完 npm 图与 crate 图（[ADR-0003](docs/adr/0003-single-install-root.md)）。

## 开发

```bash
pnpm install
pnpm dev
```

- 前端：`apps/mojuan/src/`（React + Vite + HashRouter）
- 壳与命令层：`apps/mojuan/src-tauri/`（Rust，tauri command 接线 mojuan-core）
- 核心：`crates/mojuan-core/`（爬虫 / WebDAV / 下载 / 本地文件 IO / 图片缓存）
- 更新通道：`apps/updater/`（Cloudflare Worker，运维见 `apps/updater/README.md`）

## 图片加载

- 热链域（Webtoons `pstatic.net`）：走本机图片代理（`127.0.0.1` 的 `/img` 端点，Rust 侧补 `Referer` + 磁盘缓存/LRU）
- 其余域：`<img>` 直连，吃 webview HTTP 缓存
- 详见 `docs/research/desktop-webview-images.md`

## 当前状态

- 骨架原型（wayfinder #5）与 Rust 核心迁移（#7）已完成并通过端到端验证。
- 功能集已定案（grilling #6）：无限滚动阅读器（跨话连续、进度自动记录）、搜索、详情、Library（历史/收藏/下载/本地）、Settings 最小集；外链章节过滤。
- 领域术语表见 `GLOSSARY.md`；实现推进中。
