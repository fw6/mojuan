# 前端（desktop/src）

Tauri v2 + React 19 + Vite 的前端。UI 由 Tailwind CSS v4 与 beui 组件构成。

## 样式与设计系统

- 设计令牌与全局基础样式：`desktop/src/styles/beui.css`（唯一的全局样式表，`main.tsx` 引入）。
  - 语义化颜色令牌（`--background` / `--foreground` / `--card` / `--primary` / `--muted-foreground` / `--border` …）在 Tailwind v4 的 `@theme inline` 里映射成 `bg-card`、`text-muted-foreground` 这类工具类。
  - 浅色写在 `:root`，深色写在 `[data-theme="dark"]`；主题由 `src/lib/theme.tsx` 的 `applyTheme()` 写 `html[data-theme]`。深色变体用 `@custom-variant dark` 绑定到该属性，不跟随系统 `prefers-color-scheme`。
  - 玻璃表面用 `.glass` / `.glass-strong` / `.glass-thin` 三个工具类；滚动条、选区、焦点环、安全区内边距都在这里统一定义。
- 设计系统的完整说明（配色、字体、圆角、动效、组件规范）：仓库根 `DESIGN.md`；机器可读令牌在 `.impeccable/design.json`。改配色或加组件前先看这两份。
- 字体是系统字体栈（中文界面用 PingFang SC / 微软雅黑），不引入网络字体。

## beui 组件

- 组件源码在 `desktop/src/components/beui/`，内部工具在 `desktop/src/lib/`（`utils.ts` 的 `cn`、`ease.ts` 的动效令牌、`hooks/`）。这些文件是上游源码的副本，`@/` 前缀指向 `src/`（vite.config.ts 的 alias + tsconfig paths）。
- 更新或新增组件：编辑 `desktop/scripts/fetch-beui.mjs` 的 `FILES` 清单，然后 `node scripts/fetch-beui.mjs`。脚本按清单精确写入，不会带进用不到的兄弟文件。
  - 脚本会自动应用两处适配（写在 `PATCHES` 里）：`theme-toggle` 的 `next-themes` 换成 `lib/theme`；`button/base` 导出类名映射，供 `LinkButton` 复用按钮样式。**不要手工改这两处**，会被重跑覆盖。
  - 组件目录：<https://beui.dev/llms.txt>，registry 索引 `https://beui.dev/r`。
- 应用自己的界面原语在 `src/components/ui.tsx`（封面、卡片、列表行、空状态、面板、进度条、`LinkButton`），页面直接组合这些与 beui 组件。

## 断点

窄屏断点是 **767px / 768px** 一条线，三处必须一致：

- `src/lib/platform.ts` 的 `MOBILE_QUERY`
- Tailwind 的 `md:`
- beui 侧边栏内部的 `MOBILE_QUERY`

## 移动端外壳与导航

- 窄屏只在主导航页面上有一条导航：`src/components/shell.tsx` 的 `NavRail`（beui `overflow-actions` 药丸栏），二级页面（作品详情）不渲染它——退出靠顶部栏的返回。发现、书架常驻在栏里，下载、设置收进「…」，当前页落在溢出组时自动展开一次。桌面侧边栏与它共用 `src/lib/nav.ts` 的 `NAV`；改导航结构要同时看这两处与 `RAIL_PRIMARY` / `RAIL_OVERFLOW`。
- 主导航页面（发现 / 书架 / 下载 / 设置）不渲染顶部栏，页头（`ui.tsx` 的 `PageHeader`）也不再写页面名——导航已经标出当前页，视觉上只留一行副标题与右侧动作，页面名以 `sr-only` 留给读屏；子页面（作品详情）才有「返回 + 标题 + 搜索」，由 `TopBar` 渲染。阅读器是沉浸模式，整条导航壳都不渲染。
- 状态栏高度统一由 `AnimatedSidebarInset` 的 `padding-top: env(safe-area-inset-top)` 让出，页面自己不要再加；底部安全区有导航栏时栏自己让（`max(…, env(safe-area-inset-bottom))`），二级页面没有栏，由外壳按同一变量补 `padding-bottom`。
- 主题切换入口只有设置页（`src/lib/theme.tsx` 的 `useTheme` + `Switch`）；命令面板与外壳里都没有主题按钮，加回会在设计上出现第二个入口。

## 页面保留（切页不丢状态）

路由切换保留页面状态（等价 Vue 的 `<KeepAlive />`）：`src/components/keep-alive.tsx` 的 `KeepAliveRoutes` + `src/App.tsx` 的 `PAGES` 路由表。

- 每个页面占一个槽位（`[data-page]`）：槽位自己就是滚动容器，并把自己的滚动容器经 `ScrollContainerContext` 给页面用。非当前页用 `display: none` 藏起来——组件状态、DOM、滚动位置都留着，同时移出无障碍树与 Tab 顺序。
- 实例按完整路径区分（同一路由的不同作品各占一个槽位，各自读自己那次导航的参数）；`keep` 是每个路由的实例上限，按最近使用淘汰：主导航四条各 1 个，详情页 5 个，阅读器 `keep: 0`（图片与虚拟列表占用大，离开即卸载）。
- 滚动位置在离开的瞬间读一次（浏览器会把隐藏容器的位置归零，滚动事件不一定来得及派发），显示时写回；内容还没铺满时会在随后的帧里补。
- `AppShell` 只有一棵常驻布局树：沉浸模式（阅读器）只是不渲染导航壳，页面区始终在同一位置，切进切出不会卸载保留的页面。所以滚动容器不再由壳提供，改由每个槽位提供。
- 页面要能忍受 effect 被重放：React 在开发期（StrictMode）会在隐藏的子树重新显示时销毁并重跑它里面所有 effect。取数据的 effect 不要顺手把用户状态清掉（取数走 `useCrawl`，它用内部 ref 记住「这个请求已经取过」，重放时直接跳过；`reload()` 照常工作）。

验证走 `probe-app.mjs`：`[data-page]` 上的 `style.display` 看哪个页面是当前页，`scrollTop` 看位置是否还原，DOM 节点身份可以确认实例有没有被重建。

## 发现页的源选择

切换源是低频操作：源列表收在页头右侧的「当前源」按钮后，点击打开底部面板（`src/components/source-sheet.tsx`，beui `BottomSheet`；两端同一形态——贴底、居中限宽 672px）。面板里每个源一行，当前项用蓝色 12% 底与勾选标记，该源最近一次抓取失败时行内标出「上次加载失败」（打开面板时经 `sourceErrors()` 取一次）。打开时焦点落在当前源行，关闭（选择 / Escape / 点遮罩）后回到页头按钮。分类 tab 留在页面上：切分类是高频操作。面板组件来自 beui registry（`fetch-beui.mjs` 的 FILES 清单），可访问名已用 PATCHES 改为中文。

浏览位置持久化：选中的源与每个源停留的分类写在 settings 域（`lastSource` / `lastCategory`，经 `rememberDiscovery()` 一次写入，避免两次读改写互相覆盖），重启后恢复。`Sources` 组件分两层——外层等 `whenSourcesReady()` 完成后读回这两个值再渲染（源清单由源注册表填充，就绪前为空），免得开局按默认源拉一次列表又立刻切走；内层是原来的 `Discovery`。URL 上的 `?source=`（命令面板跳转）优先级最高，且在页面已挂载时也跟随变化。记忆的分类在该源上已不存在时退回第一个分类。

## 源清单与按源事实（`src/lib/sources.ts`）

源清单（`SOURCES`，顺序 = 源注册表的注册顺序，首个为默认源）与图片热链对都来自 Rust 侧的源注册表：`initSources`（`whenSourcesReady` 的实体）经 `bundled_sources` 取回后调 `applyBundledSources` 填充，显示名优先取已装源的 `name`（源仓库可改名）。前端不再按源硬编码任何东西——加源、改热链域名、改显示名都只改 `crawler/sources/` 的那个文件。

- 消费方（源面板、命令面板、`sourceTitle`）都排在 `whenSourcesReady()` 之后；就绪前 `SOURCES` 是空数组。
- `api.ts` 的 `imgSrc(value, {source, comicId})` 经 `hotlinkRefererFor(url)` 按 URL 子串查热链对：热链域、带了 `source+comicId` 的阅读页、以及本地路径都重写为本机代理 `/img`，其余（列表封面）保持直连；`Detail.tsx` 的下载 Referer 取 `sourceReferer(source)`（该源声明的第一条）。
- 源进程内缓存的持久化是通用协议：`cache_dump`/`cache_hydrate` 对任意源都可用，没有持久缓存的源 dump 出空对象。`persistSourceCache(source)` 由 `useCrawl` 在每次抓取成功后调用，`hydrateSourceCaches()` 在启动时回灌（存储域 `sources-cache.json`，按 sourceId 存）。

## 发现页的分类与搜索

分类浏览与搜索是两种模式，同一时刻只有一种在屏上（`Sources.tsx` 的 `inSearch`）：浏览模式渲染分类 tabs（beui Tabs 的 `segment` 变体）与当前分类的列表；搜索模式把 tabs 整块换成搜索头（搜索图标 + 「搜索 “关键词”」+ `N 部作品` + 退出按钮），下面是搜索结果。两者是不同的请求键，结果不会互相冒充；`exitSearch()` 回到搜索前停留的分类并清空输入框。切源会退出搜索（新源的分类与旧源的搜索结果无关）。

选中的分类与已提交的搜索都连同「属于哪个源」一起记（`picked` / `search`），切源时按源推导出「还没选」，页面不需要为切源写清空逻辑；分类表到达后为该源选一次分类（优先该源上次停留的，否则第一个），网络结果后到时不再改选。

beui registry 里没有可用于远程搜索的现成组件：`morphing-search` 与 `combobox` 都是「`items` 先给全量、组件内部按关键词过滤」，`infinite-masonry` 是瀑布流，形态与数据流都对不上，所以搜索头是应用自己组装的（`ui.tsx` 之外，直接用 Tailwind 与令牌）。

## 存储层（`src/lib/storage/`）

按存储域一个文件：`store.ts` 是底层（桌面 store 插件与移动端 fs 的平台切换、每文件一个 Store 实例、跨域键规则 `comicKey`），`fs.ts` 是移动端实现（接口与 `@tauri-apps/plugin-store` 的 IStore 一致），上面是 `progress.ts`、`history.ts`、`favorites.ts`、`settings.ts`、`sources.ts`（已装源 + 源脚本同步单例 `whenSourcesReady` + 源进程内缓存的持久化）、`backup.ts`（WebDAV 备份/恢复，跨收藏、历史、进度三域读）。每个域一个 JSON 文件（`store.ts` 的 `FILES`），消费方按域直接导入，没有统一出口。

## 数据加载与结果缓存（stale-while-revalidate）

列表与详情的抓取结果由 Rust 侧缓存（`crawler/result_cache.rs`，见 `docs/agents/mojuan-core.md`），
前端取数一律走 `useCrawl(op, source, payload, opts)`（`src/lib/hooks/use-crawl.ts`）：两段式加载、
新鲜窗口、空结果保留、错误呈现与源进程内缓存的回灌都收在这一个 module 里，页面只拿
`{data, loading, stale, error, reload}`。它按顺序做三件事：

- 先 `await whenSourcesReady()`（`lib/storage/sources.ts` 的源脚本同步单例，registry 未就绪时脚本源的
  op 会返回空结果）；
- 再 `crawlCached(op, source, payload)` 读缓存（不触发网络，未命中返回 `null`），有就立即渲染；
- 最后 `crawl(op, source, payload)` 拉最新并覆盖，Rust 侧把成功结果写回缓存。

策略由调用点用 `opts` 声明：`maxAge` 是新鲜窗口，窗口内的缓存直接收工、不发请求（发现页的列表传
2 分钟，来回切源不重复拉取；分类与详情传 0，每次都拉最新——渲染源的章节中转链依赖 detail 的
post_process 写入进程内缓存，baozimh 的 images 依赖它）；`enabled` 为 false 时不发请求。请求键是
`op` + `source` + 序列化后的 payload，键变了才重新取：缓存命中直接替换，未命中清空 `data`、由页面
显示自己的加载态。

错误呈现也在这里：抛出的错误优先，没有抛出但结果为空时取源错误登记表（`sourceErrors()`）里该源的
最近一条首行，结果非空时不挂旧错误。`loading` 覆盖整次抓取，`stale` 表示「数据来自缓存、后台正在
拉最新」，页面用 `loading && !stale` 决定压暗与禁用，后台刷新不挡操作。

## 阅读器的分页策略

`src/screens/Reader.tsx` 里每一页是「先占位、后收缩」：

- 未加载页用 `estimatePageHeight()` 预留高度（阅读列宽度 × 该源已加载页面的实测中位宽高比，`ratioSamples` 按源记忆）；比例变化小于 5% 不重建布局。
- 图片 `width: 100%; height: auto`，加载完成后释放预留高度。
- 长列表靠 `@tanstack/react-virtual` 虚拟化，滚到话末自动加载下一话（跨话连续）。

预取：虚拟器的 `overscan` 按**视口上下各两屏**换算成页数（`PREFETCH_SCREENS`，长条漫一页就超过两屏所以下限 1，上限 8）。挂载范围就是预取范围，挂载到的页一律 `loading="eager"`——浏览器自己的 `lazy` 只提前约一屏，会把已经挂载好的后两屏又压回「滚到才取」。下一话的触发同样按两屏算（`nearBottomByPx`，按像素而不是滚动比例，长条漫与常规页才都合适）。

阅读位置：记录与恢复都在 `src/lib/hooks/use-reader-position.ts`（`useReaderPosition`），组件只把滚动容器、虚拟器适配面（`src/lib/reader-virtualizer.ts` 把 `measurementsCache` 转成 `sizes()` / `entryAt()` / `scrollToOffset()`，稀疏空洞在那里归 0）、已加载页、章节列表与作品交进去，拿到一个 `record()`。进度记录的是「话内第几张图 + 图内位置」（`ProgressRecord` 的 `pageIndex` / `offsetInPage`，按视口中心算），恢复时把那一处放回视口中心（页面列表就绪后滚一次，容器还没铺开时等下一帧）。用页码而不是整话比例，是因为比例乘的是「实测 + 估算」混合的整话总高，两次会话的混合构成不同会落到相邻的页上；页码在两次会话里指向同一张图（恢复与虚拟器渲染读的是同一份 `measurementsCache`）。图内位置要留：长条漫一页好几屏，只记页码会跳很远。每个实例只恢复一次，跨话连读追加的页不会再把人拽回旧位置。写进度与记历史分开：`record()` 只写进度，历史由滚动回调补一次，且只记元数据有真实标题的条目。

## 阅读器的数据来源（含已下载章节的离线阅读）

两条入口共用同一个 `Reader`：`/reader/...`（详情页的「继续阅读」与章节块）与 `/local/...`（书架「下载」tab，`local` 为真）。章节表与页面按「手头有什么用什么」取：

- 章节表：`local` 模式只认下载目录；其余先读结果缓存（详情页每次进都刷新它，所以离线进阅读器也立刻有带标题的章节表），缓存没有但这部作品有下载就用下载清单（元数据合成，`syntheticComicRef` 标记），都没有才联网拉详情（渲染源的章节中转链也靠这次抓取），联网也失败才算首屏失败。
- 页面：下载清单里有这一话就直接读磁盘上的页（原图 URL 优先，旧数据回落到 `chapter_<n>/<file>` 相对路径），否则走 `images` op；一个地址都取不到按加载失败处理（离线且这一话没下载就是这样），不留空画布。
- 取图统一走 `imgSrc(page.url, {source, comicId})`：代理先查下载索引读本地文件，未命中才联网。所以「已下载的话」在线时也读磁盘，断网时照常可读。
- 历史只在章节表有真实标题时写：下载目录兜底时标题只有话序号，历史 tab 保持链在线 reader（wayfinder #19 的口径）。

端到端核对（应用在跑）：`node scripts/verify-offline-reading.mjs` 造一份指向不存在域名的假下载数据，确认 `/local/...` 与 `/reader/...` 两条入口的图片都从磁盘渲染出来；`node scripts/verify-online-reader-network.mjs` 确认真实作品的在线阅读没被改坏。

恢复的触发不能挂在虚拟器的 `onChange` 上：页面数变化时 `getVirtualIndexes` 会把 `maybeNotify` 的依赖同步掉，`_willUpdate` 在滚动元素没换时也不通知，`onChange` 可能整场不触发。判断内容是否铺开看虚拟器给出的页（`entryAt()` 量不到时返回 null，等下一帧）；虚拟器的 `itemSizeCache` 只装测量值与估算不同的页，源比例学准之后实测与估算一致，这个 Map 一直是空的，所以它不能用来判断「有没有测量过」——跨话预取的守卫因此改成「至少一张图 `onLoad` 过」（`imageLoadedRef`）。

改这里时注意：预留高度参与虚拟器测量，测量值异常会直接表现为滚动跳动；`estimateSize` 与页面单元的 `minHeight` 必须用同一个估算值。

## 阅读器的沉浸层

阅读页是全局唯一一处暗底（DESIGN.md 的「Colors / Reader」）：画布、顶栏、占位、按钮都取 `reader` 令牌，不混用中性令牌。顶栏是浮在画布上的浮层（不占阅读高度），向下滚动时位移 8px 并淡出，向上滚动、回到顶部或点击画面时回来；鼠标静止 2 秒隐去指针。方向判定用 `scrollTop` 的增量加死区（`SCROLL_DIRECTION_SLOP`）。

顶栏位移用的是 Tailwind v4 的 `translate` 工具类，它写的是 CSS `translate` 属性而不是 `transform`——过渡属性要写 `transition-[opacity,translate]`，写成 `transform` 的话位移会瞬间跳变。

## 验证桌面界面（不使用截图）

应用内跑着 `tauri-plugin-mcp-bridge`（WebSocket 127.0.0.1:9223），可以用 `desktop/scripts/` 下的两个脚本在运行中的应用里读 DOM 与计算样式：

```bash
npm run tauri dev                       # 另开一个终端
node scripts/probe-app.mjs 'return document.body.innerText'
node scripts/probe-app.mjs --resize 420x820   # 切到移动端宽度再读一遍
node scripts/audit-contrast.mjs               # 逐路由扫文字对比度（深浅两套主题）
```

界面状态的判断走结构化文本（DOM、计算样式、可访问属性），不要用截图判断布局。改了配色或文字层级之后跑一次 `audit-contrast.mjs`。
