# Desktop CI/发布方案（wayfinder #9）

> **路径说明**（2026-10-12 布局改动）：本文里的 `desktop/` 现为 `apps/mojuan/`，`desktop/crates/` 现为 `crates/`，`updater/` 现为 `apps/updater/`，`npm`/`npx` 换成 `pnpm`。

> **触发方式说明**（2026-10-13）：发布改为在 master 上手动 dispatch `release.yml`，tag 与 release 由 action 按版本号现创建，原因见 [ADR-0004](../adr/0004-release-trigger-and-rust-cache.md)；下面 §7 记的是当时的研究结论。

Ticket: https://github.com/fw6/mojuan/issues/9 · 研究日期：2026-08-15。核验对象：tauri-action **v1.0.0**（GitHub Release tag `action-v1.0.0`，发布于 2026-06-29，见 GitHub API `repos/tauri-apps/tauri-action/releases/latest`；README/官方示例/官方 CI 指南统一用 `tauri-apps/tauri-action@v1` 引用）、Tauri v2 官方文档、Apple notarization 文档。旧 release.yml（移动端 APK 发布）已在 big-bang 提交 `843d417` 中随 sparkling-cimoc 一起删除（`git log --diff-filter=D` 核验），本方案为桌面端全新搭建。

## 结论与推荐（TL;DR）

**推荐：单 GitHub Actions workflow（仓库根 `.github/workflows/release.yml`）+ `tauri-apps/tauri-action@v1`，四平台矩阵（macOS aarch64 / macOS x86_64 / ubuntu-22.04 / windows-latest）构建并上传到 GitHub Releases。签名策略：macOS 用 ad-hoc 签名不公证、Windows/Linux 不签名；发布渠道为直接发布（`releaseDraft: false`），tag 推上去 workflow 跑完即对外。**

1. **tauri-action v1.0.0 是三平台发布的官方推荐路径**：构建后自动创建 GitHub Release、上传产物、用 `__VERSION__` 替换版本号（https://github.com/tauri-apps/tauri-action）。官方 CI 指南的完整发布模板即 `tauri-action@v1` + 上面这个矩阵（https://v2.tauri.app/distribute/pipelines/github/）。
2. **本仓库的 `desktop/` 子目录布局用 `projectPath: desktop` 即可**：tauri-action 从 projectPath 读 `tauri.conf.json`（含 `beforeBuildCommand`/`beforeDevCommand`）并在该目录执行 `tauri build`，无需任何兼容层（同上链接 + action 的 `action.yml` 输入定义）。
3. **依赖缓存不在 action 内部**：官方 CI 指南用 `actions/setup-node@v6`（`cache: 'npm'`，需指到 `desktop/package-lock.json`）+ `swatinem/rust-cache@v2`（本仓库映射 `workspaces: './desktop -> target'`，因 cargo workspace 根是 `desktop/`、target 在 `desktop/target`）。
4. **macOS v1 采用 ad-hoc 签名（`bundle.macOS.signingIdentity: "-"`）**：免费 Apple 账号无法公证；ad-hoc 能避免 Apple Silicon 上「从 GitHub Release 下载的包被标记 damaged」，但用户仍会在「隐私与安全性」里看到未验证并需手动放行。完整签名+公证（Developer ID + notarytool）留待以后，workflow 形态不用改，只需加证书导入步骤 + secrets。
5. **Windows v1 不签名**：不签名时用户从浏览器下载会吃到 SmartScreen「未知发布者」警告（可本地放行）；OV/EV 证书有成本与门槛，v1 不值得。https://v2.tauri.app/distribute/sign/windows/
6. **Linux v1 不签名**：`tauri build`（`bundle.targets: "all"`）在 ubuntu runner 上原生产出 .deb/.rpm/.AppImage；AppImage 签名是可选增强（gpg），官方明确「artifact signing is not required for your application to be deployed on Linux」。https://v2.tauri.app/distribute/sign/linux/
7. **仓库根 `.cargo/config.toml`（crates-io → rsproxy.cn）会被 CI 自动继承**：该文件已纳入 git（`git ls-files .cargo/` 核验）且未被 ignore；cargo 配置沿「当前目录向上」查找，checkout 后仓库内任何 `cargo` 调用都会命中（https://doc.rust-lang.org/cargo/reference/config.html）。唯一新增运行风险是 GitHub runner → rsproxy.cn 的连通性（本机无法模拟 GitHub runner 网络），首次 CI 需跑通验证。
8. **v1 不含 auto-update**：tauri-action 默认 `uploadUpdaterJson`/`uploadUpdaterSignatures=true`，但未配置 updater 时无 `.sig`/manifest 产物可传。将来若加更新器：`tauri signer generate` + `plugins.updater.pubkey` + `bundle.createUpdaterArtifacts: true`，私钥经 CI secrets `TAURI_SIGNING_PRIVATE_KEY`（可选 `_PASSWORD`）注入，且 macOS 公证事实上成为必需（更新器在 macOS 上是整包替换）。
9. **工具链**：Rust 用 `dtolnay/rust-toolchain@stable`（Tauri v2 当前 workspace MSRV = **1.90**，核验自 tauri 仓库 dev 分支根 `Cargo.toml` 的 `rust-version`，tauri crate 当前 2.11.5）；Node 用 `setup-node` 的 `lts/*`（本项目 Vite ^7 要求 Node `^20.19.0 || >=22.12.0`，`npm view vite@7 engines` 核验）。

---

## 1. tauri-action：版本、能力与用法

### 1.1 当前版本（2026-08-15 核验）

- 最新 Release 为 **v1.0.0**（release tag `action-v1.0.0`，2026-06-29），仓库维护移动标签 `v1` / `v1.0`；README、仓库 examples 目录（`examples/publish-to-auto-release.yml` 等）、官方 CI 指南统一写 `tauri-apps/tauri-action@v1`。https://github.com/tauri-apps/tauri-action
- 运行时为 node24（`action.yml` 的 `runs.using: 'node24'`，`main: dist/index.js`）。https://github.com/tauri-apps/tauri-action/blob/dev/action.yml
- 注：`v2.tauri.app/start/ci/` 已 404，CI 指南迁移到了 `https://v2.tauri.app/distribute/pipelines/github/`（从 tauri-docs 仓库 `src/content/docs/distribute/Pipelines/github.mdx` 核验）。

### 1.2 能力与输入（`action.yml`，dev 分支，2026-08-15 核验）

输入（name：description / default）：

- `projectPath`：构建的 Tauri 工程根路径，**默认 `'.'`**，「It must NOT be gitignored」。
- `tagName` / `releaseName` / `releaseBody`：创建/上传 Release 的 tag、标题、正文；`__VERSION__` 会被 action 自动替换为 app 版本。
- `releaseDraft`（默认 `false`）/ `prerelease`（默认 `false`）/ `generateReleaseNotes`（默认 `false`）/ `releaseCommitish`。
- `args`：透传给 `tauri build` 的参数（如 `--target aarch64-apple-darwin`、`--bundles app,dmg`）。
- `uploadUpdaterJson`（默认 `true`）：是否用 GitHub Releases 作 CDN 上传 updater 静态 JSON。
- `uploadUpdaterSignatures`（默认 `true`）：是否上传 tauri CLI 生成的 `.sig`。
- `updaterJsonPreferNsis`（默认 `false`）：同时存在 NSIS 与 MSI 时 updater JSON 优先哪种。
- `uploadPlainBinary`（默认 `false`）、`uploadWorkflowArtifacts`（默认 `false`）+ `workflowArtifactNamePattern`、`releaseAssetNamePattern`。
- `tauriScript`（自定义构建脚本）、`retryAttempts`、`owner`/`repo`/`githubBaseUrl`（GitHub Enterprise）、`mobile`（实验性，桌面构建不用）。
- 输出：`releaseId` / `releaseHtmlUrl` / `releaseUploadUrl` / `artifactPaths` / `appVersion`。

行为（README 原文）：「the action will build the app, create a GitHub release itself, and upload the app bundles to the newly created release」；从 tauri.conf.json 的 `version` 自动生成 tag 与 release 标题。https://github.com/tauri-apps/tauri-action

### 1.3 对子目录布局（本仓库）的适配

- README：「When your Tauri app is not in the root of the repo, use the `projectPath` input」；官方 CI 指南：「When your app is not on the root of the repository, use the `projectPath` input」。https://v2.tauri.app/distribute/pipelines/github/
- `beforeBuildCommand`/`beforeDevCommand`（本项目已配置：`npm run build` / `npm run dev`）在 projectPath 内由 tauri CLI 执行；CI 指南明确 workflow 仍需先装前端依赖（「Install the frontend dependencies and, if not configured as `beforeBuildCommand`, run the web app's build script」）。即：workflow 里 `npm install` 必须在 tauri-action 之前，`npm run build` 不用手动跑。
- cargo workspace（`desktop/Cargo.toml` 虚拟 workspace：`src-tauri` + `crates/mojuan-core`）对 action 透明——action 在 projectPath 内跑 `cargo build`，workspace 成员照常编译；只有 rust-cache 的目录映射需要按本仓库布局调（见 1.4）。
- 注：action 官方示例里 macOS 双 job 各自 `--target aarch64/x86_64-apple-darwin`，Tauri 为 macOS 产物文件名追加架构后缀（`mojuan_0.1.0_aarch64.dmg` 等），两个 job 的产物可共存同一 Release。

### 1.4 依赖缓存

- tauri-action **自身不提供缓存**（`action.yml` 无任何 cache 输入）。官方 CI 指南的缓存做法：`actions/setup-node@v6` 的 `cache: 'npm'` + `swatinem/rust-cache@v2`（示例映射 `./src-tauri -> target`；本仓库应为 `workspaces: './desktop -> target'`，因为虚拟 workspace 的 target 在 `desktop/target`——这一行是对官方示例的推导，非官方原文）。
- 官方示例 workflow 步骤顺序：checkout → ubuntu 系统依赖 → setup-node → dtolnay/rust-toolchain@stable（macOS 加 targets）→ rust-cache → 前端依赖安装 → `tauri-apps/tauri-action@v1`。https://v2.tauri.app/distribute/pipelines/github/

## 2. macOS 签名与公证

### 2.1 硬性要求

- **Apple Developer Program 付费账号（$99/年）**：免费账号「will not be able to notarize your application and it will still show up as not verified when opening the app」；公证需要签名有效。https://v2.tauri.app/distribute/sign/macos/
- 应用商店之外分发需要 **Developer ID Application 证书**（「Apple Distribution」只用于 App Store）；「Only the Apple Developer Account Holder can create Developer ID Application certificates」。https://v2.tauri.app/distribute/sign/macos/
- 签名过程要求 Apple 设备（Tauri 文档称是签名流程与 Apple 条款要求）；公证要求 app 以 **hardened runtime** 签名且 **bundle identifier 有效**。https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution
- 当前公证工具是 **notarytool**（取代 altool）：`xcrun notarytool submit`（Apple ID 路由 `--apple-id/--password/--team-id`，或 App Store Connect API 路由 `--key-path/--key-id/--issuer-id`），成功后 `xcrun stapler staple` 打票、`xcrun stapler validate` 校验。https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution

### 2.2 Tauri v2 的配置方式

- `tauri.conf.json` → `bundle.macOS.signingIdentity`（字符串，如 `"-"` 表示 ad-hoc）。
- tauri CLI 读取的环境变量（全部按官方签名指南）：`APPLE_SIGNING_IDENTITY`、`APPLE_CERTIFICATE`（base64 编码的 .p12）、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_API_ISSUER` / `APPLE_API_KEY` / `APPLE_API_KEY_PATH`（App Store Connect API 路由）、`APPLE_ID`、`APPLE_PASSWORD`（app-specific password）、`APPLE_TEAM_ID`。https://v2.tauri.app/distribute/sign/macos/
- 构建命令：`tauri build --bundles app,dmg`（以及 `--skip-stapling` 变体）；设置上述环境变量后 tauri CLI 在 macOS 构建中自动完成签名 + 公证 + stapling。同上链接。
- 官方 GitHub Actions 示例（`examples/publish-to-auto-release-universal-macos-app-with-signing-certificate.yml`）：先用 `security create-keychain`/`import`/`set-key-partition-list` 把 `.p12` 导入临时 keychain（`APPLE_CERTIFICATE` 解码），`codesign` 从 keychain 里取 `Developer ID Application` identity 写入 `APPLE_SIGNING_IDENTITY`，再以 `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID` 传给 action 让 CLI 自动公证。https://github.com/tauri-apps/tauri-action/blob/dev/examples/publish-to-auto-release-universal-macos-app-with-signing-certificate.yml

### 2.3 最小可行路径（个人项目）

| 方案 | 成本 | 效果 | 结论 |
|---|---|---|---|
| 完全不签名 | 零 | Apple Silicon 上从网上下载的 app **必须**有签名，未签名包会被标记 **damaged/无法打开** | 不可取 |
| **ad-hoc 签名（`signingIdentity: "-"`）** | 零，无需 Apple 账号 | 避免 damaged；但 app 仍「未验证」，用户需在「隐私与安全性」手动放行（右键打开） | **v1 推荐** |
| 完整 Developer ID + 公证 | $99/年 + 证书 + CI secrets | Gatekeeper 无警告、最顺滑体验 | 后置，随时可加 |

- 官方原文支撑：签名指南「Ad-hoc code signing does not prevent macOS from requiring users to whitelist the app in Privacy & Security settings」「It works on ARM (Apple Silicon) devices, where code-signing is required for all apps from the Internet」。https://v2.tauri.app/distribute/sign/macos/
- CI 指南原文：「If you build a macOS app without an Apple signing certificate, configure an ad-hoc signing identity. This can avoid macOS treating Apple Silicon builds downloaded from GitHub releases as damaged.」https://v2.tauri.app/distribute/pipelines/github/
- 落地方式：在 `tauri.conf.json` 的 `bundle` 加 `"macOS": { "signingIdentity": "-" }`（本地构建与 CI 行为一致、可复现）。将来升级完整签名时删掉该配置、改走环境变量即可，workflow 结构不变。

## 3. Windows 签名

- **不签名的后果**：从浏览器下载时触发 SmartScreen「Windows 已保护你的电脑」（未知发布者）警告；官方原文「It is not required to execute your application on Windows, as long as your end user is okay with ignoring the SmartScreen warning or your user does not download via the browser」。https://v2.tauri.app/distribute/sign/windows/
- **证书选项**：EV（扩展验证）证书「If you sign the app with an EV Certificate, it'll receive an immediate reputation with Microsoft SmartScreen」（贵、需硬件令牌）；OV 证书在 2023-06-01 前签发的老证可逐步积累信誉，新 OV 证仍可能告警，可提交 Microsoft 人工审核。https://v2.tauri.app/distribute/sign/windows/
- **Tauri v2 配置**：`bundle.windows` 的 `certificateThumbprint` + `digestAlgorithm`（如 `sha256`）+ `timestampUrl`；`signCommand` 可覆盖整个签名步骤（接入 Azure artifact-signing-cli 等外部工具，跨平台交叉编译 Windows 安装包时必须用）。https://v2.tauri.app/distribute/sign/windows/
- **CI 注入方式**（官方指南 workflow）：secrets `WINDOWS_CERTIFICATE`（.pfx 的 base64）+ `WINDOWS_CERTIFICATE_PASSWORD`，在 tauri-action 前用 `certutil -decode` + `Import-PfxCertificate` 导入证书存储；Azure 签名另用 `AZURE_CLIENT_ID/SECRET/TENANT_ID`。同上链接。
- **v1 决策**：不签名，接受 SmartScreen 警告；以后买了证书按官方 workflow 模板加一步导入即可。

## 4. Linux 打包（deb/rpm/AppImage）

- 本仓库 `tauri.conf.json` 的 `bundle.targets: "all"`：tauri-utils 的 `BundleType::all()` 展开为 `[Deb, Rpm, AppImage, Msi, Nsis, App, Dmg]`（核验自 tauri 仓库 dev 分支 `crates/tauri-utils/src/config.rs`）；tauri-bundler 的 `bundle_project` 按 `#[cfg(target_os)]` 分派、不匹配当前平台的类型打「ignoring …」警告后跳过（核验自 `crates/tauri-bundler/src/bundle.rs`）。因此：
  - **ubuntu runner**：产出 `.deb` + `.rpm` + `.AppImage`；
  - macOS：`.app` + `.dmg`；Windows：NSIS `-setup.exe` + MSI `.msi`（官方安装器文档原文「Building MSI packages ("targets": "msi" or "targets": "all")」，https://v2.tauri.app/distribute/windows-installer/）。
- 官方文档页：https://v2.tauri.app/distribute/debian/ 、https://v2.tauri.app/distribute/rpm/ 、https://v2.tauri.app/distribute/appimage/
- **AppImage 签名可选**：官方 Linux 签名指南原文「artifact signing is not required for your application to be deployed on Linux」「can be used to increase trust」；用 gpg/gpg2，环境变量 `SIGN=1`、`SIGN_KEY`、`APPIMAGETOOL_SIGN_PASSPHRASE`（CI 必须设，否则 gpg 弹交互框）、`APPIMAGETOOL_FORCE_SIGN`。注意官方警告：AppImage 自身不校验签名，签名只是信任增强。https://v2.tauri.app/distribute/sign/linux/
- **ubuntu runner 系统依赖**（官方 CI 指南）：`libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf xdg-utils`（https://v2.tauri.app/distribute/pipelines/github/）。注意前置要求页用的是 `libayatana-appindicator3-dev`（https://v2.tauri.app/start/prerequisites/）；两处均为官方文档，ubuntu 上两者之一通常可装，以 CI 指南这份为准，装不上再换 Ayatana 版。
- **v1 决策**：不签名，直接发布三个产物。

## 5. 仓库特定约束

- **`.cargo/config.toml`（crates-io → rsproxy.cn）**：已 `git ls-files` 确认纳入版本库、未被 ignore。cargo 配置发现规则是「从当前工作目录向上逐级查找」直到文件系统根（https://doc.rust-lang.org/cargo/reference/config.html），`actions/checkout` 把整个仓库检出到 `$GITHUB_WORKSPACE` 后，仓库内任何 `cargo` 调用都会命中根目录这份配置——**CI 自动继承 rsproxy 镜像，无需额外配置**。风险点：GitHub 托管 runner 在微软 Azure 机房，到 rsproxy.cn 的连通性/稳定性未验证（本机无法模拟），首次 CI 运行须确认能拉到 crate；如遇问题再评估（按 AGENTS.md 约定不改镜像配置本身）。rustup 装工具链不走 cargo 配置，不受影响。
- **项目版本与元数据**（`desktop/src-tauri/tauri.conf.json`）：`productName: mojuan`、`version: 0.1.0`、`identifier: com.example.mojuan`（仍是脚手架占位符——建议首次对外发布前改成正式 identifier，因为它参与 macOS 公证的有效 bundle id、且是长期身份标识，发布后再改会造成版本断裂）、`bundle.targets: "all"`、`beforeBuildCommand: "npm run build"`、`beforeDevCommand: "npm run dev"`、`frontendDist: "../dist"`、`app.withGlobalTauri: true`。
- **前端**（`desktop/package.json`）：`version 0.1.0`，无 `engines` 字段；`@tauri-apps/api ^2`、`@tauri-apps/plugin-opener ^2`、React `^19.1`、Vite `^7`（npm 最新 7.x = 7.3.1，`engines: node ^20.19.0 || >=22.12.0`）、TypeScript `~5.8.3`。CI 用 `node-version: lts/*` 满足。
- **Rust**（`desktop/Cargo.toml` 虚拟 workspace：`src-tauri` + `crates/mojuan-core`，resolver 2，均 edition 2021；`desktop/src-tauri/Cargo.toml` 依赖 tauri 2 / tauri-plugin-opener 2 / tauri-plugin-mcp-bridge 0.12 / 本地 `mojuan-core`）。工具链：`dtolnay/rust-toolchain@stable` 即可（当前 stable 远高于 Tauri v2 MSRV）。Tauri v2 当前 workspace `rust-version = "1.90"`（核验自 tauri 仓库 dev 分支根 `Cargo.toml`，tauri crate 版本 2.11.5）。`@tauri-apps/cli` npm 最新 2.11.4。
- **历史 workflow**：仓库 `.github/workflows/` 下已无文件；此前全部 CI 均为已删除的移动端 APK 发布（big-bang 提交 `843d417` 移除），桌面端为全新开始。

## 6. auto-update（更新器）对签名/CI 的隐含要求

- v1 **不包含** updater（无 `tauri-plugin-updater` 依赖、`plugins.updater` 未配置、`bundle.createUpdaterArtifacts` 未开）。tauri-action 默认 `uploadUpdaterJson`/`uploadUpdaterSignatures=true`，但没有 updater 产物时无 JSON/`.sig` 可传，无副作用。
- 将来启用 auto-update 时的要求（官方插件文档 https://v2.tauri.app/plugin/updater/）：
  - `tauri signer generate` 生成密钥对；公钥以字符串形式写入 `tauri.conf.json` → `plugins.updater.pubkey`（不能是文件路径）。
  - `bundle.createUpdaterArtifacts: true`（或 `"v1Compatible"`）让 `tauri build` 产出各平台更新产物：Linux `.AppImage` + `.sig`、macOS `.app.tar.gz` + `.sig`、Windows `-setup.exe`/`.msi` + `.sig`。
  - 私钥经环境变量注入构建：`TAURI_SIGNING_PRIVATE_KEY`、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`（文档明确 `.env` 文件不生效，必须走环境变量/CI secrets）。
  - tauri-action 会替你上传 `.sig` 并生成 GitHub Releases CDN 用的静态 JSON（`uploadUpdaterJson`）。
  - **macOS 公证事实上成为必需**：更新器在 macOS 上是整包替换下载安装，未签名/未公证的更新包会被 Gatekeeper 拦截——这是把「完整 macOS 签名+公证」从「后置」变成「必须」的关键触发点。

## 7. 决策落地：推荐 workflow

触发方式：push 版本 tag（`app-v*`，官方 CI 指南提供的 tag 触发变体）+ `workflow_dispatch` 手动触发。发布渠道：`releaseDraft: false`（直接发布，tag 推上去 workflow 跑完即对外）；tag/标题由 action 用 `__VERSION__` 自动生成。

```yaml
name: 'release'

on:
  workflow_dispatch:
  push:
    tags:
      - 'app-v*'

jobs:
  publish-tauri:
    permissions:
      contents: write
    strategy:
      fail-fast: false
      matrix:
        include:
          - platform: 'macos-latest'
            args: '--target aarch64-apple-darwin'
          - platform: 'macos-latest'
            args: '--target x86_64-apple-darwin'
          - platform: 'ubuntu-22.04'
            args: ''
          - platform: 'windows-latest'
            args: ''

    runs-on: ${{ matrix.platform }}
    steps:
      - uses: actions/checkout@v7

      - name: install dependencies (ubuntu only)
        if: matrix.platform == 'ubuntu-22.04'
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf xdg-utils

      - name: setup node
        uses: actions/setup-node@v6
        with:
          node-version: lts/*
          cache: 'npm'
          cache-dependency-path: desktop/package-lock.json

      - name: install Rust stable
        uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.platform == 'macos-latest' && 'aarch64-apple-darwin,x86_64-apple-darwin' || '' }}

      - name: Rust cache
        uses: swatinem/rust-cache@v2
        with:
          workspaces: './desktop -> target'

      - name: install frontend dependencies
        working-directory: desktop
        run: npm install

      - uses: tauri-apps/tauri-action@v1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          projectPath: desktop
          tagName: app-v__VERSION__
          releaseName: 'Mojuan v__VERSION__'
          releaseDraft: true
          prerelease: false
          args: ${{ matrix.args }}
```

配套动作（两处小改动）：

1. `desktop/src-tauri/tauri.conf.json` 的 `bundle` 增加 `"macOS": { "signingIdentity": "-" }`（ad-hoc 签名，避免 Apple Silicon 上 dmg 被标记 damaged）。
2. 把 `identifier` 从脚手架占位 `com.example.mojuan` 改为正式值（发布后再改会破坏版本身份连续性）。

前置验证：首次 CI 跑通前先确认 GitHub runner 能访问 rsproxy.cn（`cargo` 拉依赖）与 npm registry。

## Sources

- tauri-action：README / `action.yml` / `examples/publish-to-auto-release.yml` / `examples/publish-to-auto-release-universal-macos-app-with-signing-certificate.yml`（dev 分支，版本 v1.0.0，2026-08-15 核验）—— github.com/tauri-apps/tauri-action
- Tauri v2 官方：CI 指南 `distribute/Pipelines/github`（原 `start/ci/` 已 404）、`distribute/Sign/macos`、`distribute/Sign/windows`、`distribute/Sign/linux`、`distribute/windows-installer`、`distribute/debian|rpm|appimage`、`start/prerequisites`、`plugin/updater`—— v2.tauri.app
- Apple：`notarizing_macos_software_before_distribution`（notarytool/stapler/公证前提）—— developer.apple.com
- Rust：`reference/config.html`（cargo 配置向上查找）—— doc.rust-lang.org
- Tauri 源码（dev 分支，2026-08-15 核验）：`crates/tauri-utils/src/config.rs`（`BundleType::all()`）、`crates/tauri-bundler/src/bundle.rs`（`#[cfg(target_os)]` 分派）、根 `Cargo.toml`（`rust-version = "1.90"`）—— github.com/tauri-apps/tauri
- npm registry：`vite@7` engines（Node `^20.19.0 || >=22.12.0`）、`@tauri-apps/cli` 最新 2.11.4
- 本仓库：`desktop/package.json`、`desktop/src-tauri/tauri.conf.json`、`desktop/src-tauri/Cargo.toml`、`desktop/Cargo.toml`、`desktop/crates/mojuan-core/Cargo.toml`、`.cargo/config.toml`、git 历史（big-bang `843d417` 删除旧 workflow）

未验证项：GitHub 托管 runner → rsproxy.cn 的实际连通性/稳定性（本机无法模拟 GitHub runner 网络环境）；`swatinem/rust-cache` 的 `./desktop -> target` 映射为基于官方示例的推导，非官方原文。
