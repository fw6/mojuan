# AGENTS.md

墨卷漫画阅读器 — Tauri v2（Rust 后端）+ React（Vite web 前端），发布 macOS / Windows / Linux / Android / iOS；Rust 核心 `crates/mojuan-core/` 跨端共享。旧 Lynx 工程已删除（迁移轨迹见 [wayfinder 地图](https://github.com/fw6/mojuan/issues/2)）。

仓库是 pnpm workspace：`apps/mojuan`（前端 + Tauri 壳）与 `apps/updater`（更新通道 Worker）是两个 npm 包，Rust 侧是仓库根的 Cargo workspace（`crates/` 三个库 + `apps/mojuan/src-tauri`）。

## 核心命令（在仓库根执行）

- `pnpm install` — 装依赖：一次解析 npm 图（两个包）与 crate 图（crate 归档进 `.pnpm/crates`）
- `pnpm dev` — 开发模式（Vite HMR；改 Rust 触发后端重编，比前端慢）
- `pnpm tauri build` — 打包桌面应用
- `pnpm build` — 前端构建（`tsc && vite build`）
- `pnpm check` — 仅类型检查
- `pnpm test` — 前端 vitest + 更新通道的 node 测试
- `cargo test` / `cargo check` — Rust workspace（mojuan-core + src-tauri + 两个插件）
- `scripts/check-android.sh` — Android 目标的 cargo check（宿主 `cargo check` 看不到 `#[cfg(mobile)]` 的代码）

## 约定（渐进式披露，按需阅读）

- [Tauri / 桌面开发](docs/agents/tauri-development.md) — 处理任何 Tauri 任务前**必读** Tauri llms.txt；前端 HMR 工作流；图片加载走本机 HTTP 代理；同步命令/主线程坑
- [前端 apps/mojuan/src](docs/agents/frontend.md) — Tailwind v4 + beui 组件（`scripts/fetch-beui.mjs` 拉取）、设计令牌位置、断点约定、阅读器分页策略、不用截图验证界面的方法
- [Rust 核心 mojuan-core](docs/agents/mojuan-core.md) — 架构、源文档与源运行时契约、命令 API 约定（`&str` → JSON）、测试
- [构建环境](docs/agents/build-environment.md) — pnpm 管两张图、cargo 源、workspace 产物与忽略规则
- [工程原则与优先级](docs/agents/principles.md) — 全局原则（`~/.zcode/AGENTS.md`）+ 冲突裁决（长期演进优先）

## 资源

- [docs/](docs/) — wayfinder 决策地图、研究纪要（`docs/research/`）、ADR、issue 追踪约定（`docs/agents/issue-tracker.md`）
- [GLOSSARY.md](GLOSSARY.md) — 领域术语表（无限滚动、外链章节过滤、进度自动记录等）
- [PRODUCT.md](PRODUCT.md) / [DESIGN.md](DESIGN.md) — 产品事实与视觉设计系统（配色/字体/组件规范）
