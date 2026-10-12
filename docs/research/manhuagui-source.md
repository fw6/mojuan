# 漫画柜 manhuagui.com 源 — 实现状态与验证指南（2026-08-19，2026-10-12 改按源文档）

> **路径说明**（2026-10-12 布局改动）：本文里的 `desktop/` 现为 `apps/mojuan/`，`desktop/crates/` 现为 `crates/`，`updater/` 现为 `apps/updater/`，`npm`/`npx` 换成 `pnpm`。

## 状态

漫画柜（看漫画，国内主流免费中文源）的解析规则是一份**源文档**：源仓库 `fw6/cimoc-sources` 的
`sources/manhuagui.json`，应用仓库 `desktop/crates/mojuan-core/src/js/sources/manhuagui.json`
是同一份（回归数据）。内置源只有 webtoons 一个，漫画柜由用户从设置页的「漫画源」目录安装。

**搜索/详情已在本环境真网验证**；**图片链路（章节页解包 p.a.c.k.e.r → hamreus CDN）需家用网络验证**
——manhuagui 对数据中心 IP 有强反爬：前几次请求可通，随后整站连接被拒（ECONNRESET/超时），
且章节页的图片脚本（path/files/sl）对数据中心 IP 直接剥离（返回无 eval 的壳页）。

实现：
- `sources/manhuagui.json` — 源文档（五 op；`images` 是整 op 钩子，见维护注意）
- fixture：`tests/fixtures/manhuagui-{search,detail,chapter}.html`（chapter fixture 里是 p.a.c.k.e.r 包）

测试：`cargo test -p mojuan-core --test source_doc_test`（真 QuickJS + 真 scraper 跑每份文档）与
`npx vitest run crates/mojuan-core/src/js/source-docs.test.js`（node 侧共享驱动）都覆盖这个源。
真网：`manhuagui_live_search` 本机曾通过（随后被 IP 封禁，见下）；`manhuagui_live_detail_and_images`
在本机 detail 通过、images 按预期被剥离。

## 真网验证（待在家用网络执行）

```bash
cd desktop
cargo test -p mojuan-core --test live_smoke -- --ignored manhuagui
```

**预期**：`manhuagui_live_search` 通过（打印条数与首条）；`manhuagui_live_detail_and_images`
打印 `manhuagui detail: N 章；首章 M 张图` 并通过。

**若失败**：
- 搜索/详情空 + panic 提示数据中心 IP —— manhuagui 对数据中心 IP 有**整站 IP 封锁**（首次可通，随后
  连接被拒），与代码无关，家用住宅 IP 正常。
- `images` 空 + 提示「服务端剥离图片脚本」—— 章节页对数据中心 IP 返回剥离壳（无
  `eval(function(p,a,c,k,e,d)`），家用网络应能拿到完整脚本。**本实现的解包逻辑按开源参考
  （venera manhuagui.js getImgInfos）实现，fixture 用真实 p.a.c.k.e.r 包验证过解包正确**；若家用网络
  仍为空，把章节页 HTML 存下来回报（重点看 `path`/`files`/`sl` 字段名是否变动）。

> 注意：本仓库开发机公网 IP 为数据中心段，被 manhuagui 强反爬；家用网络不受此封锁。

## 维护注意

- **章节号 = 章节页 URL 的 cid**：详情页章节 `<a href="/comic/{comicId}/{cid}.html" title="第N话">`，
  `cid` 同时作为 Chapter.index 与 images 的 chapterIndex（images URL = `/comic/{comicId}/{cid}.html`）。
  文档按 `div[id^="chapter-list-"] a[href$=".html"]` 定位、并要求 `title` 非空（章节栏「更新至」的
  快捷链接没有 title）。
- **p.a.c.k.e.r 解包**：章节页图片信息在 `eval(function(p,a,c,k,e,d){…})` 打包脚本里，解包后形如
  `{"path":"/…/","files":["1_x.jpg",…],"len":N,"sl":{"e":"…","m":"…"}}`；
  图片 = `https://us.hamreus.com{path}{file}?e={e}&m={m}`。这一段是文档里 `images` 的**整 op 钩子**
  （`ops.images.script`，ADR-0002 的「算法型源的出口」）：声明式的选择器表达不了解包，钩子拿
  `api.responses.page` 自己算，再用 `api.helpers` 里的 `after` / `before` 取 path / e / m。
  钩子做的是**单趟词元替换**（按词边界切词、查表，不级联），没有照抄站点自己的
  `while(c--) p = p.replace(new RegExp('\\b'+e(c)+'\\b','g'), k[c])`：那个循环在「某个字典值本身
  又是词元名」时会二次替换，fixture 里的 `len` 就被串成 `2_def`（站点自己不读这个字段，所以无感）。
  单趟替换与它相比，path / files / e / m 四个真正用到的字段结果一致，且不会被二次替换影响。
- **hamreus 域名轮换**：图片域名硬编码在钩子里（`https://us.hamreus.com`；可能随地区/时间轮换，
  失效时看章节页解包出的 path 前缀域名或参考其它下载器更新）。图片需 Referer
  `https://www.manhuagui.com/`（文档的 `hotlinkReferers`，前端 imgSrc 已接）。
- **分类码**：`/list/{code}/`（38 个，见文档的 `categories`；不含地区/年代/字母）。

## 结构要点（2026-08-19 实测）

- 搜索：`/s/{kw}_p1.html` → `.book-result ul > li.cf` → `.book-cover a.bcover`（href=/comic/{id}/、
  img=//cf.mhgui.com/cpic/b/{id}.jpg、`.tt` 最新章）、`.book-detail`（`.tags.status .red` 状态、`作者：`、`简介：`）。
- 详情：`.book-title h1`（标题）、`.hcover img`（封面）、`#intro-all`（简介）、
  `.chapter h4 span`（分组：单话/连载/单行本）+ `.chapter-list ul li a[title]`（章节）。
- 章节页（家用网络）：含 `eval(function(p,a,c,k,e,d)` 打包脚本（本机被剥离）。
