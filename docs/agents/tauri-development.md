# Tauri / 桌面开发约定

## 必读（处理任何 Tauri 任务前）

- Tauri 文档入口: <https://tauri.app/llms.txt> — **REQUIRED**。
- Tauri 插件（store/dialog/opener/fs 等）: <https://tauri.app/plugin/>
- Vite: <https://vite.dev/>

## 开发工作流

- 改前端（`desktop/src/`）：`npm run tauri dev` 热更新。
- 改 Rust 后端（`desktop/src-tauri/`）：改 Rust 触发后端重编，比前端慢。

## 图片加载（热链域必须走代理）

- 热链域（如 Webtoons pstatic.net）的图片走本机 HTTP 代理：`src-tauri/src/img_proxy.rs` 在
  127.0.0.1 上起 hyper 服务，端点 `/img`（`url` 走热链缓存取图，`path` 走本地文件）；Rust 侧
  补 Referer 并复用磁盘缓存与内存 LRU（`mojuan_core::cache::fetch_image`）。
- 前端把这类图片的 `src` 重写成 `http://127.0.0.1:<port>/img?url=…&ref=…`（`api.ts` 的
  `imgSrc`，端口经 `img_proxy_port` 命令取）。哪些域名属于热链域由源注册表声明，见
  `docs/agents/frontend.md` 的「源清单与按源事实」。
- 其余域 `<img>` 直连，吃 webview HTTP 缓存。
- 原因：macOS/Linux 无法给 `<img>` 注入 Referer，只能走代理。各平台给 `<img>` 注入请求头的
  能力与早期自定义 scheme 方案的取舍见 `docs/research/desktop-webview-images.md`；后来改成
  本机 HTTP 代理的原因（自定义 scheme 撞上 wry `shouldInterceptRequest` 的 30s 响应上限）见
  `docs/research/mobile-storage-webview.md` 的结论一节。

## 隐藏 webview 渲染通道（Cloudflare / 自建验证防护源）

哪些源走这条通道、判据脚本（`STATE_SCRIPT` / `HTML_SCRIPT` / `is_clean` / `is_denied`）与轮询节奏
在 mojuan-core 侧怎么定义，见 `docs/agents/mojuan-core.md` 的「渲染源」一节。这里只记宿主侧：

- 桌面端：`src-tauri/src/render.rs`，单例不可见窗口（label `render`）+ Rust 侧轮询；远程页面
  零 IPC 权限（capability 不覆盖 render 窗口），HTML 经宿主侧 `eval_with_callback` 取回。
- 移动端：`crates/tauri-plugin-mojuan-render/`（自建 tauri 插件，Kotlin `WebView` / Swift `WKWebView`
  离屏加载）。状态脚本 / 取 HTML 脚本 / 轮询间隔 / 整体超时随请求下发，原生侧只做「加载 → 轮询 →
  连续两次干净 → 取 HTML」，不含任何站点选择器。
- 布局细节、验证页识别、移动端离屏 webview 的取舍与维护注意见 `docs/research/webview-render-channel.md`。

## 自动更新通道（`updater/`）

- 桌面端用官方 tauri-plugin-updater；`plugins.updater.endpoints` 指向
  `https://mojuan.fengw.site/latest.json`，服务是 `updater/` 里的 Cloudflare Worker。
- 清单与制品都由 `updater/` 的 Cloudflare Worker 取回后对外提供：tauri-action 写进清单的制品
  地址是 GitHub 的 API 资产地址（`api.github.com/repos/.../releases/assets/<id>`），普通 GET 取回
  的是资产元数据而不是文件，所以 Worker 换成自己的 `/dl` 路径、带上正确的请求头取回；只提供
  GitHub 判定的「最新已发布版本」。`release.yml` 直接发布（`releaseDraft: false`），workflow
  跑完即开始推送。
- `*.workers.dev` 在本机所在网络连不上（实测 443 超时，而 Cloudflare 边缘 IP 与
  github.com 都通），所以 Worker 挂在自有域名的子域下，与 `blog.fengw.site` 同一做法。
- 改了 `updater/src/` 或 `updater/wrangler.toml` 要 `cd updater && npx wrangler deploy`；
  密钥、发布开关与撤掉步骤见 `updater/README.md`。

## Android OTA（应用内升级）

官方 `tauri-plugin-updater` 在移动端是空实现（`package.metadata.platforms.support.android
= "none"`，`install_inner` 直接返回 `Ok(())`），所以 Android 另走一条：

- 分层：清单拉取 / 版本比对（semver）/ 下载 / sha256 校验在 mojuan-core 的 `native/ota.rs`
  （与平台无关、可单测）；状态机与命令在 `src-tauri/src/ota.rs`（`ota_check` /
  `ota_download` / `ota_install` / `ota_can_install` / `ota_open_install_settings`，只在
  移动端编译并注册，见 `lib.rs` 的 `#[cfg(mobile)]`）；安装是自建插件
  `crates/tauri-plugin-mojuan-update/`（Android Kotlin `PackageInstaller`，iOS Swift 三个
  命令都回「不支持」）。
- 通道地址在 `tauri.conf.json` 的 `plugins.mojuan-update.endpoint`，与桌面端的
  `plugins.updater.endpoints` 并列；Rust 侧经 `app.config().plugins` 读原始 JSON，不走
  插件的 `getConfig`。
- **签名是这条路的前提**：Android 只允许同签名的包覆盖安装，CI 用 secret
  `ANDROID_KEYSTORE_BASE64` 里的固定密钥签名（`release.yml` 的 sign APK 步骤）。客户端
  在交出去之前用 `getPackageArchiveInfo(..., GET_SIGNING_CERTIFICATES)` 比一次签名，
  不一致直接报「需要先卸载再安装」，不让用户走完系统安装器再看一句看不懂的失败。
- 权限与接收器声明在**插件模块的** `android/src/main/AndroidManifest.xml` 里
  （`REQUEST_INSTALL_PACKAGES` + `InstallResultReceiver`）：Gradle 合并进应用 manifest，
  而 `gen/android` 每次 `tauri android init` 都会重建，写在那里会丢。
- 安装会话的状态经 `PendingIntent` 广播回来，所以接收器要写进 manifest，并由插件模块的
  `consumer-rules.pro` 保留（类名只出现在 manifest 与 Intent 里，R8 看不到静态引用）；
  `@TauriPlugin` / `@InvokeArg` 类仍由 tauri-android 的 consumer rules 保留。
- 建会话要把整个 APK 拷进安装器存储（几十兆），这一步放后台线程；`startActivity` 拉起
  安装确认界面与 `invoke` 结算回主线程。
- 本机验证 Android 目标的编译用 `scripts/check-android.sh`（宿主 `cargo check` 看不到
  `#[cfg(mobile)]` 的代码，`ota.rs` 与插件的 `mobile.rs` 都在其中；CI 的 `cargo test`
  同样覆盖不到，release.yml 的 build-android 作业才是这道门槛）。

### 端到端验证（模拟器，不需要真机与线上通道）

整条链路在模拟器上跑通过（API 37 arm64），做法如下：

1. 起模拟器（现成的 AVD 是 `cimoc-ota`；`emulator` 不在 PATH 上时用绝对路径
   `~/Library/Android/sdk/emulator/emulator`）：`emulator -avd cimoc-ota -no-window -gpu
   swiftshader_indirect`，关掉安装校验与动画：`settings put global package_verifier_enable 0`、
   `verifier_verify_adb_installs 0`。
2. 在主机上用一个静态 HTTP 服务当更新通道，目录里放 `android.json` 与 APK。**`url` 要写
   绝对地址**——真实通道里这一步是 Worker 把清单里的文件名改写成自己的 `/dl` 路径，客户端
   只接受完整 URL。
3. `adb reverse tcp:<端口> tcp:<端口>`：设备侧的 127.0.0.1 指向主机的这个服务（构建时的
   `--config` 把 endpoint 指到 `http://127.0.0.1:<端口>/android.json`）。
4. 构建时用 `--config` 覆盖 `plugins.mojuan-update.endpoint` 与 `version`，**不改任何源码**：
   `npx tauri android build --apk --debug --target aarch64 --config override.json`。
5. `adb install` 旧版本（调试包）；再构建新版本的**发布包**并用同一个密钥签名
   （`apksigner sign --ks ~/.android/debug.keystore --ks-key-alias androiddebugkey`），
   放进通道目录。调试包有 240 MB 上下，下载会顶到探针超时，发布包只有 20 MB 左右。
6. 驱动：`adb forward tcp:<主机口> tcp:9223`（注意方向：桥是**设备端**服务，用 forward；
   本地通道是**主机端**服务，用 reverse），再用 `desktop/scripts/probe-app.mjs` 调 `ota_*`
   命令；界面路径直接在设置页点「检查新版本 → 下载 → 安装」。
7. 系统确认界面用 `adb shell uiautomator dump` 取结构化文本找按钮（不要截图）；
   `adb shell dumpsys package io.github.fw6.mojuan | grep versionName` 核对版本是否变化。

模拟器带 Play 商店时，安装前会弹 Play Protect 的「扫描应用」，挡住系统确认界面；
`adb shell pm disable-user --user 0 com.android.vending` 关掉它即可（验完 `pm enable` 还原）。

## 窗口外壳（窗口材质 / 透明 titlebar）

窗口的透明与材质按平台分开配：`tauri.conf.json` 里那份窗口定义是不带材质的兜底（Linux、Android、
iOS 用它），材质写在平台配置里。

- `tauri.macos.conf.json`：`titleBarStyle: "Overlay"` + `transparent: true` +
  `windowEffects.effects: ["sidebar"]`（vibrancy，状态 `followsWindowActiveState`）。
- `tauri.windows.conf.json`：`transparent: true` + `windowEffects.effects: ["acrylic"]`。

`app.macOSPrivateApi: true` 必须写在**基座**配置里：macOS 上的 `transparent` 要求
`macos-private-api` 这个 cargo feature，而它是构建脚本按配置里这个字段打开的
（tauri-utils 的 `AppConfig::features()`），写在平台配置里构建脚本读不到。tauri CLI 会顺带把
`features = ["macos-private-api"]` 写进 `src-tauri/Cargo.toml`（跑一次 `tauri dev` 就会出现），
两边同时在是正常状态。该 feature 只是打开 `wry/transparent` 与 `wry/fullscreen`，这两个都是空
feature 且只在 `wkwebview`（macOS）里用到，在别的平台上不产生代码。

前端配合：`index.html` 在首帧之前把平台写到 `html[data-chrome]`（macos / windows / none），
`src/styles/beui.css` 的 `data-chrome` 段据此让 `--sidebar` 与 `body` 透明，`src/lib/chrome.ts`
给组件读这个标记。谁透明谁实底、材质怎么跟随主题，见 `DESIGN.md` 的「窗口材质」。

## 应用名（productName）

基座 `tauri.conf.json` 的 `productName` 是 `mojuan`，macOS / Android / iOS 的平台配置各自覆盖成 `墨卷`（`tauri.macos.conf.json` / `tauri.android.conf.json` / `tauri.ios.conf.json`，平台文件按 JSON Merge Patch 合进基座，标量直接覆盖）。三个落点：

- macOS：`CFBundleDisplayName` / `CFBundleName`（bundle 名、Dock、访达、「关于」）与菜单栏最左侧那条应用菜单——tauri 的默认菜单标题取 `PackageInfo.name`，它由构建脚本按**已合并**的配置生成，所以平台覆盖对 `cargo build` 也生效，不必只在打包时才有。
- Android：`res/values/strings.xml` 的 `app_name` / `main_activity_title`，由 `tauri android init` 现生成（`gen/` 不入库，改了 productName 要删掉 `gen/android` 重新 init）。
- iOS：`gen/apple/project.yml` 的 `PRODUCT_NAME`（`CFBundleName` 取它），Xcode 工程名与 target 名仍用 Cargo 包名，保持 ASCII。

Windows 与 Linux 用基座的 `mojuan`：deb / rpm 的包名直接取 productName（tauri-bundler 走 `heck::AsKebabCase`），非 ASCII 会被 dpkg 判为非法包名；Windows 的 MSI 显示名走安装包代码页，中文有乱码风险。

`tauri dev` 里 Dock 图标下方那行字取自**可执行文件**（未打包的进程在 LaunchServices 里就是文件名），所以 `src-tauri` 的 Cargo 包名是 `mojuan`，不是脚手架留下的 `desktop`；菜单栏那条仍是 productName（`mojuan`）。

## 坑（Gotchas）

1. **Tauri 同步命令在主线程执行**：阻塞式 reqwest 必须放 async 命令 + `tauri::async_runtime::spawn_blocking`，否则冻结 UI。
2. **本机图片代理的端口是启动时分配的**：代理在 127.0.0.1 上绑随机端口，前端必须在渲染任何
   图片之前经 `img_proxy_port` 命令取回（`main.tsx` 的 `bootstrap` 里 `initImgProxy`）。没取到时
   `imgSrc` 原样返回地址，热链域的图会直连并失败。
3. **`withGlobalTauri` 必须放 `tauri.conf.json` 的 `app` 段**（不在 `security` 段；`app.withGlobalTauri: true`）。
4. **`on_page_load` 事件在 macOS 跨站重定向时会丢失**（纯 302 链一条 Finished 都不发）：页面就绪
   判定不要用它，改用 `eval_with_callback` 轮询 `location.href` + `readyState`（渲染通道的做法）。
5. **隐藏 webview 必须在主线程创建**：`run_on_main_thread` 调度后同步等结果（`render.rs::ensure_webview`）。
6. **隐藏渲染窗口会让「关掉全部窗口即退出」失效**：主窗口销毁时连带 destroy 渲染窗口
   （`lib.rs` 的 `on_window_event`）。
7. **移动端插件的原生工程由构建脚本接入**：插件 `build.rs` 里 `tauri_plugin::Builder::new(&[..])
   .android_path("android").ios_path("ios")` 就够了——app 的 `tauri-build` 会把插件写进
   `gen/android/tauri.settings.gradle` 与 `app/tauri.build.gradle.kts`（iOS 侧经
   `link_apple_library` 链进 Xcode 工程）。Android 类名不必叫 `app.tauri.*`：release 混淆下靠
   tauri-android 的 consumer rules（`-keep @TauriPlugin` / `-keep @InvokeArg`）保留。
8. **移动端原生命令可能不在主线程**：Android 的 `@Command` 与 iOS 的插件调度都不保证主线程
   （iOS 在 tauri 的 ipc 队列上），创建/操作 WebView 一律先切主线程（渲染插件用
   `Handler(Looper.getMainLooper())` / `DispatchQueue.main.async`）。
9. **Xcode 27 上构建 iOS 目前走不通（上游 swift-rs 的坑）**：Xcode 27 的 SwiftPM 会把静态产物里的
   `@_cdecl` 符号内化成局部符号，链接 Rust 侧时报 undefined symbols（`_register_plugin`、
   `_init_plugin_*`、`_retain_object` …，与具体插件无关）。swift-rs 1.0.8 起用
   `llvm-objcopy --globalize-symbol` 修补，但它 ① 需要 `rustc` 在 Xcode 脚本阶段的 PATH 上
   （脚本阶段看不到 `~/.cargo/bin`，本机做法：`ln -s ~/.cargo/bin/rustc node_modules/.bin/rustc`
   并已装 `rustup component add llvm-tools`），② 只修补包自己的目标文件成员，跳过内嵌的
   `SwiftRs.o`，所以 `_retain_object` / `_release_object` / `_string_from_bytes` 仍缺。CI 的
   Xcode 26 不受影响；另外工程部署目标 14.0 低于 Xcode 27 支持的 15.0，用 27 时需在
   `tauri.conf.json` 的 `bundle > iOS > minimumSystemVersion` 抬高（或 `ios init` 后改
   `gen/apple/project.yml`）。
10. **自建插件的配置类型必须声明，否则应用启动即 panic**：`tauri::plugin::Builder::new(name)`
    的配置类型默认是 `()`，而 tauri 在插件初始化时会按这个类型反序列化 `tauri.conf.json` 的
    `plugins.<name>` 段——只要那里放了一个对象，启动时就报
    `PluginInitialization(.. invalid type: map, expected unit)` 并直接 abort。要么用
    `Builder::<R, Config>::new(name)` 声明配置类型（`Config` 的字段加 `#[serde(default)]`），
    要么别在 `plugins` 下给它写配置。`cargo check` 与 `cargo test` 都发现不了，只有把应用跑起来
    才会暴露；`crates/tauri-plugin-mojuan-update/src/lib.rs` 里有一个读真实 `tauri.conf.json`
    的测试，专门盯这条。
11. **`core:default` 不含改窗口状态的命令**：`core:window:default` 只覆盖读取类（`is_fullscreen`、
    `inner_size`、`title` 等），写入类要逐个列进 `src-tauri/capabilities/default.json`。阅读器的
    全屏按钮走 `getCurrentWindow().setFullscreen()`，缺 `core:window:allow-set-fullscreen` 时
    前端只收到 `window.set_fullscreen not allowed`，按钮点了没有任何反应，错误也只在 webview
    控制台里出现。
12. **平台配置是 JSON Merge Patch，数组整体替换**：`tauri.macos.conf.json` 与
    `tauri.windows.conf.json` 里的 `app.windows` 会整段换掉基座里的那份（tauri-utils 用
    `json_patch::merge`），所以平台文件要把 `title` / `width` / `height` 一起写全；改窗口尺寸是
    三处一起改。漏改的表现是某个平台上窗口尺寸悄悄停在旧值。
13. **`windowEffects` 只在 macOS 与 Windows 有实现**：tauri 的 `vibrancy` 模块只有 `macos.rs` 与
    `windows.rs`，别的平台上 `set_window_effects` 什么都不做；而效果要求窗口 `transparent: true`，
    所以在没有实现的平台开透明，等于把窗口背景直接交给桌面（露出未模糊的桌面）。效果失败的报错
    也被吞掉（`apply_effects` 返回 `()`），只有跑起来才看得出来。
14. **`titleBarStyle: "Overlay"` 才会让 webview 铺满整窗**：默认的 `Visible` 同样是
    `fullsizeContentView`，但 webview 仍让出 32px 给标题栏（`innerHeight` 比窗口高度少 32），
    实测方式是对比 `getCurrentWindow().innerSize()` 与 `window.innerHeight`。Overlay 之后红黄绿浮在
    界面左上角，侧边栏顶部要让位（`shell.tsx` 的 `pt-9.5`）；代价是 Overlay 下未获得焦点的窗口
    拖不动（<https://github.com/tauri-apps/tauri/issues/4316>）。
15. **系统材质按窗口外观取明暗，不跟 `html[data-theme]`**：应用自己的深浅色设置改了窗口外观
    不会跟着变，要显式 `getCurrentWindow().setTheme(...)`（权限
    `core:window:allow-set-theme`），否则深色界面会配上一块浅色材质。
16. **`Overlay` 既不隐藏标题，也不给拖拽区**：tao 的 `titlebar_transparent` 与 `title_hidden`
    是两个开关，tauri 的 `TitleBarStyle::Overlay` 只设前者，所以窗口标题照旧画在红黄绿旁边——
    要在平台配置里写 `"hiddenTitle": true`（`WindowConfig` 是
    `rename_all = "camelCase", deny_unknown_fields`，键名写错启动就报错；`gen/schemas` 里
    没有这个键，别拿那份 schema 当依据）。拖拽同理：Overlay 之后 webview 铺满整窗，系统标题栏
    的拖拽没了，界面要自己铺一条 `data-tauri-drag-region`（`shell.tsx` 里整窗宽 28px 的那条），
    并给 `core:window:allow-start-dragging` 权限（`core:window:default` 里没有）。注意这个属性
    **只作用在挂它的元素上**，子元素要各自挂；红黄绿是原生按钮、在 webview 之上，压在拖拽条上
    仍然点得到。
