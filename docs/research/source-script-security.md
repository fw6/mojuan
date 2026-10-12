# 源脚本在 QuickJS/rquickjs 中的安全边界（wayfinder #11）

> **路径说明**（2026-10-12 布局改动）：本文里的 `desktop/` 现为 `apps/mojuan/`，`desktop/crates/` 现为 `crates/`，`updater/` 现为 `apps/updater/`，`npm`/`npx` 换成 `pnpm`。

背景：产品决策（wayfinder grilling #11）已定——漫画「源」迁为运行时加载的 JS 脚本，在 mojuan-core 里用 rquickjs（QuickJS）执行；脚本从远程源仓库分发（未签名、社区可投稿），只做解析（HTML/JSON → 结构化 JSON），网络/文件系统留在 Rust 原生层。本调研回答：不暴露任何宿主 API 时脚本能干什么、需要哪些资源限制、同类产品怎么做的、以及 v1 的默认安全基线。

核心判断：**脚本跑在进程内、无任何宿主绑定时，残余攻击面只有「自 DoS」（CPU/内存/卡死），没有数据窃取与代码逃逸。用 rquickjs 自带的 memory limit + interrupt handler（墙钟超时）+ 栈上限 + 脚本体积检查四个旋钮即可封住 DoS，不需要子进程/虚拟机等重型沙箱。**

> **修订（2026-08-15，prototype #15 实测）**：`Eval` intrinsic **必须挂载**——rquickjs 的 `Ctx::eval` 走 quickjs-ng 的 `JS_Eval → JS_EvalInternal`，该函数以 `ctx->eval_internal` 为门槛（未设则抛 "eval is not supported"，见 quickjs.c `JS_EvalInternal`/`JS_AddIntrinsicEval`），而 `eval_internal` 只能由 `JS_AddIntrinsicEval` 设置。因此 `Context::custom` 缺 `Eval` 时**连脚本本身都加载不了**，§4.1 原基线代码不成立；「禁 eval/Function 字符串编译」与「引擎能执行脚本」不可兼得，全局 `eval`/`Function` 对脚本保留，恶意脚本的动态代码能力靠超时/内存/体积兜底。白名单基线修正为 `Context::custom::<(Date, Json, Eval)>`；`RegExp`/`MapSet`/`Proxy` 等仍可独立裁剪后置。

---

## 1. 攻击面：不暴露任何宿主 API 时，脚本能做什么

### 1.1 引擎隔离模型

- QuickJS 是**纯字节码解释器**（interpreter），没有 JIT、没有 WASM、没有原生代码生成。脚本里的一切都在引擎托管内存中运行，唯一能触达外界的通道是「宿主显式注册到全局对象上的函数」。rquickjs 本身不注册任何 fs/网络/进程/env 全局——那套 `std`/`os`/`bjson` 模块是 qjs 命令行 shell 用 C 写的宿主扩展，不挂载就不存在。
- 不注册 `JS_SetSharedArrayBufferFunctions`，就没有共享内存原语（TypedArrays/Atomics 即便挂载也无线程间共享通道）。脚本是单线程、无并发逃逸面。
- 结论：**脚本天然困在引擎里；能造成的最大伤害是「把进程/线程的 CPU 和内存耗光」。**

### 1.2 脚本能接触的标准全局对象

rquickjs 的 Context 有三级构造（源码见 `core/src/context/base.rs`、`core/src/context/builder.rs`）：

| 构造 | 内部 | 全局对象 |
|---|---|---|
| `Context::base` | `JS_NewContextRaw` + `JS_AddIntrinsicBaseObjects` | 仅核心：`Object` `Function` `Array` `Math` `Number` `String` `Boolean` `Symbol` `Error` 及子类、`Iterator`、`GeneratorFunction`（quickjs.c `JS_AddIntrinsicBaseObjects`） |
| `Context::full` | `JS_NewContext` | 上述 + `Date` `eval` `RegExp` `JSON` `Proxy` `Map/Set` `TypedArrays` `Promise` `WeakRef` `atob`（quickjs.c `JS_NewContext`） |
| `Context::custom<I>` / `builder()` | `JS_NewContextRaw` + BaseObjects + 自选 intrinsic | 每个 intrinsic 独立开关：`Date` `Eval` `RegExpCompiler` `RegExp` `Json` `Proxy` `MapSet` `TypedArrays` `Promise` `Performance` `WeakRef`（rquickjs `intrinsic` 模块） |

两个对安全重要的细节（quickjs.c 源码验证）：

1. **`Math` 永远在**（BaseObjects 就挂 `js_math_obj`），`String/Array/Number` 原型方法（`split`/`replace`/`join`/`map`…）也永远在。**社区脚本的常规解析写法不需要 Date/RegExp/JSON 之外的东西**，所以 globals 可以按白名单裁剪到很小。
2. **不挂 `Eval` intrinsic，字符串→代码编译就被禁用**：全局 `eval`/`Function` 构造器仍存在，但 `js_eval_this` 里 `if (unlikely(!ctx->eval_internal)) return JS_ThrowTypeError(ctx, "eval is not supported")`。即脚本无法动态生成新代码——这是真实的反攻击面收益（堵住 `eval`/`Function` 这类「反编译器」入口）。`JS_AddIntrinsicEval` 的正文就是 `ctx->eval_internal = __JS_EvalInternal`。
3. QuickJS 核心**不含 Intl（ECMA-402）**——没有 `Intl` 全局（rquickjs intrinsic 清单里也没有），少一个又大又慢的对象。

### 1.3 残余攻击面：只有拒绝服务（DoS）

恶意脚本在不越界的情况下仍能：

- **死循环**：`while (1) {}`、嵌套 `for`、`Array.prototype` 陷阱等——把单个 CPU 核跑满。这是唯一无法用「不给权限」堵住的攻击，只能靠中断/超时。
- **内存耗尽**：`new Array(1e9)`、`"x".repeat(1e9)`、循环累加大字符串/对象、生成海量小对象触发 GC 抖动——受 memory limit 约束。
- **深递归**：`const f=()=>f(); f()` 及互相递归——受栈上限约束（见 §2）。
- **正则灾难性回溯**（若挂载 `RegExp`）：`/(a+)+$/.exec("aaaaaaaa…b")` 指数级回溯烧 CPU——这也是 `Context::base` 默认不给 RegExp 的理由之一；脚本改用字符串方法则无此面。
- **`Proxy` 反射开销**（若挂载）：大量 `new Proxy({}, …)` 放大每次属性访问的成本。
- **编译超大脚本**：一次性 eval 几十 MB 源码，编译期内存放大——由「脚本体积检查 + memory limit」双保险兜住。

上述全部是「消耗自己的资源」；因为无网络、无 fs、无持久化，**数据外泄、投毒、phoning-home 均不可能**。

### 1.4 越界行为如何终结（都回到 Rust 侧，JS 抓不住）

- **内存超限**：`js_malloc_rt` 检查 `malloc_size + size > malloc_limit - 1`，超限返回 NULL → 调用方 `JS_ThrowOutOfMemory` 抛 `InternalError("out of memory")`，有 `in_out_of_memory` 重入保护；即使错误对象都分配不出来，也返回 `JS_EXCEPTION` 而不是 abort（quickjs.c）。→ `eval` 返回 `Err`。
- **栈溢出**：`JS_ThrowStackOverflow` 抛 `RangeError("Maximum call stack size exceeded")`（quickjs.c）→ `eval` 返回 `Err`。
- **中断**：interrupt 闭包返回 `true` 时，引擎抛一个 **JS 的 try/catch 也抓不住的不可捕获异常**，控制流回到 Rust（rquickjs `set_interrupt_handler` 文档原文："raise an uncatchable exception and return control flow to the caller"）。→ `eval` 返回 `Err`。
- rquickjs 0.12.2 的 `Error` 枚举（`core/src/result.rs`）覆盖这些路径：`Allocation`（内存）、`Exception`（JS 异常，值可用 `Ctx::catch` 取）、`Unknown` 等；中断没有独立变体，表现为 `Exception`。

### 1.5 明确做不到的事（写进文档给运营/审核参考）

不挂宿主绑定 + 不挂 Eval intrinsic 的前提下，脚本**不能**：读写文件、发网络请求、读环境变量/进程信息、生成新代码（eval/Function）、跨线程共享、持久化任何状态、影响其它脚本/其它源。每次执行都是无状态的（引擎级无残留，跨请求不共享 runtime 即可）。

---

## 2. 需要的资源限制

### 2.1 QuickJS C API 原生提供

QuickJS 官方手册（bellard.org/quickjs/quickjs.html）：

- `JS_SetMemoryLimit(rt, limit)`——"Set a **global memory allocation limit** to a given JSRuntime"。
- `JS_SetMaxStackSize(rt, size)`——"The maximum **system stack size** can be set"（rquickjs 文档：默认 `256 * 1024` 字节）。
- `JS_SetGCThreshold(rt, threshold)`——自动 GC 的内存阈值（默认 256 KB，`-1` 关闭自动 GC；GC 跑过后若回收不足会自适应上调，quickjs.c 第 1698 行）。
- `JS_SetInterruptHandler(rt, cb, opaque)`——"a callback which is **regularly called by the engine when it is executing code** … can be used to implement an **execution timeout**"（手册原文）。
- `JS_NewRuntime2`——自定义分配器挂钩（我们不用，见 §4.3）。

### 2.2 rquickjs 暴露哪些（逐条对照，0.12.2 实测）

rquickjs `Runtime`（`core/src/runtime/base.rs`）把上面的 C API 1:1 暴露，单位与语义一致：

| 能力 | rquickjs API | 说明 |
|---|---|---|
| 内存上限 | `set_memory_limit(&self, limit: usize)` | 0 = 无限；**用 `rust-alloc` 或 `allocator` feature 时是 no-op**（文档原文，见 §4.3） |
| 栈上限 | `set_max_stack_size(&self, limit: usize)` | 默认 256 KB；间接约束递归深度 |
| GC 阈值 | `set_gc_threshold(&self, threshold: usize)` | 默认 256 KB |
| 执行中断 | `set_interrupt_handler(&self, handler: Option<InterruptHandler>)` | `Box<dyn FnMut() -> bool>`，返回 `true` → 不可捕获异常 |
| 内存观测 | `memory_usage() -> JSMemoryUsage` | 事后统计（不设限） |
| 手动 GC | `run_gc()` | — |

脚本执行：`Ctx::eval::<V,_>(source)` / `eval_promise` / `eval_with_options`（`EvalOptions{global, strict, backtrace_barrier, promise, filename}`，默认 `global=true, strict=true`）。异常用 `Ctx::catch()/has_exception()/throw()`。

### 2.3 原生不提供、需自建的（都很薄）

| 缺的能力 | 自建方案 | 工作量 |
|---|---|---|
| **墙钟执行超时** | QuickJS 只有 interrupt 回调，没有内置超时；在闭包里自记 `Instant`，`elapsed() > 时限` 即返回 `true`。这是官方手册钦定的用法（"can be used to implement an execution timeout"） | ~5 行 |
| **脚本体积上限** | eval 前 `source.len()` 检查（QuickJS 无源码体积限制，只有 memory limit 间接兜底） | 1 行 |
| **按 op 配额 / 连续执行总预算** | 调用方（crawler 命令层）每次 op 建新 Runtime 或复用一个带计数器的工作线程即可 | 调用方逻辑 |
| 递归深度单独旋钮 | **不需要**——栈上限已间接覆盖；深递归表现为 RangeError | 0 |

补充：QuickJS 官方也**没有**「指令数/CPU 预算」API，interrupt 回调就是唯一的执行节流点；它在循环回边、函数调用等字节码执行点被轮询，紧循环也会命中，因此墙钟截止有效（不会出现「纯 JS 死循环让 interrupt 永远不被调用」的情况）。

### 2.4 线程模型（v1 关键前提）

- rquickjs 的 `Runtime` 只在 `parallel` feature 下才 `Send + Sync`（`unsafe impl`，`core/src/runtime/base.rs`）；不开 `parallel` 时 runtime 不能跨线程移动。
- **v1 不需要 `parallel`**：在 `tauri::async_runtime::spawn_blocking` 闭包里创建 Runtime + Context → eval → 返回 JSON 字符串，整个生命周期在 worker 线程内。时间超时用闭包自记 `Instant` 实现，不需要跨线程写中断状态。
- 若以后要支持「用户在 UI 上中途取消」，再加 `parallel`，interrupt 闭包改读一个 `Arc<AtomicBool>`（`parallel` 下 `InterruptHandler` 要求 `Send`）。
- 注意：interrupt 闭包本身**绝不能阻塞**（不能锁互斥体/发消息），否则卡死 worker；用 `Instant` 或原子量。

---

## 3. 同类实践

### 3.1 QuickJS 官方（qjs 命令行）

qjs.c（quickjs-ng/quickjs master）的用法文本：

- `--memory-limit n`——"limit the memory usage to 'n' **Kbytes**"，`--stack-size n`——"limit the stack size to 'n' Kbytes"，分别调 `JS_SetMemoryLimit`/`JS_SetMaxStackSize`。
- **`-q --quit` 不是安全选项**：帮助文本是 "just instantiate the interpreter and quit"——只建解释器就退出，用于测启动开销，与限制无关。
- 宿主模块（`std`/`os`/`bjson`）需显式 `--std` 才挂载——**默认不给脚本宿主 API 的模型，和我们的方案一致**。
- qjs 本身**没有 `--timeout`**：官方把执行超时交给 `JS_SetInterruptHandler`（手册明言）。

要点：官方引擎/官方 shell 都认可「memory + stack 两上限 + interrupt 超时」这套组合；没有更重的沙箱机制。

### 3.2 浏览器扩展（Chrome/WebExtensions）

- 内容脚本跑在 **isolated world**："An isolated world is a private execution environment **that isn't accessible to the page or other extensions**"；与页面共享 DOM、只能经 `postMessage` 通信（developer.chrome.com content-scripts 文档）。
- 权限按 **manifest 声明 + 商店人工/自动审核**执行；**没有任何运行时 CPU/内存限制**——死循环的扩展只会卡住它自己的标签页，用户关标签即可。
- 信任边界 = 商店审核 + 权限清单，而不是沙箱本身。

### 3.3 用户脚本管理器（Greasemonkey/Tampermonkey）

- Greasemonkey 的沙箱方向是**保护脚本、防页面**："isolates **trusted user script code from potentially malicious web page code**"，通过对象包装（XPCNativeWrappers）隔离页面对象（wiki.greasespot.net/Sandbox）。
- 同样**无 CPU/内存限制**；死循环的脚本卡标签页，用户可停用。Tampermonkey 在 Chrome 上就是普通 content script（isolated world）。
- 注意方向差：油猴沙箱防「页面害脚本」，我们防「脚本害宿主」；机制内核相同——**引擎隔离 + 不暴露/包装宿主对象**，只是威胁方向反过来。

### 3.4 云运行时类比（Cloudflare Workers，进程内执行不可信 JS 的工业先例）

- **CPU 时间**按请求限额：Free 10 ms；Paid 默认 30 s、上限 5 min（`limits.cpu_ms`）；**内存**按 isolate 128 MB（developers.cloudflare.com/workers/platform/limits）。
- 这就是「时间 + 内存」双旋钮的成熟先例：墙钟/CPU 预算对应我们的 interrupt 超时，内存上限对应 `set_memory_limit`。CF 还能用 V8 的 isolate 级 CPU/mem 计量，QuickJS 侧没有同等细粒度计量，但我们的脚本更小、场景更窄（只解析字符串），不需要那么精确。

### 3.5 模式总结

| 平台 | 权限模型 | 运行时限制 | 信任边界 |
|---|---|---|---|
| 浏览器扩展 | manifest 权限 + 商店审核 | 无 CPU/内存限制 | 审核 + 权限清单 |
| 油猴类用户脚本 | 脚本自身声明 + 用户安装 | 无 | 用户安装动作 |
| qjs 官方 shell | `--std` 显式挂宿主模块 | memory-limit + stack-size（可设，默认不限） | 本地执行者 |
| Cloudflare Workers | 平台账号 + 部署审核 | CPU 时间 + 128 MB/isolate | 平台 |
| **mojuan 源脚本（本方案）** | **不挂宿主 API + 源仓库审核（社区）** | **memory + 时间 + stack + 体积** | 源仓库分发渠道 |

社区源仓库分发（未签名）+ 运行时限额，正好落在「商店审核 + 运行时资源兜底」的惯例组合里。

---

## 4. v1 默认安全基线建议

对齐本仓库 AGENTS.md 的「渐进式、不过度设计」：**只封住自 DoS，不引入子进程/虚拟机/签名验证等重型机制**。以下每一项都是 rquickjs 一行 API 或一次调用方检查。

### 4.1 必做限制（v1 落地）

```rust
use rquickjs::context::intrinsic::{Date, Eval, Json};
use rquickjs::{Context, Runtime};
use std::time::Instant;

// 在 tauri::async_runtime::spawn_blocking 的 worker 线程内整体执行（AGENTS.md 坑 #1）
let rt = Runtime::new().map_err(|e| e.to_string())?;

rt.set_memory_limit(32 * 1024 * 1024);          // ① 内存上限 32 MB（0 = 无限；单位字节）
let deadline = Instant::now() + Duration::from_secs(2);
rt.set_interrupt_handler(Some(Box::new(move || { // ② 墙钟执行超时 2 s
    Instant::now() >= deadline                   //    返回 true → 不可捕获异常 → eval 返回 Err
})));                                            //    闭包内禁止阻塞！
// ③ 栈上限：保持默认 256 KB（set_max_stack_size 可不调；深递归抛 RangeError）
// ④ GC 阈值：保持默认 256 KB（set_gc_threshold 可不调）

let ctx = Context::custom::<(Date, Json, Eval)>(&rt).map_err(|e| e.to_string())?; // ⑤ 白名单 globals（Eval 必挂，见文首修订）
let result: String = ctx.with(|ctx| ctx.eval(source)).map_err(|e| e.to_string())?;
// result 即脚本产出的 JSON 字符串，回传调用方
```

数字口径（脚本只是「HTML/JSON 字符串 → 小 JSON」的解析器，毫秒级、KB 级）：

- **内存上限 32 MB**：一次解析产出的是列表/详情 JSON（几百条记录），16–32 MB 远宽裕；同时也天然兜住「超大脚本编译期内存放大」。单位是字节，别按 KB 传。
- **执行超时 2 s**：纯 CPU 预算（网络在 Rust 层，脚本内无等待）。解析单页 HTML 是毫秒级；2 s 是数量级余量。
- **脚本体积 ≤ 256 KB**：eval 前 `source.len()` 检查，超限直接拒绝加载。社区解析脚本实际通常几十 KB 以内。
- **栈上限 / GC 阈值**：用 QuickJS 默认值（256 KB / 256 KB），不额外调。
- **每次 op 一个新 Runtime + 新 Context**（在 worker 线程内创建、用完即弃）：天然做到「跨请求无引擎状态残留」+「单次配额隔离」。重复创建成本可忽略（引擎很小）。

### 4.2 Context 全局白名单

`Context::custom` 从 base 起步（`Object/Function/Array/Math/Number/String/Boolean/Symbol/Error/Iterator/GeneratorFunction` + 原型方法始终在），**只加解析真正需要的**：

- **加 `Json`**：解析与输出 JSON（若脚本契约是「最后表达式是 JSON 字符串」，甚至可不加，但加着无害且省得社区作者手搓序列化）。
- **必加 `Eval`**（修订，见文首）：引擎执行脚本本身走 `eval_internal`，缺 Eval 连脚本都加载不了；全局 `eval`/`Function` 因而对脚本保留，其动态代码能力由超时/内存/体积兜底。
- **加 `Date`**：源站时间戳/章节日期常要格式化。
- **可后置 `RegExp`**：默认不给（`Context::base` 无 RegExp），要求脚本用字符串方法；若社区反馈确实需要再开——每次少一个 ReDoS 面。
- **不加**：`RegExp`（默认不给，要求脚本用字符串方法；若社区反馈确实需要再开——少一个 ReDoS 面）、`Proxy`、`TypedArrays`/`Atomics`、`Promise`（v1 全同步）、`WeakRef`、`Performance`、`MapSet`（可选，脚本作者用普通对象即可）。
- 契约上把「可用全局对象清单」写进源脚本规范，作为审核与投稿的公开约束。

### 4.3 明确的依赖/feature 约束

- **不要开 `rust-alloc` / `allocator` feature**：rquickjs 文档明言此时 `set_memory_limit` 是 no-op（自定义分配器绕过引擎的记账）——内存限制是整个方案的一半，这个 feature 必须保持关闭，用默认系统分配器（`Runtime::new()`）。
- **不要开 `parallel`**（v1）：不开也能在 worker 线程内跑；它只为跨线程共享 Runtime 而存在。
- rquickjs 用 `default` feature（`std`）即可；`loader`/`futures`/`macro` 都不需要。
- 版本：rquickjs 0.12.2（crates.io 最新，2026-08 时点）。

### 4.4 后置项（v1 明确不做）

- **进程级隔离**（独立子进程跑引擎 / QuickJS-WASM / 每源一个 worker 进程）：只有当威胁模型升级到「不信任引擎本身（QuickJS C 层 bug 可能崩整个应用进程）」或「审核渠道被攻破导致恶意脚本频繁进入」时才需要。v1 的信任边界是「社区审核的源仓库」（等同商店审核），引擎是成熟、纯解释、无宿主绑定的 QuickJS，先不隔离。
- **脚本签名/校验**：产品决策已是未签名社区分发；签名属于分发层的事，与运行时限额正交，后置。
- **用户中途取消（`parallel` + `Arc<AtomicBool>` 中断标记）**：有明确 UI 需求再加。
- **异步脚本（`Promise`/`eval_promise`/job loop）**：v1 只做同步解析；异步会让中断与 job 队列语义复杂化，等有真实需求再上。
- **每源配额/限流（频次、缓存）**：解析输入（HTML 字符串）由 Rust 层抓取与缓存，脚本本身无网络，限流发生在 Rust 层，不属于脚本运行时安全。
- 更细的 CPU 计量（指令数）与更小的内存上限调参：先按固定默认值上线，用 `memory_usage()` 观测真实峰值后再调。

---

## Sources

- QuickJS 官方手册：https://bellard.org/quickjs/quickjs.html（`JS_SetMemoryLimit` / `JS_SetMaxStackSize` / `JS_SetInterruptHandler`（"regularly called by the engine… can be used to implement an execution timeout"）/ `JS_NewRuntime2` / `JS_EXCEPTION` / `JS_GetException`）
- QuickJS 引擎源码（quickjs-ng/quickjs `master`）：
  - `quickjs.c`：`JS_ThrowOutOfMemory` 与 `in_out_of_memory` 重入保护、`JS_ThrowStackOverflow`（RangeError "Maximum call stack size exceeded"）、`js_malloc_rt` 的 `malloc_limit` 检查、`JS_SetGCThreshold`（默认 `256 * 1024`，GC 后自适应上调）、`JS_AddIntrinsicBaseObjects` 内容、`JS_AddIntrinsicEval`（`eval_internal`）、`JS_NewContext` vs `JS_NewContextRaw`、`js_eval_this` 的 `"eval is not supported"`、`js_function_constructor` 经 `JS_EvalObject` 间接调用
  - `qjs.c`：CLI `--memory-limit`（Kbytes）/ `--stack-size` / `-q --quit`（"just instantiate the interpreter and quit"）帮助文本与 `JS_SetMemoryLimit`/`JS_SetMaxStackSize` 调用
- rquickjs 0.12.2：
  - docs.rs `Runtime`（`set_memory_limit`（0=无限，rust-alloc/allocator 下 no-op）、`set_max_stack_size`（默认 256×1024）、`set_gc_threshold`、`set_interrupt_handler`（uncatchable exception）、`memory_usage`）、`Ctx`（`eval`/`eval_promise`/`eval_with_options`/`catch`）、`Error` 枚举、crate features 页
  - 源码（DelSkayn/rquickjs `master`，核心文件与 0.12.2 一致）：`core/src/runtime/base.rs`（`Send`/`Sync` 仅在 `parallel` 下）、`core/src/runtime.rs`（`InterruptHandler` 定义）、`core/src/context/base.rs`（`base`=`custom::<None>`=`JS_NewContextRaw`+BaseObjects；`full`=`JS_NewContext`）、`core/src/context/builder.rs`（`intrinsic` 模块全清单）、`core/src/context/ctx.rs`（`EvalOptions`）、`core/src/result.rs`（`Error` 变体）
- Chrome 扩展文档（content scripts / isolated world）：https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts
- Greasemonkey wiki Sandbox 页：https://wiki.greasespot.net/Sandbox（"isolates trusted user script code from potentially malicious web page code"）
- Cloudflare Workers limits：https://developers.cloudflare.com/workers/platform/limits/（CPU per request Free 10 ms / Paid 默认 30 s 上限 5 min；Memory per isolate 128 MB）
- 本仓库现状：`desktop/crates/mojuan-core/src/crawler/mod.rs`（`crawl(op, source, payload)` 分派协议，op：categories/search/category/detail/images/cache_dump/cache_hydrate）、`crawler/models.rs`（`Comic`/`Chapter`/`Detail` JSON 契约）、`crawler/webtoons.rs`（HTML 爬虫，scraper + 选择器）、`Cargo.toml`（当前无 rquickjs 依赖）
