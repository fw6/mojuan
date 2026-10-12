# ADR-0002: 源定义用文档而非脚本

- 状态：Accepted
- 日期：2026-10-12

## Context

wayfinder #11（2026-08-15）定案「源 = 运行时加载的 JS 脚本」，并已实现：9 个源各一份整源脚本
（`crates/mojuan-core/src/js/sources/*.js`，3195 行），在 rquickjs 沙箱里执行 `buildUrl` / `parse`，
外加一个 Rust 侧源适配器（`crates/mojuan-core/src/crawler/sources/*.rs`）承担请求头、ctx 派生、
隐藏字段提取、渲染通道声明与热链对。

这个形状给想自己写源的人设了三道门槛：

- 作者要会写 JS，而解析页面这件事本身不需要 JS。
- 沙箱按 research #14 基线不挂 RegExp 与 DOM，9 份脚本里约 600 行是逐字节相同的 HTML 字符串
  遍历副本（`collapse` 8 份、`stripTags` 7 份、`attr` 7 份），作者每加一个源都要再抄一遍。
- 一个源的事实分在两门语言两个文件里，读一个源要在 JS 脚本与 Rust 适配器之间来回跳。

## Decision

源改由一份 JSON **源文档**描述，由一份共享的 **源运行时** 解释。文档声明 URL 模板、静态分类表、
HTML 选择器或 JSON 路径到字段的映射、章节排序去重、id 前缀、请求头、热链对、渲染通道标志；
运行时随源仓库分发，app 内置一份默认副本并可远程更新。

配套定案：

- 文档由类型化的 Rust 结构体校验，`schemars` 由该结构体生成 JSON Schema，供编辑器补全与源仓库
  提交时检查。
- HTML 求值经纯计算的宿主绑定 `__host.select` 调用 app 侧已有的 `scraper`（html5ever + CSS
  选择器），运行时不再手写字符串扫描。
- 需要真正算法的 op 由文档内嵌的 `script` 钩子承担，当前只有 manhuagui 的 `p.a.c.k.e.r` 解包与
  hentara 的本地搜索两处。钩子是**有边界**的出口：只有 `ops.<op>.script`（给出该 op 的最终值）
  与 `items` 上的 `script`（只给出单元列表）两个位置，与会被忽略的键并存、或写在别处，都在文档
  校验时被拒——出口写在 Schema 的边界上，运行时不会读的位置不允许出现。钩子拿到共享前导
  `api.helpers`（与声明式层同一份实现，作者不必再抄一遍小工具）与 `api.select`，宿主绑定不经
  别的入口暴露；沙箱挂 `RegExp`，其代价由 2 秒墙钟超时兜底（灾难性回溯会被打断）。
- 一个 op 可以按顺序发多次请求，后一步的 URL 可引用前一步响应里取出的值；隐藏字段在取值处声明，
  运行时把它从输出里剥掉交给 app 侧缓存。
- 内置源只保留 webtoons 一个（格式的参考实现与首启可用的保证，可更新、不可卸载、为默认源）；
  其余源由用户从源仓库目录安装或手动导入。
- 一次性迁移，脚本路径迁完即删，不留历史版本兼容（应用未对外发布）：前端读到没有 `document`
  的安装记录（旧模型只写了 `script`）会直接丢掉它，Rust 侧收到空文档也只按该源自己失败处理，
  不让一条旧记录把整次同步判为非法。

## Rationale

- **作者门槛**：写源从「写 200–500 行 JS」降到「填几十行 JSON」，而目标读者是懂 CSS 选择器与
  JSON 路径、不写 JS 的人。
- **局部性**：选择器求值、变换、集合装配只有一份实现，一处修正作用于全部源；600 行副本消失。
- **格式可远程演进**：解释器留在沙箱里，站点改版需要新的表达力时随索引更新，不必等 app 发版。
  这是 wayfinder #11 选 rquickjs 的理由，文档格式把它保住。
- **可校验**：文档能被 Schema 校验、能被编辑器补全；整源 JS 做不到这一点。
- **Rust 侧收缩**：8 个源适配器删除，`Source` trait 的 9 个方法消失，注册表从静态 9 项变成
  「内置 1 项 + 运行时导入项」。

## Consequences

- `crates/mojuan-core/src/crawler/sources/` 的 9 个适配器、`js/sources/` 的 9 个脚本与 9 份
  `*.test.js` 删除；`bundled_sources` 命令、`initSources` 的首启种子与老安装合并逻辑删除。
- 测试面改为「(fixture, 文档, 期望) 三元组」的共享驱动加每源一条经真 QuickJS 的端到端。
- 结果缓存键含解释器哈希，解释器更新即让全部源的缓存失效。
- 源仓库 `fw6/cimoc-sources` 的 `sources.json` 换成
  `{runtime: {version, script, sha256}, sources: {id: {name, version, document, sha256}}}`：
  一份共享运行时 + 每源一份文档；应用内已有内置的 webtoons，索引里的 webtoons 条目负责覆盖它。
- 后续架构评审不应再建议「源用整源 JS 脚本」，除非出现文档格式表达不了的整类需求。
