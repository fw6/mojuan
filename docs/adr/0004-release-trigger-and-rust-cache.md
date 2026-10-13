# ADR-0004: 发布在 master 上触发，Rust 缓存保留第三方依赖产物

- 状态：Accepted
- 日期：2026-10-13

## Context

发布流水线此前由版本 tag 推送（`app-v*`）触发，一次约 19 分钟，其中绝大部分是重编。
两处成因：

- **GitHub Actions 的缓存按 ref 隔离**：tag 运行读不到别的 tag 存下的缓存，只读得到
  默认分支的。实测 1.6.4 的 Android 作业对 1.6.3 存下的 1 GB 缓存报 `No cache found`；
  同一个运行里 master 的 CI 存下的 pnpm 缓存（`node-cache-Linux-x64-pnpm-…`）却命中。
  每个 tag 只发布一次，所以 tag 触发的发布永远是冷编译。
- **rust-cache 的缓存内容一直是空的**（每次只存下 2.7 KB）。它用「依赖的 manifest 路径
  在不在工作区根之下」区分工作区成员与第三方依赖，而 ADR-0003 之后 crate 由 pnpm 归档
  成目录源放在仓库根内的 `.pnpm/crates`，`cargo metadata` 报出的依赖 manifest 因此全部
  落在仓库根之下，被当成工作区成员从 `target/**/deps` 里删掉。本地按同一判定跑一遍：
  工作区根取仓库根时保留 0 个文件、删除 23259 个。

## Decision

- 发布改由 **master 上的手动 `workflow_dispatch`** 触发；tag（`app-v<版本>`）与 release
  由 action 按 `tauri.conf.json` 里的版本号现创建。非 master 的 ref 由 `guard` 作业挡下。
- `swatinem/rust-cache` 的 `workspaces` 写成 `apps/mojuan -> ../../target`：工作区根取
  `apps/mojuan`（依赖的 manifest 落在它之外而被保留），目标目录仍指回仓库根的 `target`。
  同时把 `prefix-key` 换成 `v1-rust`，让按旧构成存下的条目整体失效。
- 桌面矩阵的 `key` 带上 `matrix.args`，让共用同一个 job id 的两个 macOS 矩阵项各自持有缓存。
- Android 作业只出 **arm64-v8a**（`--target aarch64`），并加一份 Gradle 的
  `~/.gradle/caches` 与 `~/.gradle/wrapper` 缓存。

## Rationale

- **缓存作用域**：master 上的运行彼此共用一个作用域，历次发布之间、发布与 CI 之间都能
  复用编译产物，这是 tag 触发做不到的。
- **编译次数**：`tauri android build` 对每个 ABI 各编译一遍 Rust 代码，四个 ABI 让这一步
  从约 4 分钟涨到约 13 分钟；本地的 `.scratch/android-build.sh` 也只出 arm64。
- **Gradle 发行包**：`gen/android` 不入库（ADR-0003 的忽略规则），wrapper 每次现生成，
  没有缓存就要重下 `gradle-8.14.3-bin.zip` 与 AGP/Kotlin 的依赖，约 1 分钟。

## Consequences

- 发版不再是 `git push --tags`：版本升到 `tauri.conf.json`、提交并推 master 之后，在
  master 上 dispatch `release.yml`。dispatch 时选错分支会被 `guard` 挡下而不是发出去。
- 发布产物只覆盖 arm64-v8a：armeabi-v7a / x86 / x86_64 的 Android 设备与模拟器装不上
  这个 APK。要恢复多 ABI 只需去掉 `--target aarch64`，代价是那一作业回到约 19 分钟。
- `Cargo.lock` 不进缓存键：rust-cache 只读工作区根下的 `Cargo.lock`，而工作区根现在是
  `apps/mojuan`。依赖版本变动时靠 cargo 自己的指纹重编，`.cargo/config.toml` 与各
  `Cargo.toml` 仍在键里（前者由 rust-cache 从运行目录 glob 到，后者由 `cargo metadata`
  的成员清单取）。
- 缓存键在一代前缀内稳定，命中精确键时 rust-cache 不再重存，所以同一代缓存的内容停在
  第一次存下时的状态；键的构成（`Cargo.toml` 内容、rust 版本、`key` 输入）变化时才另存。
- 这条取代了 `docs/research/desktop-ci-release.md` §7 记的 tag 触发方案。
