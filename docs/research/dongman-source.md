# 咚漫 dongmanmanhua.cn 源 — 实现状态与验证指南（2026-08-19，2026-10-12 改按源文档）

## 状态

咚漫（中文 Webtoon 官方站）的解析规则是一份**源文档**：源仓库 `fw6/cimoc-sources` 的
`sources/dongman.json`，应用仓库 `desktop/crates/mojuan-core/src/js/sources/dongman.json`
是同一份（回归数据，见 [mojuan-core 约定](../agents/mojuan-core.md)）。内置源只有 webtoons 一个，
咚漫由用户从设置页的「漫画源」目录安装。

**全链路（搜索 → 详情 → 章节 → viewer → 图片）已在本环境真网验证通过**——咚漫不做 IP 风控，数据中心 IP 可正常访问。

实现：
- `sources/dongman.json` — 源文档（五 op）
- fixture：`tests/fixtures/dongman-{search,detail,viewer}.html`

测试：`cargo test -p mojuan-core --test source_doc_test`（真 QuickJS + 真 scraper 跑每份文档）与
`npx vitest run crates/mojuan-core/src/js/source-docs.test.js`（node 侧共享驱动）都覆盖这个源。

## 真网验证

```bash
cd desktop
cargo test -p mojuan-core --test live_smoke -- --ignored dongman
```

**预期**：`dongman_live_search` 与 `dongman_live_detail_and_images` 都通过，打印
`dongman: N 条，首条 dongman-xxxx / 标题` 与 `dongman detail: N 章；首章 M 张图`。
本环境 2026-08-19 实测已通过。

**若失败**：多为外网站点结构变动，按 panic 消息排查；咚咚漫无 IP 风控，家用网络应与本机一致。

## 维护注意

- **URL 形态**：搜索 `/search?keyword=`；分类 `/{GENRE}`（10 个 genre 码见文档里的 `categories`）；
  详情用 `/episodeList?titleNo=N`（301 到 `/{GENRE}/{group}/list?title_no=N`，http 客户端自动跟随）。
- **章节 viewer URL 不可重建**（含中文 slug）：`images` op 发两步请求——先取 `/episodeList`，用
  `vars.viewerUrl` 里的 `array`（按 `episode_no` 匹配 `{chapterIndex}`）取出该话的 viewer URL，
  再取这一步（见文档里 `images.request`）。
- **图片**：`cdn.dongmanmanhua.cn`，无需登录；前端 imgSrc 已重写经本机代理带 Referer（站点根）拉取
  （热链对在文档的 `hotlinkReferers`）。
- **免费章节**：部分章节付费（咚币），详情页「免费」章节可读；付费章节可能打不开（服务端行为，非代码问题）。

## 结构要点（2026-08-19 实测）

- 搜索/分类卡片：`<ul class="card_lst"><li id="title_li_{N}" data-title-no="{N}">` → `a.card_item` →
  `.subj`（标题）/`.author`（作者）/img cover。**注意首页分类榜单的 `<li>` 无 `data-title-no`**，
  文档按 `li[data-title-no]` 定位。
- 详情章节：`<ul id="_listUl"><li id="episode_{M}" data-episode-no="{M}">` → `a[href*=/viewer?]`、
  `.subj span`（标题）/`.date`。
- 阅读页图片：`<img class="_images _centerImg" data-url="https://cdn.dongmanmanhua.cn/…">`（排除 `_thumbnailImages`）。
