# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

墨卷的主形态是 Tauri v2 桌面应用（macOS / Windows / Linux），移动端（iOS / Android）为后置里程碑，两者共享同一套 React 前端与 Rust 核心；窄屏（<768px）走移动端布局。

## Users

中文漫画读者：同时在多个漫画源追更，需要在手机与电脑之间延续同一份阅读进度；会离线保存章节，在地铁、飞机等没有网络的环境里继续读。

## Product Purpose

把多个漫画站点聚合到一个阅读器里：一个书架、一份进度、一次下载。成功意味着读者不需要记住哪部作品在哪个站点，也不需要为换设备重新找进度。

## Positioning

源（source）是一份运行时可更新的爬虫脚本，与 app 本体分离分发：站点改版时更新脚本即可，不必重新发布应用。带 JS 挑战或 TLS 拦截的源通过宿主侧不可见 webview 的渲染通道取页面，因此能覆盖普通 HTTP 客户端取不到的站点。

## Operating Context

- 每部作品以（source, comicId）唯一标识；章节以源内序号 chapterIndex 标识。
- 阅读形态是无限滚动（卷纸流）：章节内连续滚动，滚到话末自动加载下一话。
- 阅读位置由应用自动记录（当前章节 + 话内位置），重进阅读器即恢复。
- 进度、收藏、历史可备份到读者自己的 WebDAV；下载目录按「源/作品/话/页」分目录存放。
- 外链章节（内容托管在站外）一律过滤，不出现在章节列表，也不进入「下一话」。

## Capabilities and Constraints

已实现：源列表与分类浏览、关键词搜索、详情与章节列表、无限滚动阅读器、收藏与历史、多任务下载队列与离线阅读、源脚本手动更新（版本对比 + sha256 校验）、WebDAV 备份恢复、移动端全屏阅读（隐藏系统栏）、Windows/Linux 自动更新。

约束：

- 桌面端的图片热链必须经本机图片代理带上 Referer（macOS/Linux 无法给 `<img>` 注入 Referer）。
- 源脚本运行在 Rust 核心的嵌入 JS 运行时里，解析规则与网络取数分离。
- macOS 端不提供自动更新（ad-hoc 签名的包过不了 Gatekeeper 整体替换）。

## Brand Commitments

- 产品名 墨卷，署名 "Created by Deerflow"。
- 界面语言为中文。
- 应用图标是一张水墨侧脸（江南女子的形态：柳叶眉、低垂的杏眼、挽起的髻），通体只有墨与纸；源文件 `apps/mojuan/src-tauri/icons/app-icon.svg`，规范见 `DESIGN.md` 的「App Icon」。

## Evidence on Hand

- 领域术语与产品定案：`GLOSSARY.md`（术语来源：原 Lynx 产品约定 + wayfinder grilling 定案）。
- 各源的结构笔记与验证方法：`docs/research/`。
- 架构与命令约定：`AGENTS.md`、`docs/agents/`。

## Product Principles

1. 阅读不中断：滚动、进度、下一话加载都应无声完成，不向读者索取操作。
2. 源可以坏，应用不能假：源解析失败时如实报错，不伪装成空列表。
3. 离线是一等公民：下载下来的章节，在没有网络时与在线阅读体验一致。
4. 数据属于读者：收藏、历史、进度可以完整导出到读者自己的存储。
5. 更新源不必更新应用：源脚本与本体分离发布。
