# ADR-0003: 仓库根作为唯一的安装与解析根（pnpm workspace 管 npm 与 cargo）

- 状态：Accepted
- 日期：2026-10-12

## Context

仓库此前是「每个 npm 包各自安装」的形状：`desktop/`（前端 + Tauri 壳 + 三个 Rust 库 +
Cargo workspace 根 + npm 包根 + 构建脚本）与 `updater/`（Cloudflare Worker）各有自己的
`package.json`、`package-lock.json`、`node_modules`，两份逐字节相同的 `.npmrc`；cargo 图与
npm 图各解析一次，互不相干。`desktop` 这个名字也不再描述产品——它发布 macOS / Windows /
Linux / Android / iOS 五个平台。

pnpm 12 起可以在同一次 `pnpm install` 里解析 npm 图与 Cargo workspace 的依赖图，crate 归档进
pnpm 的内容寻址存储并生成 Cargo 的源替换（[pnpm 的 cargo 文档](https://pnpm.io/cargo)）。

## Decision

仓库根是唯一的安装与解析根：

- `pnpm-workspace.yaml` 声明 `packages`（`apps/*`）、`cargo.enabled`、cargo 稀疏索引
  （rsproxy.cn，国内镜像）、`allowBuilds`（`esbuild`、`workerd`）与 `publicHoistPattern`（`jsdom`）。
- Cargo workspace 根从 `desktop/Cargo.toml` 上移到仓库根 `Cargo.toml`；三个 Rust 库移到根
  `crates/`，前端与它的 Tauri 壳留在 `apps/mojuan/`（Tauri 要求两者相邻），Worker 移到
  `apps/updater/`。
- npm 包名收进 `@mojuan/` 作用域（`@mojuan/app`、`@mojuan/updater`），根包 `@mojuan/root` 只放
  编排脚本；pnpm 版本固定在根 `package.json` 的 `packageManager`。
- crates-io 的源归 pnpm 一家所有：索引地址声明在 `registries`，`.cargo/config.toml` 只留
  `[registries.crates-io] protocol = "sparse"` 与 pnpm 写入的 include 块，不再手写
  `[source.crates-io] replace-with`。
- 命令入口从包内换到仓库根（`pnpm dev` / `pnpm build` / `pnpm test` / `pnpm check` / `pnpm tauri`），
  npm 从工具链里去掉；CI 用 `pnpm/action-setup` + `pnpm install --frozen-lockfile`。
- 发布产物写进仓库根 `build/`（被忽略），不再写进源码目录。

## Rationale

- **一次安装**：npm 图（两个包）与 crate 图一次解析完；锁文件从四份收成 `pnpm-lock.yaml` 与
  `Cargo.lock` 两份，CI 的两次 `npm ci` 收成一次。
- **名字与职责对应**：`apps/` 装可部署物、`crates/` 装库，`desktop` 这个不再成立的名字消失。
- **离线可构建**：crate 进内容寻址存储、Cargo 用目录源，`.pnpm` 存在时 `cargo build --offline`
  可用；`.pnpm` 不存在时 include 是 `optional`，cargo 回落到 crates.io 直连。
- **一处维护**：`.npmrc`、忽略规则、编排脚本各只有一份。

## Consequences

- `pnpm install` 会扫全树找 `Cargo.toml`（**不遵守 `.gitignore`**）并对每个跑 `cargo metadata`；
  任何一个加载不了，整次安装失败。嵌在 workspace 成员目录里的第三方清单**无法用
  `workspace.exclude` 排除**，所以 `crates/tauri-plugin-mojuan-render/ios/.build/`（SwiftPM 检出）
  不能留在仓库里：本机跑 swift 工具链要用 `--scratch-path` 指到仓库外。`exclude` 只对不在成员
  目录里的第三方清单有效（`.scratch/` 之类）。
- `.cargo/config.toml` 里不能再手写 `[source.crates-io] replace-with`：与 pnpm 生成的源定义指向
  同一个仓库地址时 cargo 拒绝加载；地址错开则手写那条会盖过 include 进来的，`.pnpm/crates`
  闲置、离线构建失败。这条取代了 `docs/agents/build-environment.md` 原先「cargo 源不要改动」的
  记录。
- pnpm 12 用 `allowBuilds` 映射表授权构建脚本（`onlyBuiltDependencies` 已在 v11 移除）；
  `jsdom` 靠 `publicHoistPattern` 提到仓库根，因为用它的源文档测试在 `crates/mojuan-core/src/js/`、
  由 `apps/mojuan` 的 vitest 跨包加载。
- 跨包读取按相对路径写死的地方随重排一起改（`apps/updater` 的测试读
  `apps/mojuan/src-tauri/tauri.conf.json`；`crates/tauri-plugin-mojuan-update` 的测试读同一份）。
  这些读取没有声明的 interface，架构评审的「包之间按相对路径读对方的文件」候选记的就是它们。
- `docs/research/` 的历史纪要保留原文，只在开头加一行现状说明。
