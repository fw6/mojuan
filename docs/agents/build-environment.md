# 构建环境

## 安装与两张图

- 仓库根是 pnpm workspace（`pnpm-workspace.yaml`）：`packages` 列出 `apps/*` 两个 npm 包，`cargo.enabled: true` 让同一次 `pnpm install` 也解析 Cargo workspace 的依赖。
- crate 归档进 `.pnpm/crates/crates-io`，`pnpm install` 往根 `.cargo/config.toml` 的 marker 之间写 include 块；`cargo build` 之后离线编译（Cargo 1.95 起读这个 include）。`.pnpm` 不存在时（新克隆）include 是 `optional`，cargo 回落到 crates.io 直连。
- pnpm 版本固定在根 `package.json` 的 `packageManager`；cargo 支持要 pnpm 12.4 以上。
- `allowBuilds` 列出允许跑构建脚本的依赖（`esbuild`、`workerd`）。pnpm 12 默认跳过所有构建脚本，用错字段（`onlyBuiltDependencies` 在 v11 已移除）会让安装以 `ERR_PNPM_IGNORED_BUILDS` 失败。
- `publicHoistPattern` 把 `jsdom` 提到仓库根：用它的源文档测试在 `crates/mojuan-core/src/js/`，由 `apps/mojuan` 的 vitest 跨包加载，pnpm 默认不让包目录之外解析到别人的依赖。

## cargo 源

- crates-io 的源由 pnpm 负责：索引地址（rsproxy.cn，国内镜像）声明在 `pnpm-workspace.yaml` 的 `registries`，`.cargo/config.toml` 只留 `[registries.crates-io] protocol = "sparse"`。
- **不要在 `.cargo/config.toml` 里手写 `[source.crates-io] replace-with`**：与 pnpm 生成的源定义指向同一个仓库地址时 cargo 直接拒绝加载（`source ... defines source registry ... already defined`）；地址错开则手写那条会盖过 include 进来的，`.pnpm/crates` 闲置、`--offline` 构建失败。

## pnpm 扫 Cargo.toml（安装失败的常见成因）

- `pnpm install` 会扫全树找 `Cargo.toml`，对每一个跑 `cargo metadata`，并且**不遵守 `.gitignore`**。其中一个加载不了，整次安装就失败。
- 嵌在 workspace 成员目录里的第三方清单**无法用 `workspace.exclude` 排除**（最小用例可复现），只能不把它留在仓库里。本仓库唯一的这种位置是 `crates/tauri-plugin-mojuan-render/ios/.build/`（SwiftPM 的检出，里面有 `checkouts/swift-rs/Cargo.toml`）。本机要跑 swift 工具链时用 `--scratch-path` 指到仓库外（例如 `$TMPDIR/mojuan-swift`）。
- 不在任何成员目录里的第三方清单（中间结果目录 `.scratch/` 之类）由根 `Cargo.toml` 的 `exclude` 兜住。

## workspace 构建产物

- `target/`、`.pnpm/`、`build/` 由仓库根生成，忽略规则写在根 `.gitignore`（`apps/mojuan/.gitignore` 只管该包特有的 `src-tauri/gen` 与 `src-tauri/tauri`）。
- 发布产物统一写进根 `build/`（`release.yml` 的移动作业从那里上传），不进源码目录。

## 命令

- 命令速查见根 `AGENTS.md`（核心命令一节）。
