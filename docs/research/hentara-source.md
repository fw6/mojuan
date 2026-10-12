# Hentara hentara.com 源 — 实现状态与验证指南（2026-09-30，2026-10-12 改按源文档）

## 状态

Hentara（英文成人韩漫站）的解析规则是一份**源文档**：源仓库 `fw6/cimoc-sources` 的
`sources/hentara.json`，应用仓库 `desktop/crates/mojuan-core/src/js/sources/hentara.json`
是同一份（回归数据）。内置源只有 webtoons 一个，hentara 由用户从设置页的「漫画源」目录安装。

**全链路已在本环境真网验证通过**：搜索「harem」12 条 / 分类「全部」24 条 / 详情 14 话 / 首话
14 张图。站点与数据 CDN 都无 IP 风控，普通 HTTP 客户端即可抓取。

该站前端是 Vite SPA + 构建期 Puppeteer 预渲染，另有**站点自带的静态 JSON 数据接口**
（`cdn.hentara.com/data`）——文档直接用它，与站内浏览同源数据，省掉 HTML 解析：

| 用途 | 接口 |
|---|---|
| 全站目录（搜索在文档的钩子里过滤） | `data/index.json`（1588 部：title/slug/thumbnail_url/episode_count/latest_episode/updated_at） |
| 详情 | `data/comics/{slug}.json`（comic + episodes + total_episodes） |
| 章节图片 | `data/episodes/{slug}/{话数}.json`（pages[].image_url） |

分类走预渲染 HTML 的列表页（每页 24 部卡片）；阅读器图片（`cdn.hentara.com`）无热链校验，
直接加载，无需 img 代理。

实现：
- `sources/hentara.json` — 源文档（五 op；`search` 的 `items` 是钩子，见维护注意）
- fixture：`tests/fixtures/hentara-{index.json,browse.html,genre.html,detail.json,episode.json}`
  （目录 fixture 是从真网 110KB 的 index.json 裁剪出的 3 部样本）

测试：`cargo test -p mojuan-core --test source_doc_test`（真 QuickJS + 真 scraper 跑每份文档）与
`npx vitest run crates/mojuan-core/src/js/source-docs.test.js`（node 侧共享驱动）都覆盖这个源。
真网：

```bash
cd desktop
cargo test -p mojuan-core --test live_smoke -- --ignored hentara
# hentara detail: N 章；首章 M 张图
```

## 维护注意

- **搜索是本地过滤**：站点的服务端渲染对 `/browse?search=` 不做过滤（返回未过滤的整页），
  站内搜索实际由前端在 `index.json` 上做。文档照做：`search` op 抓 `index.json`，`items` 用一段
  钩子按标题子串过滤（大小写不敏感）、按 `updated_at` 倒序排、截 60 条（避免宽泛关键词把上千部
  灌进列表页）；字段（title/intro/cover/lastChapter）仍走声明式，钩子只给出单元列表。
- **分类是预渲染 HTML**：`/browse`、`/popular-manhwa`、`/latest-manhwa`、`/uncensored-manhwa`、
  `/hottest-manhwa`、`/hentai-read`，以及题材页 `/genres/{slug}-manhwa`（12 个，见文档的
  `categories`）。列表分页与筛选是前端行为，服务端对 `?page=` 不生效——所以每个分类给的是首页 24 部。
- **卡片有三种形态**（`ssr-card` / `pg-card` / `genre-card`），但锚统一是 `href="/manhwa/{slug}"`，
  标题容器类名是 `{形态}-card-title`；文档按这三种类名依次取，取不到再退回 `img alt`。
  章节链接是 `/manhwa/{slug}/chapter-N`，带斜杠，文档按此把章节锚排除在漫画卡片之外。
- **话数 = 章节 JSON 的文件名**（`episodes/{slug}/{episode_number}.json`），episode_number 同时
  作为 `Chapter.index` 与 images 的 chapterIndex，可重建。
- **列表页封面有两种 CDN 前缀**：`cdn.hentara.com/{slug}/thumbnail.*`（browse/home）与
  `cdn.hentara.com/data/{slug}/thumbnail`（题材页，无扩展名）。文档按页面给出的 URL 原样返回。
- **详情 JSON 的 `genres` 大多为空数组**（1588 部里只有 6 部带题材标签），题材筛选因此走
  题材列表页而不是目录过滤。

## 结构要点（2026-09-30 实测）

- 列表卡片：`<a href="/manhwa/{slug}" class="pg-card"><img src="…"><div class="pg-card-title">{标题}</div>
  <div class="pg-card-meta">{N} chapters</div></a>`（`ssr-card` 用 `<span>`、`genre-card` 用
  `<div class="genre-card-title">`，其余同构）。
- 详情 JSON：`{"comic": {slug,title,description,thumbnail_url,cover_url,…},
  "episodes": [{episode_number,title,thumbnail_url,…}], "total_episodes": N}`；
  话标题常为空串，文档用 `Chapter {N}` 兜底。
- 章节 JSON：`{"episode": {…}, "comic": {…}, "pages": [{page_number, image_url}],
  "navigation": {prev_episode, next_episode, total_episodes}}`。
