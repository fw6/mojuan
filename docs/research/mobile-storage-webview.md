# 移动端存储层替换（tauri-plugin-fs）与 mojuan-img scheme / android·ios init 调研

> **后续变更**：这份调研里的 `storage.ts` / `storage-fs.ts` 在 2026-10 按存储域拆进
> `desktop/src/lib/storage/`：平台切换与 Store 单例在 `store.ts`，移动端 fs 版在 `fs.ts`，
> 进度/历史/收藏/设置/已装源/备份各一个文件。平台切换的做法、fs 版的最小形态与「每次
> get/set 都写入磁盘」的结论都不变，只是文件位置与模块边界按域分开了。
>
> **路径说明**（2026-10-12 布局改动）：本文里的 `desktop/` 现为 `apps/mojuan/`，`desktop/crates/` 现为 `crates/`，`updater/` 现为 `apps/updater/`，`npm`/`npx` 换成 `pnpm`。

- 背景：移动里程碑（iOS/Android）的存储层替换与去风险 spike 前置调研。上游定案见 research #3（`tauri-mobile-maturity.md`）与 grilling #29（移动端存储层用 tauri-plugin-fs 读写 `appDataDir` 下 JSON，桌面保持 tauri-plugin-store 不动）。
- 调研日期：2026-08-15。所有结论基于官方一手资料：Tauri v2 官方文档（入口 https://tauri.app/llms.txt → 各 guide/plugin/reference 页）+ 本机 cargo registry 源码（`tauri-2.11.5`、`wry-0.55.1`、`tauri-plugin-fs-2.5.1`、`tauri-plugin-store-2.4.4`）+ 本机 `node_modules/@tauri-apps/plugin-store` 类型定义。每个论断标注来源 URL（或本地源码路径）。

---

## 结论与推荐（TL;DR）

1. **tauri-plugin-fs 在 iOS/Android 写 `appDataDir` JSON 完全可行**：官方平台表 iOS/Android ✓✓（`tauri-apps/plugin-fs` README 平台表，来源：https://tauri.app/plugin/file-system/ ）。前端 `readTextFile`/`writeTextFile`/`readDir`/`mkdir` 签名齐备，`baseDir: BaseDirectory.AppData` 直接解析到 `appDataDir`。**写文件前需先 `mkdir(recursive: true)`**——Rust 侧 `write_file_inner` 只开文件不建父目录（源码 `tauri-plugin-fs-2.5.1/src/commands.rs`，见 §1.3）。capabilities 给 `fs:default` + `fs:allow-write-text-file` + `fs:allow-mkdir` + `fs:scope` 允许 `$APPDATA/**` 即可。
2. **进度/收藏/历史每 get/set 落盘在移动端性能可接受**：Reader 滚动写 progress 已有 250ms 防抖（`desktop/src/screens/Reader.tsx` `onScroll` → `setTimeout(recordProgress, 250)`）；JSON 域文件为小文件（progress/history/favorites 各 10–100 KB 级），全量重写单次 <1ms 量级，移动端闪存 IO 无压力。**不引 SQLite**（grilling #29 已定案 JSON；数据量不需要数据库）。替换面是**前端逻辑**：tauri-plugin-fs 桌面端同样可用、无需 Rust `cfg`；`storage.ts` 内按平台（UA 或 `@tauri-apps/plugin-os`）选择 fs 版 / store 版实现，6 方法代码骨架见 §1.7。
3. **mojuan-img:// 自定义 scheme 移动端可复用，但 Android 有 URL 形态差异**：iOS 与 macOS 同一套 `WKURLSchemeHandler`，URL 形态 `<scheme>://localhost/<path>` 完全一致 → **iOS 零改动直接复用**。Android 无注册自定义协议 API，wry 用 `http://<scheme>.localhost/<path>` workaround（`shouldInterceptRequest` 拦截 + 还原）→ **Android 需前端 `imgSrc`/`localSrc` 按平台拼 URL**（与桌面 Windows 端现状相同，见 research #4）。Rust 侧 `register_asynchronous_uri_scheme_protocol` 注册代码本身跨平台一致，无需改动。
4. **`tauri android init` / `tauri ios init` 产物与前置已核实**：Android 生成 `src-tauri/gen/android/` Gradle 工程（`AndroidManifest.xml`、`MainActivity.kt`、`build.gradle.kts` 均在 `gen/android/app/` 下）；iOS 生成 `src-tauri/gen/apple/` Xcode 工程。前置 = Android Studio + `JAVA_HOME`(jbr) + SDK（Platform/Platform-Tools/NDK/Build-Tools/Command-line Tools）+ `ANDROID_HOME`/`NDK_HOME` + 4 个 android rustup target；iOS = 完整 Xcode + Cocoapods + 3 个 iOS rustup target。**本机全部在位**（Xcode 26.6、Cocoapods 1.16.2、NDK 29.0.14206865、JAVA_HOME 已设、rustup targets 已装），唯一待补是导出 `ANDROID_HOME` 环境变量。清单见 §3.2。

---

## Q1. tauri-plugin-fs 移动端写 `appDataDir` JSON 的可行性与 API 形态

### 1.1 平台支持

`tauri-apps/plugin-fs` README 平台表：**windows / linux / macos / android / ios 全部支持**，移动端备注「Access is restricted to Application folder by default」（默认只允许访问应用专属目录）。来源：https://tauri.app/plugin/file-system/ （平台表）+ plugins-workspace README（research #3 已逐目录核验过 fs ✓✓）。

### 1.2 前端 API 签名（`@tauri-apps/plugin-fs`）

来源：https://v2.tauri.app/reference/javascript/fs/ （JS API 参考，与本地 registry 源码一致）。

| 函数 | 签名 | 说明 |
|---|---|---|
| `readTextFile` | `readTextFile(path, options?): Promise<string>` | `ReadFileOptions: { baseDir?, encoding? }`，encoding 默认 `utf-8` |
| `writeTextFile` | `writeTextFile(path, data, options?): Promise<void>` | data: `string`；`WriteFileOptions: { baseDir?, append?, create?(默认 true), createNew?, mode? }` |
| `writeFile` | `writeFile(path, data, options?): Promise<void>` | data: `Uint8Array | ReadableStream<Uint8Array>`（二进制专用） |
| `readDir` | `readDir(path, options?): Promise<DirEntry[]>` | 递归列出；`DirEntry { name, isDirectory, isFile, isSymlink }` |
| `mkdir` | `mkdir(path, options?): Promise<void>` | `MkdirOptions: { baseDir?, mode?, recursive? }`；`recursive: true` = 等价 `mkdir -p`，创建中间目录 |
| `exists` | `exists(path, options?): Promise<boolean>` | `ExistsOptions: { baseDir? }` |
| `remove` | `remove(path, options?): Promise<void>` | 目录非空需 `recursive: true`；文件不存在报错 |
| `stat` | `stat(path, options?): Promise<FileInfo>` | `FileInfo { isFile, isDirectory, isSymlink, size, mtime, birthtime, ... }` |

所有 path 参数接受 `string | URL`；base dir 用 `BaseDirectory.AppData`（枚举值 14，解析为 `appDataDir`）。来源：https://v2.tauri.app/reference/javascript/fs/

### 1.3 写文件前需不需要手动 mkdir：**需要**

- Rust 侧实现（本地源码 `~/.cargo/registry/src/rsproxy.cn-*/tauri-plugin-fs-2.5.1/src/commands.rs` `write_file_inner`）：打开文件用 `OpenOptions { create: opts.create, truncate, append, create_new, ... }`，`create: true` 只保证**文件**不存在时创建，**不会 `create_dir_all` 父目录**。父目录不存在 → open 报错（`failed to write bytes to file at path: ...`）。
- 因此首次写入某目录前必须 `await mkdir(dir, { baseDir: BaseDirectory.AppData, recursive: true })`（官方 `MkdirOptions.recursive` 文档：「If set to true, means that any intermediate directories will also be created (as with the shell command mkdir -p)」，来源：https://v2.tauri.app/reference/javascript/fs/ ）。
- 本 App 的 JSON 域文件直接位于 `appDataDir` 顶层（`settings.json`/`progress.json` 等），只需保证 `appDataDir` 存在即可——`fs:default` 权限集自带的 `create-app-specific-dirs` 权限允许用 `mkdir` 创建应用专属基目录（`commands.allow = ["mkdir", "scope-app-index"]`，见本地源码 `tauri-plugin-fs-2.5.1/permissions/create-app-specific-dirs.toml`）。`appDataDir` 本身在 Android（`/data/data/<pkg>/files` 体系）与 iOS（应用沙盒 `Library/Application Support`）通常已存在，`mkdir(recursive)` 幂等兜底即可。

### 1.4 与 tauri-plugin-store 的差异

来源：https://tauri.app/plugin/store/ + 本地源码 `tauri-plugin-store-2.4.4/src/store.rs`。

| 维度 | tauri-plugin-store（桌面现状） | tauri-plugin-fs（移动端目标） |
|---|---|---|
| 数据形态 | 每域一 JSON 文件，key-value 映射（`load(file)`） | 自己读写同一个 JSON 文件（内存缓存 + 全量重写） |
| 写盘时机 | `set()` 改内存 + **默认 100ms debounce 自动落盘**（`auto_save: Some(Duration::from_millis(100))`，源码 `store.rs:68`）+ 优雅退出落盘；`save()` 手动；`{ autoSave: false }` 可关 | 每次 `writeTextFile` 立即全量写盘，无延迟 |
| 内存缓存 | 插件内置（`Store` 持 `HashMap`，Rust 侧 Resource） | 需前端自己维护（§1.7 骨架已含） |
| 文件默认位置 | `resolve_store_path` 用 `BaseDirectory::AppData` 解析（源码 `store.rs:26`）→ **`appDataDir`** | `baseDir: BaseDirectory.AppData` → 同一 `appDataDir` |
| 目录创建 | 插件首次 save 自动建目录 | 需显式 `mkdir(recursive)` |

关键点：**store 与 fs 都落在 `appDataDir`**，迁移时文件路径不变、JSON 结构不变，`storage.ts` 上层（`getProgress`/`setSettings`/`exportBackupJson` 等）完全无感。store 的 set 并非「每次立即落盘」（是 100ms debounce + 退出落盘），fs 方案反而是更强的持久性保证。

### 1.5 capabilities：fs 插件权限与 scope

在 `desktop/src-tauri/capabilities/default.json` 的 `permissions` 数组追加（来源：https://tauri.app/plugin/file-system/ 权限段 + 本地 `permissions/default.toml`、`permissions/scope.toml`、`permissions/autogenerated/commands/write_text_file.toml`）：

```json
{
  "identifier": "fs:default"
},
"fs:allow-write-text-file",
"fs:allow-mkdir",
"fs:allow-read-dir",
{
  "identifier": "fs:scope",
  "allow": [{ "path": "$APPDATA/**" }]
}
```

- `fs:default`：授予应用专属目录（AppConfig/AppData/AppLocalData/AppCache/AppLog）的**读**访问 + 创建基目录能力 + `deny-default` 兜底（「By default all potentially dangerous plugin commands and scopes are blocked」）。其子权限 `read-app-specific-dirs-recursive` 已含 `read_text_file`/`read_dir`/`exists`（本地源码 `read-app-specific-dirs-recursive.toml`），所以**读不需要额外授权**。
- `fs:allow-write-text-file`：启用 `write_text_file` 命令（本地源码 `permissions/autogenerated/commands/write_text_file.toml`，`identifier = "allow-write-text-file"`，无预置 scope）。
- `fs:allow-mkdir`：启用 `mkdir` 命令；对 `appDataDir` 顶层之外（如子目录）的创建还需 scope。
- `fs:scope` 全局 scope 授权写路径为 `$APPDATA/**`（官方 scope 文档原话：「An empty permission you can use to modify the global scope」+ `$APPDATA` 变量，见 https://tauri.app/plugin/file-system/ 与本地 `permissions/scope.toml`）。`deny` 优先于 `allow`；路径穿越防护由插件内置（「prevents path traversal」）。

注意 Rust 侧需在 `lib.rs` 注册 `tauri_plugin_fs::init()`（桌面端照常注册，插件三平台可用；`fs` crate 已是 workspace 依赖候选——本机 registry 已有 `tauri-plugin-fs-2.5.1`）。

### 1.6 性能评估：移动端 JSON 每次落盘可接受

- **写频次**：progress 滚动防抖 250ms（`desktop/src/screens/Reader.tsx` `onScroll`），最坏 4 次/秒；favorites/history/settings 均为低频操作。桌面现状 store 是 100ms debounce，量级相当。
- **文件大小**：progress.json = 每个漫画一条 `{chapterIndex, pageIndex, offsetInPage, updatedAt}` ≈ 80–150 B/条；收藏 1000 部 ≈ 200–400 KB；全量 `JSON.stringify` + 写盘在移动端 <1ms 级（内存序列化 + 单次小文件写）。每次 `set` 都是全文件重写，但文件小、频次低，无压力。
- **写串行化**：同一域多 `set` 并发时需排队（防止读-改-写交错丢数据），§1.7 骨架用 per-file Promise 链实现。
- **SQLite vs JSON**：grilling #29 已定 JSON；数据模型（每域扁平 key-value、全量导出备份）不需要关系查询，引 SQLite 反而引入新依赖与移动端原生编译成本。JSON 方案保持与桌面备份/恢复逻辑（`exportBackupJson`/`importBackupData`）完全复用。

### 1.7 替换面：`getStore(file)` 的 fs 版最小形态（6 方法）

接口对齐 `@tauri-apps/plugin-store` 的 `IStore`（`get<T>(key): Promise<T|undefined>`、`set`、`has`、`delete`、`clear`、`entries`，见本机 `node_modules/@tauri-apps/plugin-store/dist-js/index.d.ts`），`storage.ts` 其余逻辑零改动。

```ts
// storage-fs.ts —— 移动端存储层（grilling #29：fs 读写 appDataDir JSON，每次 get/set 落盘）
import { BaseDirectory, mkdir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";

export interface FsStore {
    get<T>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
    has(key: string): Promise<boolean>;
    delete(key: string): Promise<boolean>;
    entries<T>(): Promise<Array<[string, T]>>;
    clear(): Promise<void>;
    save(): Promise<void>; // 兼容占位（fs 已即时落盘）
}

const BASE = BaseDirectory.AppData;
// 每文件一个 JSON 对象缓存（首次读盘，进程内常驻）
const dataCache = new Map<string, Promise<Record<string, unknown>>>();
// 写串行化：同一文件的写操作链式排队，防并发 set 读-改-写交错
const writeQueue = new Map<string, Promise<void>>();

function load(file: string): Promise<Record<string, unknown>> {
    if (!dataCache.has(file)) {
        dataCache.set(file, (async () => {
            try {
                return JSON.parse(await readTextFile(file, { baseDir: BASE }));
            } catch {
                return {}; // 首启文件不存在 / 损坏 → 空对象
            }
        })());
    }
    return dataCache.get(file)!;
}

function persist(file: string): Promise<void> {
    const prev = writeQueue.get(file) ?? Promise.resolve();
    const next = prev.then(async () => {
        await mkdir(".", { baseDir: BASE, recursive: true }); // 幂等建 appDataDir
        await writeTextFile(file, JSON.stringify(await load(file)), { baseDir: BASE });
    });
    writeQueue.set(file, next);
    return next;
}

export function getStore(file: string): FsStore {
    return {
        async get(key) { return (await load(file))[key] as never; },
        async set(key, value) { (await load(file))[key] = value; await persist(file); },
        async has(key) { return key in (await load(file)); },
        async delete(key) {
            if (!(key in (await load(file)))) return false;
            delete (await load(file))[key];
            await persist(file);
            return true;
        },
        async entries() { return Object.entries(await load(file)) as Array<[string, never]>; },
        async clear() {
            const data = await load(file);
            for (const k of Object.keys(data)) delete data[k];
            await persist(file);
        },
        async save() {}, // fs 已即时落盘，占位保持接口一致
    };
}
```

**平台切换位置（前端逻辑，非 Rust cfg）**：tauri-plugin-fs 在桌面端同样可用（本仓库 lib.rs 已注册过 store/dialog/updater/opener 插件，fs 注册即可），所以**不需要** Rust `cfg(target_os)`。grilling #29 要求桌面保持 store 不动 → 在 `storage.ts` 模块级按平台选实现：

```ts
// storage.ts 顶部（保留现有 store 路径不变）
import { load as loadStore } from "@tauri-apps/plugin-store";
import { getStore as getFsStore } from "./storage-fs";

const isMobile = /android|iphone|ipad|ipod/i.test(navigator.userAgent); // 或 @tauri-apps/plugin-os platform()
function getStore(file: string) {
    return isMobile ? getFsStore(file) : loadStore(file); // 桌面 → 现行为
}
```

`storage.test.ts` 已按 `{get,set,has,delete,entries,clear,save}` 契约 mock `@tauri-apps/plugin-store` 的 `load`（S3 seam），fs 版可用同一 fake store 直接测（mock `@tauri-apps/plugin-fs` 四个函数即可）。

---

## Q2. mojuan-img:// 自定义 scheme 在 iOS/Android 的可用性

### 2.1 注册 API 跨平台，无移动端限制

`Builder::register_uri_scheme_protocol` / `register_asynchronous_uri_scheme_protocol` 是 Tauri 核心能力，docs.rs 文档无桌面-only 标注；本仓库 `desktop/src-tauri/src/lib.rs` 已用后者注册 `mojuan-img`。来源：https://docs.rs/tauri/latest/tauri/struct.Builder.html#method.register_asynchronous_uri_scheme_protocol

底层由 wry 在各平台实现（本地源码 `wry-0.55.1`）：

| 平台 | 机制 | 证据 |
|---|---|---|
| iOS / macOS | `WKURLSchemeHandler`（ObjC 类，`webView:startURLSchemeTask:` / `stopURLSchemeTask:`） | `wry-0.55.1/src/wkwebview/class/url_scheme_handler.rs` |
| Android | `WebViewClient.shouldInterceptRequest` 拦截一切请求 → 匹配自定义协议 → 回调 Rust handler | `wry-0.55.1/src/android/kotlin/RustWebViewClient.kt`（`override fun shouldInterceptRequest`）|
| Windows / Linux | WebView2 `AddWebResourceRequestedFilter` / WebKitGTK `webkit_web_context_register_uri_scheme` | research #4 已列 |

即 **iOS 与 macOS 走同一条 `WKURLSchemeHandler` 代码路径**（wry `wkwebview` 模块桌面/移动共用），Tauri 内部已处理 WKWebView 与 Android WebView 的差异；Rust 侧 `mojuan-img` 注册代码移动端**无需任何改动**。

### 2.2 关键差异：URL 形态（Android 需 workaround）

Tauri 官方 Builder 文档原话（本地源码 `tauri-2.11.5/src/app.rs` `register_uri_scheme_protocol` doc 注释）：

> Pages loaded from a custom protocol will have a different **Origin on different platforms**. …
> - **macOS, iOS and Linux**: `<scheme_name>://localhost/<path>` (so it will be `my-scheme://localhost/path/to/page`).
> - **Windows and Android**: `http://<scheme_name>.localhost/<path>` by default (so it will be `http://my-scheme.localhost/path/to/page`).

原因（本地源码 `wry-0.55.1/src/custom_protocol_workaround.rs` 头注释）：WebView2 仅 Windows 10+ 支持非标准协议、**Android 无注册自定义协议的 API**，因此两平台把 `{protocol}://localhost/…` 改写为 `{http}://{protocol}.localhost/…`（`apply_uri_work_around`），`shouldInterceptRequest` 拦截后 `revert_uri_work_around` 还原再交给 handler（`wry-0.55.1/src/android/mod.rs` REQUEST_HANDLER）。

**对本 App 的结论**：

- **iOS：零改动**。`mojuan-img://localhost/img?url=…&ref=…` 与 `mojuan-img://localhost/file?path=…` 在 iOS WKWebView 上形态与 macOS 完全一致，`desktop/src/lib/api.ts` 的 `imgSrc`/`localSrc` 直接复用。
- **Android：前端 URL 需按平台拼 `http://mojuan-img.localhost/img?url=…`**（与桌面 Windows 端已要求的形态相同，research #4 已有记载）。改 `imgSrc`/`localSrc` 一处即可；Rust handler 收到的 request URI 经 wry 还原后仍是 `mojuan-img://localhost/…`，`parse_img_query` 无需动。
- CSP：`tauri.conf.json` 现为 `"csp": null`，无需新增 `img-src` 声明；若将来启用 CSP，需为 iOS/macOS 放行 `mojuan-img:`、Android/Windows 放行 `http://mojuan-img.localhost`。

### 2.3 WebView 图片密集页的内存 / 滚动风险

- WKWebView 将 Web 内容跑在独立进程；移动端内存压力下 webview 进程被杀/崩溃有社区报告（research #3 引述 tauri#7407 "the webview crashes on release target"，来源：https://github.com/tauri-apps/tauri/issues/7407 ）。Android 系统 WebView 同受设备内存约束。
- **现有缓解已就位且应保持**：无限滚动按章追加渲染、`loading="lazy"` 懒加载、图片经 `mojuan-img://` 单块返回（非 base64，无 33% 膨胀，research #4 §3）；Rust 侧 LRU + 磁盘缓存（`mojuan_core::cache::fetch_image`）避免重复解码。**不要**改为 `data:`/base64；移动端建议在真机 spike 中观察 WKWebView/Android WebView 长滚动内存曲线（research #3 第 1 周 spike 的既定内容）。
- 超长条图：单图解码为 RGBA 约 4 B/像素，GPU 纹理上限各引擎典型 16k px 级（research #4）；Webtoon 页图本为逐页条图，移动端若单页超高需按段切片或降采样。来源：research #4 §3 引用的 WebKit/GTK NEWS。
- 官方无「移动端 webview 图片列表」专门指南；社区共识是控并发解码（lazy）+ 避免超大单图 + 内存预警时释放远端 DOM（此处已有按章分页渲染，天然符合）。

### 2.4 慢速取图 vs webview 超时/取消（本仓实测 bug，2026-08-18 修复）

热链大图走 `mojuan-img://` 代理时，`fetch_image` 是阻塞下载（LRU → 磁盘 → 网络），webview 侧对自定义 scheme 请求存在硬性截止，首次下载慢于截止即落空；但 Rust 侧 `spawn_blocking` 后台仍会下载完并落盘，故**下一次请求命中缓存即成功**——这正是「封面能显示、阅读页空白/时好时坏」的根因（封面小图秒下、阅读页条图慢且随滚动卸载）：

- **Android**：wry `shouldInterceptRequest` 同步等响应，`rx.recv_timeout(MAIN_PIPE_TIMEOUT * 3)`（10s × 3 = **30s**，见 `wry-0.55.1/src/android/mod.rs:284`，关联 wry#1551 仍未修复）超时后返回 `None` → 请求落回真实网络 → `http://mojuan-img.localhost` DNS 失败 → 空白。
- **iOS/macOS**：`WKURLSchemeHandler` 的 `stopURLSchemeTask:`（元素卸载即触发）由 wry 移除 task key（`url_scheme_handler.rs:stop_task`），异步 responder 校验失败 → **响应被静默丢弃**，即便 Rust 已下载完并落盘。

**修复（四层，2026-08-18 换代理定案：自用 + Android 优先）**：
1. **图片交付从自定义 scheme 换成 127.0.0.1 本机 HTTP 代理**（`src-tauri/src/img_proxy.rs`，hyper server）：前端 `imgSrc` 拼 `http://127.0.0.1:<port>/img?...`，端口启动时经 `img_proxy_port` 命令取（`main.tsx` 渲染前 `initImgProxy`）。普通 HTTP 请求绕开 `shouldInterceptRequest` 的 30s 上限（Android 根因根治）；`mojuan-img://` scheme 注册与相关代码已移除（AGENTS.md 废弃路径直接删）。iOS 元素卸载仍会 abort 请求 → 第 2 层兜底。
2. 前端 `ProxyImage`（`desktop/src/components/ProxyImage.tsx`）：`<img>` 加载失败按指数退避重建同 URL 重试（300/600/1200/2400ms，最多 4 次），命中缓存即成功；Reader 逐页图接入。
3. Rust `mojuan_core::cache::fetch_image` 加**单飞行去重**：同 URL 下载只发起一次，重试/并发在槽上等同一结果（`IN_FLIGHT` 表），避免移动端慢网下重复拉取大图、并让重试在拦截超时窗口内返回。
4. **离线阅读统一走 url（下载索引）**：下载落盘时记录 `url → 相对路径` 到 `<下载目录>/<source>/<comicId>/download_index.json`（`mojuan-core/native/download_index.rs`）；端点 `/img?url=..&source=..&comicId=..` 先查下载索引（命中直接读下载文件），否则回落 `fetch_image` 缓存。`listDownloaded` 返回 `{url, path}`，阅读器用 `imgSrc(value, {source, comicId})` 拼地址；旧数据（无索引记录）走 `/img?path=`，相对路径由代理按 `<下载目录>/<source>/<comicId>` 定位。下载目录经 `img_proxy_set_download_dir` 命令交给代理（`main.tsx` 读 settings 后调用、设置页改目录时再调一次），代理与前端共享同一个 `Arc<Mutex<String>>` 并每次请求现读。

**Android release 明文**：`gen/android` 被 gitignore 且 CI 每次 `tauri android init` 重建，release `usesCleartextTraffic=false` 会拦 `http://127.0.0.1` 明文请求（debug 为 true 无需处理）。CI 在 init 后注入 `network_security_config.xml` 放行 `127.0.0.1`/`localhost`（`scripts/android-netsec.sh`）；本地 release 构建先跑该脚本。iOS：ATS 豁免 loopback、app 源 `tauri://` 非 https 无 mixed content，无需配置。


---

## Q3. tauri android/ios init 的产物与前置

### 3.1 产物清单

CLI 命令说明（来源：https://v2.tauri.app/reference/cli/ ）：`tauri android init` = "Initialize Android target in the project"、`tauri ios init` = "Initialize iOS target in the project"（`--ci` 跳过交互提示、`--skip-targets-install` 跳过 rustup 装 target、iOS 仅 macOS）。生成位置为 `src-tauri/gen/`（官方指南多处以 `src-tauri/gen/…` 为路径前缀）：

| 平台 | 生成内容（均以 `src-tauri/` 为根） | 来源 |
|---|---|---|
| Android | `gen/android/` Gradle 工程：`app/src/main/AndroidManifest.xml`、`app/src/main/java/<package>/MainActivity.kt`（继承 `TauriActivity`）、`app/build.gradle.kts`、`app/src/main/res/`（mipmap 图标）、`keystore.properties`（签名）；构建产物 `gen/android/app/build/outputs/bundle/universalRelease/app-universal-release.aab` | https://v2.tauri.app/develop/ （移动内联章节）；图标/签名/多窗口小节路径：`src-tauri/gen/android/…` |
| iOS | `gen/apple/` Xcode 工程：`Assets.xcassets/AppIcon.appiconset/`（AppIcon 图标）、Xcode build phase 钩子（执行 Tauri CLI 编 Rust，运行时加载静态库）；构建产物 `gen/apple/build/arm64/<APPNAME>.ipa`；自定义 `Info.plist` 放 `src-tauri/Info.plist` 由 CLI 合并 | 同上；App Store 分发节 `src-tauri/gen/apple/build/arm64/$APPNAME.ipa` |

补充：`tauri icon` 会把移动端图标直接写进 `gen/android` 与 `gen/apple`（官方 App Icons 节：「The mobile icons will be placed into the Xcode and Android Studio projects directly」）。`gen/` 目录由 CLI 生成，建议进 `.gitignore`（未在官方文档强制，社区惯例）。

### 3.2 前置条件清单 + 本机状态

官方前置文档（来源：https://v2.tauri.app/start/prerequisites/ 「Configure for Mobile Targets」节）：

**Android**
1. Android Studio（含 SDK Manager）
2. `JAVA_HOME` 指向 Android Studio 自带 JBR（macOS：`/Applications/Android Studio.app/Contents/jbr/Contents/Home`）
3. SDK Manager 安装：Android SDK Platform、Android SDK Platform-Tools、**NDK (Side by side)**、Android SDK Build-Tools、Android SDK Command-line Tools
4. `ANDROID_HOME` + `NDK_HOME` 环境变量（macOS：`~/Library/Android/sdk`）
5. `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`

**iOS（仅 macOS）**
1. 完整 Xcode（明确注明「installed Xcode and not Xcode Command Line Tools」）
2. `rustup target add aarch64-apple-ios x86_64-apple-ios aarch64-apple-ios-sim`
3. Homebrew + `brew install cocoapods`（Cocoapods 目前仍是官方前置；最新 Xcode 不自带）

**本机实测状态**：

| 项 | 状态 |
|---|---|
| rustup android targets（4 个）| ✅ 全部已装 |
| rustup ios targets（3 个）| ✅ 全部已装（含 aarch64-apple-ios-sim）|
| `JAVA_HOME` | ✅ 已指向 Android Studio jbr |
| Android SDK | ✅ `~/Library/Android/sdk`（platforms/platform-tools/build-tools/cmdline-tools/ndk 在位）|
| NDK | ✅ 29.0.14206865 |
| `ANDROID_HOME` / `NDK_HOME` | ⚠️ **shell 未导出**（SDK 在位，跑 `tauri android …` 前需 `export ANDROID_HOME=~/Library/Android/sdk`）|
| Xcode | ✅ 26.6（Build 17F113）|
| Cocoapods | ✅ 1.16.2 |

### 3.3 dev / build 命令要点

来源：https://v2.tauri.app/develop/ + https://v2.tauri.app/reference/cli/

- `npm run tauri [android|ios] dev`：默认在已连接设备上跑，无设备则交互选模拟器；可指定 `tauri ios dev 'iPhone 15'`；`--open` 打开 Android Studio/Xcode（Tauri CLI 进程须保持存活）；真机 iOS 需 `--host` 与 dev server 用 `TAURI_DEV_HOST`（Vite 配置示例见官方页）；首次 iOS 运行有「查找本地网络设备」权限弹窗。
- `npm run tauri android build`（`--apk` / `--aab` / `--split-per-abi` / `--target aarch64|armv7|i686|x86_64`）；`npm run tauri ios build`（`--target aarch64|aarch64-sim|x86_64`，默认 aarch64；`--export-method` 出 App Store Connect 包）。AAB 路径见 §3.1；App Store 上传用 `xcrun altool`（官方 App Store 分发节）。
- 首次构建 Rust 依赖需数分钟（research #3 已述）。

---

## 推荐结论

1. **存储层**：按 §1.7 骨架实现 `storage-fs.ts`，`storage.ts` 按 UA 平台切换（fs 版 / store 版），capabilities 加 §1.5 四个权限项，Rust 侧注册 `tauri_plugin_fs::init()`。JSON 方案足够，不引 SQLite；每次 set 全量写盘 + per-file 写串行化即满足进度 250ms 防抖场景。
2. **图片 scheme**：iOS 直接复用现网 `mojuan-img://localhost/…`；Android 只需前端 `imgSrc`/`localSrc` 换 `http://mojuan-img.localhost/…` 形态，Rust 侧零改动。真机 spike 重点观测长滚动内存曲线（research #3 既定）。
3. **init 前置**：本机工具链已齐（Xcode 26.6 / Cocoapods / SDK+NDK / rustup targets / JAVA_HOME）；补 `export ANDROID_HOME=~/Library/Android/sdk` 后即可 `tauri android init` + `tauri ios init` 起步。gen/ 产物进 `.gitignore`。

---

## Sources

- Tauri 文档入口（必读）：https://tauri.app/llms.txt
- fs 插件官方页（平台表、API 概览、capabilities/scope、`$APPDATA` 变量、security 说明）：https://tauri.app/plugin/file-system/
- fs 前端 JS API 参考（readTextFile/writeTextFile/readDir/mkdir 签名、`MkdirOptions.recursive`、BaseDirectory 枚举）：https://v2.tauri.app/reference/javascript/fs/
- store 插件官方页（平台表、`load()`/`set()`/`save()`、autoSave debounce 100ms 描述）：https://tauri.app/plugin/store/
- 移动开发指南（Develop 页内联「Developing Your Mobile Application」：init/dev/build、`--open`、`TAURI_DEV_HOST`、Web Inspector、Xcode build phase 提示、图标路径）：https://v2.tauri.app/develop/
- 前置条件（「Configure for Mobile Targets」：Android SDK 组件/`JAVA_HOME`/`ANDROID_HOME`/`NDK_HOME`/rustup targets、iOS 完整 Xcode + Cocoapods）：https://v2.tauri.app/start/prerequisites/
- CLI 参考（`tauri android init|dev|build`、`tauri ios init|dev|build` 全部 option）：https://v2.tauri.app/reference/cli/
- docs.rs `Builder::register_uri_scheme_protocol`（自定义协议注册 + 「不同平台 Origin」官方原话）：https://docs.rs/tauri/latest/tauri/struct.Builder.html#method.register_uri_scheme_protocol
- 本机 cargo registry 源码（`~/.cargo/registry/src/rsproxy.cn-e3de039b2554c837/`）：
  - `tauri-2.11.5/src/app.rs`（`register_uri_scheme_protocol` doc：macOS/iOS/Linux 与 Windows/Android 的 URL 形态原话）
  - `wry-0.55.1/src/wkwebview/class/url_scheme_handler.rs`（iOS `WKURLSchemeHandler` ObjC 类）；`wry-0.55.1/src/android/kotlin/RustWebViewClient.kt`（Android `shouldInterceptRequest`）；`wry-0.55.1/src/custom_protocol_workaround.rs` + `src/android/mod.rs`（Android/WebView2 无自定义协议 API → `http://<scheme>.localhost/` workaround 与还原）
  - `tauri-plugin-fs-2.5.1/src/commands.rs`（`write_file_inner` 只 create 文件不建父目录）；`permissions/default.toml`、`create-app-specific-dirs.toml`、`read-app-specific-dirs-recursive.toml`、`scope.toml`、`autogenerated/commands/write_text_file.toml`（`fs:allow-write-text-file`）
  - `tauri-plugin-store-2.4.4/src/store.rs`（`resolve_store_path` → `BaseDirectory::AppData`；`auto_save` 默认 100ms；`set`→`trigger_auto_save`）
- 本机 `desktop/node_modules/@tauri-apps/plugin-store/dist-js/index.d.ts`（`IStore`：get/set/has/delete/clear/reset/entries/reload/save；`load(path, options)`）
- 本仓库代码：`desktop/src/lib/storage.ts`（`getStore(file)` = store `load(file)`，S3 seam）；`desktop/src-tauri/src/lib.rs`（`mojuan-img` 注册 + `parse_img_query`）；`desktop/src/lib/api.ts`（`imgSrc`/`localSrc` 拼 `mojuan-img://localhost/…`）；`desktop/src/screens/Reader.tsx`（滚动 250ms 防抖写 progress）；`desktop/src-tauri/capabilities/default.json`（现有权限）；`desktop/src/lib/storage.test.ts`（按 store 契约 mock 的测试 seam）
- 前序研究：`docs/research/tauri-mobile-maturity.md`（research #3：移动 GA、#7407、spike 建议）；`docs/research/desktop-webview-images.md`（research #4：自定义 scheme 平台机制、Windows/Android 的 `http://<scheme>.localhost/` 形态、WebP/AVIF/超长条图）
- tauri#7407（WKWebView 崩溃报告）：https://github.com/tauri-apps/tauri/issues/7407
