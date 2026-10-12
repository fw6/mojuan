# rquickjs 嵌入调研：把漫画源解析迁到运行时 JS 脚本（wayfinder #11）

> **路径说明**（2026-10-12 布局改动）：本文里的 `desktop/` 现为 `apps/mojuan/`，`desktop/crates/` 现为 `crates/`，`updater/` 现为 `apps/updater/`，`npm`/`npx` 换成 `pnpm`。

调研对象：rquickjs **0.12.2**（2026-07-27 发布，crates.io 最新稳定版；截至 2026-08-15）。绑定引擎为 **QuickJS-NG**（quickjs-ng.github.io/quickjs，bellard/quickjs 的 fork），由 rquickjs-sys 内置并打补丁（栈溢出检查、原子 `JS_NewClassID`、Infinity 处理等）。MSRV 为 Rust 1.87（Cargo.toml 声明）。API 事实均取自 docs.rs `rquickjs` / `rquickjs-core` 0.12.2 文档页、GitHub DelSkayn/rquickjs README、rquickjs 0.12.2 crate 源码，见文末 Sources。

## 结论与推荐（TL;DR）

**推荐：在 mojuan-core 加一个 JS 执行层，走「JSON 字符串中转」协议，每源一个 (Runtime + Context)（每调用新建也够用），在现有 `spawn_blocking` 线程里同步调用。**

1. **features 用默认 `std` 就够**。解析场景是「eval 脚本 → 调函数 → 返回 JSON 字符串」，不需要 `futures`（不直接 async 调用）、不需要 `macro`（不用 derive）、不需要 `loader`（脚本不用 `import/export`）。别开 `rust-alloc`——它会令 `set_memory_limit` 失效（custom allocator 下是 no-op）。
2. **Runtime/Context 创建是微秒级**（QuickJS README：runtime 实例完整生命周期 < 300 微秒）。网络为主、单次调用几百 ms 起的爬虫负载下，每调用新建都是可接受的；要省掉每次脚本解析，可以预热（每源建好后 eval 脚本一次，函数存 globals 复用）。
3. **调用形状**：延续现有 `tauri::async_runtime::spawn_blocking`（`src-tauri/src/lib.rs` 已如此），blocking 线程内用同步 `Runtime`/`Context`，不需要 `AsyncRuntime`。入参 HTML/JSON 以 `&str` 传入，脚本 `JSON.stringify(...)` 返回 JSON 字符串，Rust 侧 `serde_json::from_str` 解析——与现有 `crawl(op, source, payload) -> String` 协议完全对齐。
4. **资源限制**：超时用 `Runtime::set_interrupt_handler`（引擎定期调闭包，返回 `true` 抛不可捕获异常交还控制流）；内存用 `Runtime::set_memory_limit`（默认 std 下生效）；栈默认 256 KiB 可调；脚本体积上限 Rust 侧自己按字节检查。
5. **错误处理**：脚本 throw / 语法错误 → `Error::Exception`，用 `CatchResultExt::catch()` 转成 `CaughtError`，Error 实例直接 `.message()` / `.stack()`；类型/参数错误是 `Error::FromJs` / `Error::MissingArgs` 等具名变体。
6. **隔离**：每源一个独立 Runtime 最干净——内存上限与 interrupt handler 都是 runtime 级配置，独立 runtime 才能按源设限、互相不拖累；同 Runtime 多 Context 共享堆，隔离弱。

---

## 1. 版本与 features 选择

### 版本

| 项 | 值 | 来源 |
|---|---|---|
| rquickjs | **0.12.2**（2026-07-27 发布，未 yanked） | crates.io API `/api/v1/crates/rquickjs` |
| 绑定引擎 | QuickJS-NG（quickjs-ng fork），rquickjs-sys 内置 C 源码 + 补丁 | rquickjs README、rquickjs-sys README |
| MSRV | Rust 1.87 | rquickjs 0.12.2 Cargo.toml |
| 平台绑定 | macOS/Windows/Linux 桌面平台随 crate 预生成绑定，无需 `bindgen` feature | rquickjs README「Supported platforms」 |

### features（0.12.2，自 Cargo.toml / crates.io API）

```
default      = ["std"]
full         = ["std", "chrono", "loader", "dyn-load", "either", "indexmap", "macro", "phf"]
full-async   = ["full", "futures"]
```

逐一与本场景的对应关系：

| feature | 本场景需要？ | 说明 |
|---|---|---|
| `std`（默认） | **需要（默认即开）** | 唯一默认项；`Ctx::eval_file_*`、`EvalOptions.filename`、`Error::Io` 等在此之下 |
| `futures` | 不需要 | 提供 `AsyncRuntime`/`AsyncContext`（future-aware 锁）。我们走 `spawn_blocking` 同步调用，不需要 |
| `macro` | 不需要 | 提供 `#[derive(IntoJs/FromJs)]` 等过程宏。走 JSON 字符串中转时用不到 |
| `loader` | 可选 | 自定义 ES module resolver/loader。只有脚本要用 `import/export`（ESM）才需要 |
| `chrono` / `either` / `indexmap` / `phf` / `dyn-load` | 不需要 | 额外类型转换 / 原生模块加载 |
| `rust-alloc` | **不要开** | 用 Rust 全局分配器取代默认 libc 分配器；**开了之后 `set_memory_limit` 变 no-op**（见 §4） |

> 结论：`rquickjs = "0.12.2"` 直接用默认 features 即可。若后续源脚本想用 ESM 语法再加 `loader`。

---

## 2. Context/isolate 组织、创建成本、预热与复用

### 概念（docs.rs rquickjs 首页「The Runtime and Context objects」）

- **`Runtime`**：解释器状态（堆、GC、内存限制、interrupt handler、promise jobs）。QuickJS 不支持多线程，Runtime 内部被 mutex 锁住；同一 Runtime 同时只能跑一个脚本/建一个对象。`Runtime` 为 `!Send`/`!Sync`（Context 同理），须留在创建它的线程。
- **`Context`**：一个执行环境（自己的 global 对象与栈）。**同一 Runtime 的多个 Context 可互相共享 JS 对象**（类比浏览器同源 frame）。`Context` 可 `Clone`。
- 文档明确建议：Runtime/Context 使用锁，**在 async 环境不推荐直接用**，需 `futures` feature 的 `AsyncRuntime`/`AsyncContext`。

### Context 创建方式（0.12.2，`rquickjs_core::context::Context`）

```rust
Context::base(&runtime)     // 只注册必需函数的最小环境
Context::custom(&runtime)   // 注册必需 intrinsics
Context::full(&runtime)     // 注册全部标准 intrinsics（含 JSON、Math 等）—— 解析场景用这个
Context::builder()          // ContextBuilder，自定义 intrinsics 集合
```

拿到 Ctx 的唯一入口是 `context.with(|ctx| ...)`：回调期间锁住 runtime 一次，回调返回即释放。

### 创建成本与预热

- **成本极低**：QuickJS README 明确「The complete life cycle of a runtime instance completes in **less than 300 microseconds**」（rquickjs README 引述）。
- 所以「每调用新建 Runtime+Context」成立。真正按调用重复的只有**脚本解析/编译**（eval 一次脚本定义函数）。
- **预热/复用形态**（按复杂度递增）：
  1. **每调用新建**：`Runtime::new()` + `Context::full()` + eval 脚本 + 调函数。无共享状态、无并发问题，最简。脚本编译成本（几十 KB 脚本约 1ms 级）相对 HTTP 延迟（100ms~2s）可忽略。
  2. **每源一个 warm (Runtime, Context)**：源加载时建好并 eval 脚本一次，函数对象留在 globals；每次调用 `ctx.globals().get::<_, Function>("parseList")` 复用。因 Runtime 是 `!Send`，池需绑定线程（`thread_local` 或每线程一个）。中断/内存是 per-runtime 设置，每次调用前刷新 deadline。
  3. **编译期字节码**：`embed!` 宏把编译期已知的 JS 打成字节码打进二进制（仅适用于脚本不在运行时变化的情形；运行时加载的脚本用不上）。

### 每源一个 Context vs 共享 Context

| 方案 | 隔离 | 内存/中断限制 | 成本 |
|---|---|---|---|
| **每源一个 (Runtime, Context)**（推荐） | 强：每源独立堆、独立 global、GC 独立 | 每源可单独设内存上限与 interrupt handler，一个源死循环/爆内存不拖累其它源 | Runtime 创建微秒级，可忽略 |
| 共享一个 Runtime + 每源一个 Context | 弱：同 Runtime 共享堆；**内存限制与 interrupt handler 是 runtime 级**，设不了每源 | 共享；一个源的资源消耗影响全部 | 略省一次 Runtime 创建（无意义） |
| 每调用一个 (Runtime, Context) | 最强（连脚本状态都不跨调用） | 每次现设 | 每次多付脚本编译（可接受） |

> 推荐 **每源一个 (Runtime, Context)**：与「源是运行时加载的脚本」的产品决策匹配，隔离最干净，同时每次调用能复用已编译的函数。先以最简单的「每调用新建」落地，需要时再升级为 warm 池。

---

## 3. 调用形状：Rust async（tokio）侧怎么同步调 JS

### 现状接线（决定调用形状的事实）

`src-tauri/src/lib.rs` 的 crawl 命令已经是阻塞式的标准处理：

```rust
async fn crawl(op: String, source: String, payload: String) -> String {
    tauri::async_runtime::spawn_blocking(move || mojuan_core::crawl(&op, &source, &payload))
}
```

解析器（webtoons.rs / mangadex.rs）在 **blocking 线程里同步执行**，内部用 `reqwest::blocking` 抓 HTML/JSON（`crawler/http.rs`）。JS 执行直接放进同一阻塞闭包即可——这正是 rquickjs 文档推荐的用法（async 环境直接用锁住的 Runtime/Context 被明确「discouraged」）。

### 两条可选路径

1. **`spawn_blocking` + 同步 `Runtime`/`Context`（推荐，与现状一致）**：不需要 `futures` feature。JS 调用全程阻塞当前 blocking 线程，语义与现有 `reqwest::blocking` 一致。
2. **`futures` feature + `AsyncRuntime`/`AsyncContext`**：future-aware 锁，可 `await` JS Promise、可在异步上下文直接持有。只有当解析函数本身要变 async（例如脚本内部 await 网络）才需要考虑——按产品决策「网络全在 Rust 层」，不需要。

### 函数调用形状（0.12.2，`rquickjs_core::function::Function`）

```rust
let f: Function = ctx.globals().get("parseList")?;   // Object::get，V: FromJs
let out: String = f.call((html,))?;                  // A: IntoArgs（元组），R: FromJs
```

- `ctx.eval::<V, S>(source)` 把脚本作为 global code 求值，`V: FromJs`、`S: Into<Vec<u8>>`。脚本只声明函数时不返回值，用 `ctx.eval::<(), _>(script)`。
- `Function::call<A, R>(args)`，`A: IntoArgs<'js>`（元组/Args 对象）、`R: FromJs<'js>`；另有 `call_arg` 接 `Args` 对象。
- 还有 `EvalOptions`（`ctx.eval_with_options`）：`global`、`strict`（强制 strict mode）、`backtrace_barrier`、`promise`（顶层 await）、`filename`（std）。解析脚本建议开 `strict` 防 sloppy-mode 隐患。

### 跨边界传值：类型化 vs JSON 字符串

rquickjs 的转换体系（docs.rs「Converting Values」）：

- **`IntoJs`**（Rust → JS）与 **`FromJs`**（JS → Rust），附带 `Coerced<T>` 做宽松类型转换；`String`/`&str`/数字/bool/`Vec`/`Option` 等均有实现。
- **`#[derive(IntoJs)]` / `#[derive(FromJs)]`** 存在，但属于 `macro` feature，且只支持 plain-data struct。
- **rquickjs-core 0.12.2 没有 serde 支持**（features 无 `serde-json`，也没有 `serde_json::Value` 的 IntoJs/FromJs 实现）。要做 `Value <-> serde` 需社区 crate [rquickjs-serde](https://github.com/rquickjs/rquickjs-serde)。

因此跨边界有两条路线：

| | 类型化（IntoJs/FromJs） | **JSON 字符串中转（推荐）** |
|---|---|---|
| 入参 | 按类型逐字段传（`(html, opts)`） | 整个 HTML/JSON 以 `&str` 传一个参数 |
| 返回 | JS 对象 → Rust struct（需手写/derive FromJs） | 脚本 `JSON.stringify(result)` 返回字符串，Rust `serde_json::from_str` |
| 依赖 | `macro` feature；或引入 rquickjs-serde | 零新增依赖（serde_json 已用） |
| 协议一致性 | 与现有 `crawl() -> String` 不一致 | **与现有 JSON 字符串协议完全一致**，前端/模型层零改动 |
| 缺点 | 脚本要产出结构化对象，Rust 侧反向映射，改动面大 | 每次多一次 stringify/parse（微秒级，相对 HTTP 延迟可忽略） |

> 结论：**入参给 JS 字符串、出参收 JSON 字符串**。脚本只需 `return JSON.stringify({...})`，Rust 侧 `serde_json::Value` 解析后继续走现有 models（Comic/Chapter 的 camelCase 序列化）不变。

---

## 4. 资源限制：超时 / 内存 / 脚本体积

全部是 `Runtime` 级 API（docs.rs `rquickjs_core::runtime::Runtime`）。**注意：Runtime 池化复用时，这些是 per-runtime 设置，每次调用前要重置**（尤其 deadline）。

### 执行时间 / 超时 / 中断

```rust
// InterruptHandler = Box<dyn FnMut() -> bool + 'static>
runtime.set_interrupt_handler(Some(Box::new(move || Instant::now() > deadline)));
```

- 文档原话：闭包**由引擎在执行代码时定期调用**；返回 `true` 时解释器**抛出一个不可捕获的异常**并把控制权交还给调用者。
- 含义：JS 侧 `try/catch` 拦不住中断；`eval`/`call` 以 `Err` 返回，Rust 侧得到控制权。
- 超时实现即「闭包对比当前时间与 deadline」。闭包需 `'static`，简单形态直接捕获一个 `Instant`；池化复用时改用共享 `AtomicU64`/`Mutex<Instant>`，每次调用前刷新。
- 清空用 `set_interrupt_handler(None)`。

### 内存限制

```rust
runtime.set_memory_limit(64 * 1024 * 1024); // 0 表示不限
```

- 文档原话：设定 runtime 最大内存；**设为 0 等价于不限**。
- **关键坑（文档明示）**：使用自定义分配器时是 **no-op**——`rust-alloc` 或 `allocator` feature 下 `set_memory_limit` 不生效。默认 `std`（libc 分配器）下生效。所以为了内存上限，**不要开 `rust-alloc`**。
- 超限时返回 `Error::Allocation`（「Could not allocate memory」）。
- 配套观测/控制：`set_gc_threshold(usize)`（GC 触发阈值）、`run_gc()`（手动 GC，QuickJS 大多引用计数自动释放）、`memory_usage() -> MemoryUsage`（内存统计）。

### 栈限制

```rust
runtime.set_max_stack_size(512 * 1024); // 默认 256*1024 字节（256 KiB）
```

### 脚本体积上限

- QuickJS/rquickjs **没有内置脚本长度上限**，需要在 Rust 侧加载时自检（如 `script.len() > MAX` 拒绝）。内存上限、栈上限与中断是执行期的兜底。

---

## 5. 错误处理：throw / 语法错误 / 类型错误 / 超时

### 错误类型总览（`rquickjs_core::Error`，`#[non_exhaustive]`，0.12.2 共 22 个变体）

与解析场景直接相关的：

- `Error::Exception` —— QuickJS 抛出的 JS 异常；具体值经 `Ctx::catch()` 取回。**脚本 throw、语法错误都落在这里**。
- `Error::FromJs { from, to, message }` / `Error::IntoJs { from, to, message }` —— 跨边界类型转换失败（Rust 侧把返回值转成 `String` 失败、或参数转 JS 失败）。
- `Error::MissingArgs { expected, given }` / `Error::TooManyArgs { expected, given }` —— 参数个数不符。
- `Error::Allocation` —— 内存上限触发 / OOM。
- `Error::Unknown` —— QuickJS 未细分的错误。
- 其余与模块/类/用户数据相关（`Loading`/`Resolving` 需 `loader`、`InvalidClass`、`WouldBlock` 等）。

### 拿「错误信息 + 堆栈」

```rust
use rquickjs::{CatchResultExt, CaughtError};

match f.call::<_, String>((html,)).catch() {          // Result<R, Error> -> Result<R, CaughtError>
    Ok(json) => Ok(json),
    Err(CaughtError::Exception(e)) => {              // 是 Error 实例（含 SyntaxError）
        let msg = e.message();                        // Option<String>，同 JS error.message
        let stack = e.stack();                        // Option<String>，同 JS error.stack
        ...
    }
    Err(CaughtError::Value(v)) => { /* 非 Error 的 throw，如 throw 3，v 即抛出的值 */ }
}
```

- `CaughtError` 两个变体（docs.rs `rquickjs_core::CaughtError`）：`Exception(Exception<'js>)`（是 Error 实例）与 `Value(Value<'js>)`（不是 Error 实例的裸 throw）。
- `Exception` 提供 `message() -> Option<String>` 与 `stack() -> Option<String>`（分别等价 JS `error.message` / `error.stack`），并实现 `Display`。
- **语法错误**：`ctx.eval` 解析失败以 JS `SyntaxError` 实例的形式作为 `Error::Exception` 返回，经上面同样路径拿到 `message`/`stack`（含行号）。
- **类型错误**：不走 JS，是 Rust 侧转换失败，返回具名变体 `Error::FromJs`/`IntoJs`/`MissingArgs`/`TooManyArgs`，字段直接可读。
- **超时/中断**：不可捕获异常，`eval`/`call` 返回 `Err`，控制权回 Rust。中断后 runtime 状态无需恢复（推荐直接丢弃重建，成本微秒级）。
- Rust 侧主动抛错：`Exception::throw_syntax(ctx, msg)` / `throw_type` / `throw_message` 返回 `Error`（`rquickjs_core::Exception` 关联函数）。

---

## 6. 最小可运行代码形状

以下为在内存里创建 runtime/context、eval 一个 JS 函数、传入 HTML 字符串、拿回 JSON 字符串的最小形态（`Cargo.toml`：`rquickjs = "0.12.2"`，默认 features）：

```rust
use rquickjs::{CatchResultExt, CaughtError, Context, Function, Runtime};
use std::time::{Duration, Instant};

const SCRIPT: &str = r#"
    // 源脚本：只做解析。输入 HTML 字符串，输出 JSON 字符串。
    // 真实脚本在此用正则/DOM 解析出结构化数据，最后 JSON.stringify。
    function parseList(html) {
        const m = html.match(/<title>([\s\S]*?)<\/title>/);
        return JSON.stringify({ title: m ? m[1].trim() : "", ok: true });
    }
"#;

/// 传 HTML 字符串，拿回 JSON 字符串。失败返回 (类别, 信息, 可选堆栈)。
fn run_parse(html: &str, timeout: Duration) -> Result<String, String> {
    // 1) 创建 runtime + context（微秒级；池化/预热后这里只取现成的）
    let runtime = Runtime::new().map_err(|e| e.to_string())?;
    runtime.set_interrupt_handler(Some(Box::new({
        let deadline = Instant::now() + timeout; // 池化复用时改共享 deadline，每次调用前刷新
        move || Instant::now() > deadline
    })));
    runtime.set_memory_limit(64 * 1024 * 1024); // 默认 std 下生效；勿开 rust-alloc
    runtime.set_max_stack_size(512 * 1024);

    let context = Context::full(&runtime).map_err(|e| e.to_string())?;
    context.with(|ctx| {
        // 2) 加载脚本（一次；warm 后此步省略，函数留存在 globals）
        ctx.eval::<(), _>(SCRIPT).map_err(|e| e.to_string())?;

        // 3) 取出函数并调用：入参 &str -> JS string，出参 JS string -> Rust String
        let f: Function = ctx.globals().get("parseList").map_err(|e| e.to_string())?;
        match f.call::<_, String>((html,)).catch() {
            Ok(json) => Ok(json),                                        // 已是 JSON 字符串
            Err(CaughtError::Exception(e)) => Err(format!(               // Error 实例：message + stack
                "js error: {} @ {}", e.message().unwrap_or_default(),
                e.stack().unwrap_or_default())),
            Err(CaughtError::Value(v)) => Err(format!("js threw: {:?}", v)),
        }
    }) // Ctx 只在 with 回调内有效，返回后 JS 值即失效
}

// 用法：Rust 侧 serde_json 解析返回值，继续走现有 models（Comic/Chapter）序列化
// let json = run_parse(&html, Duration::from_millis(1000))?;
// let comics: Vec<Comic> = serde_json::from_str(&json)?;
```

要点回顾：

- `Context::full` 注册全部标准 intrinsics（含 `JSON.stringify`、`RegExp` 等）；解析脚本用 `full`（`base` 只注册必需函数，无法保证脚本依赖的 JSON/正则等可用）。
- 入参 `&str` 经 `IntoJs` 直接成 JS string；返回 `String` 经 `FromJs` 拿回；**没有用任何 derive/宏/额外 feature**。
- 超时、内存、栈全在 `Runtime` 上、按调用设置。
- `context.with(...)` 内拿到的 `Ctx` 只在回调内有效，返回的 `String`（Rust 所有权值）可带出——这与 JS 值的生命周期模型天然契合「返回 JSON 字符串」的协议。

---

## 与本仓库对接建议（现状接线图）

- **入口不动**：`crawler/mod.rs::crawl(op, source, payload) -> String` 保持对外协议；把 `webtoons`/`mangadex` 的 `match source` 改为「按 source 查运行时脚本，没有则回退原生实现或报错」。
- **网络不动**：HTML/JSON 抓取继续走 `crawler/http.rs` 的 blocking client（Referer/UA/重定向/gzip 不变），JS 只收到纯 HTML/JSON 字符串、只吐 JSON 字符串。热链/图片缓存/代理与本决策正交。
- **线程模型不动**：`src-tauri` 的 `spawn_blocking` 已就位；JS 执行与 HTTP 阻塞调用在同一 blocking 线程，语义一致，`mojuan-core` 保持无 tauri 依赖。
- **脚本契约**：`parseList(html) -> string`、`parseDetail(html) -> string`、`parseImages(html) -> string`（JSON 源则传 JSON 字符串）——与现有 parse 函数一一对应；返回结构对齐 `models.rs` 的 `Comic`/`Chapter`/`Detail`（camelCase）。
- **落地顺序**：先「每调用新建 Runtime+Context」最小闭环（§6 代码形态），稳定后再做「每源 warm 池 + 每次调用前刷 deadline」的优化；源脚本体积在 Rust 侧加载时设上限。

---

## Sources

- crates.io API：`/api/v1/crates/rquickjs`（0.12.2 版本信息、features 列表，2026-07-27 发布）
- docs.rs **rquickjs 0.12.2**：https://docs.rs/rquickjs/latest/rquickjs/ —— 首页（Runtime/Context 概念、async 建议、Converting Values、Optional features、IntoJs/FromJs derive、`embed!` 宏）
- docs.rs **rquickjs-core 0.12.2**：
  - `runtime::Runtime`（new / set_interrupt_handler / set_memory_limit / set_max_stack_size / set_gc_threshold / run_gc / memory_usage）https://docs.rs/rquickjs-core/latest/rquickjs_core/runtime/struct.Runtime.html
  - `runtime::InterruptHandler`（= `Box<dyn FnMut() -> bool + 'static>`）https://docs.rs/rquickjs-core/latest/rquickjs_core/runtime/type.InterruptHandler.html
  - `context::Context`（base/custom/full/builder/with）https://docs.rs/rquickjs-core/latest/rquickjs_core/context/struct.Context.html
  - `context::Ctx`（eval / eval_with_options / globals / catch / throw）https://docs.rs/rquickjs-core/latest/rquickjs_core/context/struct.Ctx.html
  - `context::EvalOptions`（global/strict/backtrace_barrier/promise/filename）https://docs.rs/rquickjs-core/latest/rquickjs_core/context/struct.EvalOptions.html
  - `function::Function`（call / call_arg）https://docs.rs/rquickjs-core/latest/rquickjs_core/function/struct.Function.html
  - `enum::Error`（22 变体）https://docs.rs/rquickjs-core/latest/rquickjs_core/enum.Error.html 、`enum::CaughtError`（Exception/Value）https://docs.rs/rquickjs-core/latest/rquickjs_core/enum.CaughtError.html 、`struct::Exception`（message/stack/throw_syntax/throw_type）https://docs.rs/rquickjs-core/latest/rquickjs_core/struct.Exception.html
  - `convert` 模块（IntoJs/FromJs/Coerced 等）https://docs.rs/rquickjs-core/latest/rquickjs_core/convert/index.html
- GitHub DelSkayn/rquickjs：README（QuickJS-NG 绑定、features 一览、300µs 生命周期引述、Supported platforms）、rquickjs 0.12.2 Cargo.toml（facade features / workspace / MSRV）、rquickjs-sys README（内置补丁说明）——经 raw.githubusercontent.com 获取
- 本仓库：
  - `desktop/src-tauri/src/lib.rs`（`crawl` command 的 `spawn_blocking` 接线）
  - `desktop/crates/mojuan-core/src/crawler/mod.rs`（`crawl` 分发）、`webtoons.rs`（HTML 解析函数形状）、`mangadex.rs`（JSON 解析函数形状）、`http.rs`（blocking 网络层）、`models.rs`（Comic/Chapter/Detail）
