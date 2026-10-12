# Copymanga 拷贝漫画 源 — 实现状态与验证指南（2026-08-18，2026-10-12 改按源文档）

## 状态

Copymanga（拷贝漫画）的解析规则是一份**源文档**：源仓库 `fw6/cimoc-sources` 的
`sources/copymanga.json`，应用仓库 `desktop/crates/mojuan-core/src/js/sources/copymanga.json`
是同一份（回归数据）。内置源只有 webtoons 一个，copymanga 由用户从设置页的「漫画源」目录安装。

来源提交（当时还是源脚本形态）：

- `911f9ee` 功能实现（源脚本 / Rust 接线 / 前端接入 / 5 fixture / 双轨测试）
- `fc1e724` Rust 网络层本地 mock 集成测试
- `68c5bac` 可诊断 live 冒烟测试

实现：
- `sources/copymanga.json` — 源文档（四 op；章节走两步请求，见维护注意）

测试：`cargo test -p mojuan-core --test source_doc_test`（真 QuickJS + 真 scraper 跑每份文档）、
`npx vitest run crates/mojuan-core/src/js/source-docs.test.js`（node 侧共享驱动）与
`cargo test -p mojuan-core` 里的本地 mock 集成测试都覆盖这个源；真网冒烟
`copymanga_live_search` 通过。

## 真网验证（待在家用网络执行）

```bash
cd desktop
cargo test -p mojuan-core --test live_smoke -- --ignored copymanga_live_detail_and_images
```

覆盖 detail → 章节 → 图片全链路。**预期**：打印 `copymanga detail: N 章；首章 M 张图` 并通过。

**若失败**：测试的 panic 消息会打印 mojuan-core 记录到的源错误。区分两类原因：
- 错误含 `fetch(detail): HTTP ...` 或 detail 为空且消息提示被风控 —— Copymanga IP 级风控拦截（comic2 返回 `results:null` 或 `code 210`「检测到破解版 APP，等待1小时自动解除」）。**只影响数据中心/被标记 IP**，家用住宅 IP 不受此封锁。
- 其他错误 —— 按 panic 消息排查，可能是解析/字段问题，回报即可。

> 注意：本仓库开发机公网 IP 为数据中心段（如 103.158.14.153），被 Copymanga 风控；家用网络不受影响。本实现无法从该环境验证 detail 真网链路，仅能离线（fixture + mock）与交叉验证（两个开源 copymanga 下载器）保证结构正确。

## 维护注意

- **API 域名轮换**：Copymanga 域名频繁更换（曾用 mangacopy.com / copy3000.com / copymanga.site 等）。
  当前默认 `https://api.mangacopy.com`（源自官网 www.mangacopy.com，搜索/列表/分类已实测）。
  域名失效时改文档的 `base` 一处即可。
- **请求头配方**：`platform: 3` / `version: 3.0.0` / `hc-lang: zh-hans` 为本主机所需（缺省或
  platform=1+Chrome UA 返回空/210）。`version` 若被要求升级，更新文档的 `headers`。
- **章节两步请求**：`detail` 先取 `comic`，再用 `feed`（`group=default`）拿章节表；
  `images` 先取 `feed` 再按章节 uuid 取 `chapter`（uuid 由 `array` 在 feed 里按章节号匹配取出）。
- **章节上限**：feed 单次 `limit=1000`（超长连载截断；开源下载器同样限 500）。取默认「正序」翻译组
  （group=default），多翻译组漫画仅正序组。
- **风控**：detail/章节/图片端点对数据中心 IP 有信誉封锁（临时，1 小时自动解除）。家用住宅 IP 正常。
