# 鸟鸟韩漫 nnhanman.xyz 源 — 实现状态与验证指南（2026-09-30，2026-10-12 改按源文档）

## 状态

鸟鸟韩漫（繁体韩漫站）的解析规则是一份**源文档**：源仓库 `fw6/cimoc-sources` 的
`sources/nnhanman.json`，应用仓库 `desktop/crates/mojuan-core/src/js/sources/nnhanman.json`
是同一份（回归数据）。内置源只有 webtoons 一个，nnhanman 由用户从设置页的「漫画源」目录安装。

**全链路已在本环境真网验证通过**：搜索 7 条 / 分类「热门」18 条 / 详情 5 话 / 首话 262 张图。

该站对数据中心 IP 是**整站 TLS 连接重置**（curl、reqwest 握手阶段即 `Connection reset`，
非内容剥离），所以**整源走隐藏 webview 渲染通道**（与包子漫画同一路，文档的 `renderChannel: true`）；
图片 CDN 无热链校验，由阅读器直接加载（已确认 `new.niaopic.com` / `thumb.niaopic.com` /
`img.nnpic.xyz` 在 webview 里都能出图）。

实现：
- `sources/nnhanman.json` — 源文档（五 op）
- fixture：`tests/fixtures/nnhanman-{search,detail,chapter}.html`（真网渲染转储裁剪）

测试：`cargo test -p mojuan-core --test source_doc_test`（真 QuickJS + 真 scraper 跑每份文档）与
`npx vitest run crates/mojuan-core/src/js/source-docs.test.js`（node 侧共享驱动）都覆盖这个源。
真网（本机数据中心 IP，经渲染通道）：

```bash
cd desktop/src-tauri
cargo run --example render_probe -- crawl nnhanman search '{"keyword":"韓"}'      # 7 条
cargo run --example render_probe -- crawl nnhanman category '{"label":"热门"}'    # 18 条
cargo run --example render_probe -- chain nnhanman nnhanman-zui-bang-de-ta 85989
# detail: 5 话（第1話…第5話）；images: 262 张
```

> mojuan-core 单进程没有 webview 宿主，`cargo test --test live_smoke` 里的渲染源会返回
> 「渲染通道未注册」——该源的真网验证只能走上面的渲染通道探针，与包子漫画相同。

## 已知限制：该源的「下载本话」不可用

站点的 Cloudflare 对非浏览器客户端是 TLS 层拦截（实测 `mojuan_core::crawler::http` 的
reqwest 对 `nnhanman.xyz` 与三个图片域名 `new.niaopic.com` / `thumb.niaopic.com` /
`img.nnpic.xyz` 全部连接失败），而隐藏 webview 是真实浏览器内核、可以正常取图。因此：

- **在线阅读正常**：图片由主 webview 直接加载（已实测三个图片域名都能出图）。
- **下载队列不可用**：下载 worker 走 Rust 的 reqwest 取字节，会被同一层拦截；任务会按既有
  失败语义标成 `failed` 并带错误信息（不静默）。这是站点防护的结果，不是解析问题。

参考：包子漫画（同走渲染通道）的图片域名可被 reqwest 直接取到，下载正常——限制只出在
nnhanman 这种把图片 CDN 也放在同一套 TLS 指纹拦截后面的站点。

## 维护注意

- **镜像域名轮换**：页面页脚常驻公告给出备用域名（`nnhanman66.com`、`nnhanman88.com`、
  `nnhm81.com`、`nnhm92.com`、`nnhm91.com`）。主域换掉时改文档的 `base` 一处即可。
- **图片域名会轮换**：同一次抓取里封面在 `thumb.niaopic.com`、正文图在 `new.niaopic.com`
  或 `img.nnpic.xyz`。文档按页面实际给出的 URL 返回，不做域名拼接。
- **章节号 = 章节 URL 的末段数字**（`/comic/{slug}/chapter-{id}.html`），章节 id 同时作为
  `Chapter.index` 与 images 的 chapterIndex，可重建，不需要缓存。
- **详情页章节表默认倒序**（站方有「升序/降序」切换按钮，服务端渲染的是倒序），文档解析后
  按章节号升序返回；解析范围限定在章节容器 `#mh-chapter-list-ol-0` 内，避免把「开始阅读」按钮
  （链到首话）的文案当成章节标题。
- **分类路径**：`/comics/{分类}/ob/{time|hits}/st/{all|completed|serialized}`；分类名是中文
  （题材类是站方目录名，文档按 `encodeURIComponent` 编码后拼路径）。总览四项（最新更新/热门/
  已完结/连载中）与题材 20 项都写在文档的 `categories` 里。
- **搜索**：`/catalog.php?key={关键词}`（站内搜索表单的 action）。
- 图片由主 webview 直接加载（无 Referer 要求）；无需接入 img 代理热链域。

## 结构要点（2026-09-30 实测）

- 列表：`<ul class="col_3_1">` 内每个 `<li>` 是
  `<a class="ImgA" href="/comic/{slug}.html" title="{标题}">`（封面在 `<picture>` 的 `<img src>`）、
  `<a class="txtA" …>`（标题）、`<span class="info">`（列表页是更新日期，首页「最近更新」位是最新话链接）。
- 详情：`<div class="pic" id="Cover">` 封面；`<h1>《标题》</h1>`（书名号需剥）；作者与题材都在
  `<p class="txtItme">`（作者是 h1 之后第一个，题材是含 `/comics/{名}` 链接的那个）；
  状态在 `<span class="date">`（连载中/已完结）；简介在 `<p class="txtDesc autoHeight">介绍:…</p>`。
- 章节页：`<img width="728" data-src="{图片}" data-index="N" alt="…">`，按 `data-index` 取，
  站内 logo 与统计像素图不带该属性。
