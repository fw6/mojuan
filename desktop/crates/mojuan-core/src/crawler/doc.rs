//! 源文档：一个源的全部事实与取数规则（[ADR-0002](../../../../docs/adr/0002-source-definition-as-document.md)）。
//!
//! 本模块是文档格式的**唯一定义处**：Rust 结构体既做校验（`deny_unknown_fields` 拒绝写错的键名），
//! 又经 `schemars` 生成 JSON Schema（供编辑器补全与源仓库提交时检查）。解释由 `js/runtime.js`
//! 完成（见 `crawler/script.rs` 的 op 流程）。
//!
//! 文档的取值规则统一写成 [`Extractor`]：字符串简写是选择器（HTML 选择器或 JSON 路径），对象
//! 写法覆盖属性、回退、过滤、变换、条件、语言映射与数组查找。字段值是单个 extractor 或它的
//! 有序回退链（[`Field`]）。
//!
//! 一个 op 可以按顺序发多次请求（[`RequestStep`]）：后一步的 `url` 可以用 `vars` 里从**前面**
//! 步骤的响应中取出的值。跨 op 携带的值（webtoons 的系列 URL、baozimh 的章节中转链）由 `hidden`
//! 声明，运行时把它从输出里剥掉交给宿主缓存，后续 op 经 ctx 取用。

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// 当前文档格式版本。解释器拒绝 `schema` 大于本值的文档。
pub const SCHEMA_VERSION: u32 = 1;

/// 模板链：一个模板，或有序的模板数组（取首个求值非空的）。模板里任一占位求值为空则整条作废。
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum TemplateChain {
    One(String),
    Many(Vec<String>),
}

impl TemplateChain {
    pub fn as_slice(&self) -> &[String] {
        match self {
            TemplateChain::One(s) => std::slice::from_ref(s),
            TemplateChain::Many(v) => v,
        }
    }
}

/// 字段取值：一个 extractor，或它的有序回退链（首个非空获胜）。
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum Field {
    Chain(Vec<Extractor>),
    One(Extractor),
}

/// 取值规则。字符串简写 = 选择器；对象写法的各键见字段说明。
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum Extractor {
    /// 选择器简写：HTML 选择器（`h1.subj`）或 JSON 路径（`attributes.title`）。
    Select(String),
    Spec(Box<ReadSpec>),
}

/// 取值规则的完整写法。`select`/`find`/`default`/`fromChapter`/`template` 至多一个。
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadSpec {
    /// HTML 选择器或 JSON 路径，相对当前作用域；缺省 = 当前作用域自身。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub select: Option<String>,
    /// 作用域换成某个请求步骤的响应（用于多步请求里从前面步骤取值）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    /// 取该元素的属性而非文本。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attr: Option<String>,
    /// `first`（默认）或 `last`：多个匹配时取首个或末个。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pick: Option<String>,
    /// 过滤器名（见 [`FILTERS`]）：不满足则算空值，回退链落到下一条。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter: Option<String>,
    /// 按序施加的变换名（见 [`TRANSFORMS`]）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub transform: Vec<String>,
    /// 字面模板：回退链全空时的兜底，可含 `{id}`/`{index}`/`{comicId}` 等占位。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    /// 在数组里查找取值（见 [`ArraySpec`]）：章节 id、封面文件名、作者、分类标签都是这个形状。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub array: Option<ArraySpec>,
    /// 条件取值：取值包含该子串时用 `then`，否则用 `else`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contains: Option<String>,
    /// 条件取值：取值等于该字面量时用 `then`，否则用 `else`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub equals: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub then: Option<String>,
    #[serde(default, rename = "else", skip_serializing_if = "Option::is_none")]
    pub r#else: Option<String>,
    /// 取值是 locale 映射时，按 en/zh/ja/ko 再任意键取。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub localized: Option<bool>,
    /// 取已产出章节数组的首/末项标题（`first` 或 `last`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_chapter: Option<String>,
    /// 模板拼接（`{item}` 是当前单元，其余名字从 vars/ctx/payload 解析）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    /// 局部变量：值为 extractor，作用域是当前取值处；供本规则的 template / default / then / else 使用
    /// （mangadex 的封面 URL 要拼漫画 id 与封面文件名，就是靠它）。
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub vars: BTreeMap<String, Extractor>,
    /// 单元定位的钩子（JS 源码）：只在 `items` 上有意义，整个单元列表由文档里的 JS 给出，
    /// 字段仍走声明式。它是「算法型源的出口」在单元定位上的形态（hentara 的本地搜索要在
    /// 全站索引上过滤排序）。写在别处一律被拒（见 [`check_items_extractor`]）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub script: Option<String>,
}

/// 数组查找：定位一个数组（HTML 用选择器，JSON 用路径），按 `key` 匹配（或不筛选），
/// 对每个命中取 `take`。
///
/// 覆盖 mangadex 的四种取值（章节 id、封面文件名、作者、分类标签）、copymanga 的
/// 「章节号 → uuid」与 dongman 的「章节号 → viewer URL」（后两处一个在 JSON 里、
/// 一个在 HTML 里，所以 `at` / `key` / `take` 都按当前作用域的种类求值）。
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArraySpec {
    /// 取某个请求步骤的响应作为作用域；缺省 = 当前作用域。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub in_step: Option<String>,
    /// 数组所在处：HTML 是选择器，JSON 是点分路径；缺省 = 作用域自身就是数组。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
    /// 参与比较的取值；缺省 = 元素自身的文本（「这一段里含某标记」这类判定）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<Field>,
    /// 期望值（模板，可含 `{chapterIndex}` 等占位）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub equals: Option<String>,
    /// 期望值包含该子串（与 `equals` 二选一）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contains: Option<String>,
    /// 取每个命中元素的什么（HTML 常是 `{"attr": "href"}`，JSON 是字段路径；可写回退链）。
    pub take: Field,
    /// `true`（默认）取首个命中；`false` 取全部。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first: Option<bool>,
    /// 取全部时跳过前面 N 个命中（baozimh 的 tag 列表首个是状态，其余才是标签）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skip: Option<u32>,
    /// 取全部时的连接符（缺省 `, `）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub join: Option<String>,
}

/// 一个请求步骤。后一步的 `url` 可以用 `vars` 里从前面步骤响应取出的值。
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestStep {
    /// 步骤名，op 内唯一；`parse` 按它读响应。
    pub name: String,
    /// URL 模板链；整链求值为空则不抓取这一步。
    pub url: TemplateChain,
    /// 响应体种类（缺省用 op 的 `input`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<String>,
    /// 覆盖/追加到文档级请求头。
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub headers: BTreeMap<String, TemplateChain>,
    /// 局部变量：值为 extractor，作用域是**前面**步骤的响应，供本步骤的 `url` 与 `headers` 使用。
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub vars: BTreeMap<String, Extractor>,
}

/// 一个 op 的取数规则。
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpSpec {
    /// 响应体种类：`html`（默认）或 `json`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<String>,
    /// 有序请求步骤；空数组表示该 op 不抓取（静态产出）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub request: Vec<RequestStep>,
    /// 重复单元的定位（search / category / images）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub items: Option<Extractor>,
    /// 每个单元的 id（search / category）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<Extractor>,
    /// 每个单元的字段（search / category）。
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub fields: BTreeMap<String, Field>,
    /// 单元数上限。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    /// 先切出区域再找单元（HTML）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    /// 单元过滤：该 extractor 取值为空的单元丢弃。
    #[serde(default, rename = "where", skip_serializing_if = "Option::is_none")]
    pub r#where: Option<Box<Extractor>>,
    /// 去重键；缺省按 id（列表）或 index（章节）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dedup_by: Option<Box<Extractor>>,
    /// 排序方向：`asc` / `desc`；缺省保持文档序。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sort: Option<String>,
    /// 详情页的漫画字段。
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub comic: BTreeMap<String, Field>,
    /// 详情页的章节表。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chapters: Option<ChaptersSpec>,
    /// 图片 op：每个单元取出的 URL（可写回退链，如 `data-src` 缺失时用 `src`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<Field>,
    /// 跨 op 携带的隐藏值：名字 → extractor。运行时把它从输出剥掉，交给宿主缓存，后续 op 经 ctx 取用。
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub hidden: BTreeMap<String, Extractor>,
    /// 整 op 的解析钩子（JS 源码）：文档表达不了的算法由它给出该 op 的最终值
    /// （manhuagui 的 `p.a.c.k.e.r` 解包）。请求照常按 `request` 发出，钩子拿响应自己算；
    /// 与它并存的取数键（items / comic / url / hidden 等）运行时不会读，一律被拒。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub script: Option<String>,
}

/// 章节表。
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChaptersSpec {
    /// 章节单元。
    pub items: Extractor,
    /// 单元过滤：该 extractor 取值为空的章节丢弃（manhuagui 只认带 title 的章节链接，
    /// 章节栏「更新至」的快捷链接没有 title）。
    #[serde(default, rename = "where", skip_serializing_if = "Option::is_none")]
    pub r#where: Option<Box<Extractor>>,
    /// 章节号；`position` 表示排序去重后的 1 起序号。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index: Option<Extractor>,
    /// 章节标题。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<Field>,
    /// 排序方向。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sort: Option<String>,
    /// 多键升序（按给定顺序比较，能解析成数就按数值比）；给了它就不看 `sort`。
    /// baozimh 的章节先按 section_slot 再按 chapter_slot 排，就是靠它。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sort_by: Vec<Field>,
    /// 去重键；缺省按 index。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dedup_by: Option<Box<Extractor>>,
    /// 非空则标记为外链章节。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external: Option<Extractor>,
    /// 章节上的隐藏值。
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub hidden: BTreeMap<String, Extractor>,
}

/// 图片热链对：CDN 域名 → 需带上的 Referer（图片代理与下载共用）。
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HotlinkReferer {
    pub domain: String,
    pub referer: String,
}

/// 静态分类条目。
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Category {
    pub label: String,
    pub url: String,
}

/// 一份源文档。
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceDoc {
    /// 文档格式版本，当前为 [`SCHEMA_VERSION`]。
    pub schema: u32,
    /// JSON Schema 的地址（编辑器补全用；校验时忽略）。
    #[serde(default, rename = "$schema", skip_serializing_if = "Option::is_none")]
    pub schema_uri: Option<String>,
    /// sourceId，与源仓库的键一致。
    pub id: String,
    /// 前端显示名（填入 `Comic.sourceTitle`）。
    pub title: String,
    /// 漫画 id 前缀：进入的 comicId 去掉它，产出的 id 加上它。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub id_prefix: String,
    /// 站点根，模板里可用 `{base}`。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub base: String,
    /// 命名常量，模板里可用 `{名}`。
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub vars: BTreeMap<String, String>,
    /// 基础请求头。
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub headers: BTreeMap<String, TemplateChain>,
    /// 按 op 覆盖/追加的请求头。
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub headers_by_op: BTreeMap<String, BTreeMap<String, TemplateChain>>,
    /// 图片热链对。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hotlink_referers: Vec<HotlinkReferer>,
    /// 整源是否经隐藏 webview 取页面。
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub render_channel: bool,
    /// 静态分类表：`categories` op 输出 label 列表，`category` op 的 URL 取命中条目的 url。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub categories: Vec<Category>,
    /// 各 op 的取数规则。
    pub ops: BTreeMap<String, OpSpec>,
}

/// 已支持变换的闭集（名字可带参数，如 `after:/comic/`）。
pub const TRANSFORMS: &[&str] = &[
    "trim",
    "collapse",
    "stripTags",
    "unescape",
    "absoluteUrl",
    "encode",
    "lower",
    "firstOn:",
    "after:",
    "before:",
    "digitsAfter:",
    "param:",
    "stripPrefix:",
    "stripSuffix:",
    "prepend:",
    "split:",
];

/// 已支持过滤器的闭集。
pub const FILTERS: &[&str] = &["imageUrl", "nonEmpty", "contains:", "startsWith:", "endsWith:"];

/// 前端会调用的 op（文档可以不声明，缺的 op 按空结果返回）。
pub const OPS: &[&str] = &["categories", "search", "category", "detail", "images"];

/// 协议级的缓存管理 op，由宿主处理，文档不声明。
pub const CACHE_OPS: &[&str] = &["cache_dump", "cache_hydrate"];

/// 模板里可以出现的名字（除文档声明的 vars 与 hidden 之外的内建名字）。
const BUILTIN_PLACEHOLDERS: &[&str] = &[
    "base",
    "idPrefix",
    "itemId",
    "categoryUrl",
    "keyword",
    "comicId",
    "chapterIndex",
    "label",
];

impl SourceDoc {
    /// 解析并校验一份文档。任何结构性或语义性错误都在这里报出（fail-fast，不进 registry）。
    pub fn parse(json: &str) -> Result<Self, String> {
        let doc: SourceDoc =
            serde_json::from_str(json).map_err(|e| format!("文档解析失败: {e}"))?;
        doc.validate()?;
        Ok(doc)
    }

    /// 语义校验：版本、必填、op 名、变换与过滤器名、请求步骤引用、模板占位名。
    pub fn validate(&self) -> Result<(), String> {
        if self.schema != SCHEMA_VERSION {
            return Err(format!(
                "文档格式版本 {} 不被支持（当前为 {SCHEMA_VERSION}）",
                self.schema
            ));
        }
        if self.id.is_empty() {
            return Err("id 为空".to_string());
        }
        if self.title.is_empty() {
            return Err("title 为空".to_string());
        }
        if self.ops.is_empty() {
            return Err("ops 为空：至少声明一个 op".to_string());
        }
        for op in self.ops.keys() {
            if !OPS.contains(&op.as_str()) {
                return Err(format!("未知 op: {op}"));
            }
        }
        let placeholders = self.placeholder_names();
        for (op_name, op) in &self.ops {
            op.validate(op_name, &placeholders)?;
        }
        Ok(())
    }

    /// 文档声明出来的模板占位名：内建名字 + vars 键 + 各 op 的 hidden 名与请求步骤名。
    fn placeholder_names(&self) -> Vec<String> {
        let mut names: Vec<String> = BUILTIN_PLACEHOLDERS.iter().map(|s| s.to_string()).collect();
        names.extend(self.vars.keys().cloned());
        for op in self.ops.values() {
            names.extend(op.hidden.keys().cloned());
            for step in &op.request {
                names.push(step.name.clone());
                names.extend(step.vars.keys().cloned());
            }
            if let Some(ch) = &op.chapters {
                names.extend(ch.hidden.keys().cloned());
            }
        }
        names
    }

    /// 该文档的 JSON Schema（编辑器补全与源仓库提交时校验用）。
    pub fn schema_json() -> String {
        let schema = schemars::schema_for!(SourceDoc);
        serde_json::to_string_pretty(&schema).unwrap_or_else(|_| "{}".to_string())
    }
}

impl OpSpec {
    fn validate(&self, op_name: &str, placeholders: &[String]) -> Result<(), String> {
        let fail = |msg: String| Err(format!("op {op_name}: {msg}"));
        if let Some(input) = &self.input {
            if input != "html" && input != "json" {
                return fail(format!("input 只能是 html 或 json，得到 {input}"));
            }
        }
        if let Some(sort) = &self.sort {
            if sort != "asc" && sort != "desc" {
                return fail(format!("sort 只能是 asc 或 desc，得到 {sort}"));
            }
        }
        // 请求步骤：名字唯一，input 合法，url 的占位名可解析。
        let mut seen: Vec<&str> = Vec::new();
        for step in &self.request {
            if seen.contains(&step.name.as_str()) {
                return fail(format!("请求步骤名重复: {}", step.name));
            }
            if let Some(input) = &step.input {
                if input != "html" && input != "json" {
                    return fail(format!("步骤 {} 的 input 非法: {input}", step.name));
                }
            }
            // 本步骤的 url/headers 只能用「本步骤的 vars + 前面的步骤名 + 文档级名字」。
            let mut scope: Vec<String> = placeholders.to_vec();
            scope.extend(step.vars.keys().cloned());
            for tpl in step.url.as_slice() {
                check_template(tpl, &scope)
                    .map_err(|e| format!("op {op_name} 步骤 {} 的 url: {e}", step.name))?;
            }
            for (name, chain) in &step.headers {
                for tpl in chain.as_slice() {
                    check_template(tpl, &scope).map_err(|e| {
                        format!("op {op_name} 步骤 {} 的请求头 {name}: {e}", step.name)
                    })?;
                }
            }
            // vars 只能引用前面步骤的响应。
            for (var_name, ex) in &step.vars {
                check_extractor(ex, placeholders).map_err(|e| {
                    format!("op {op_name} 步骤 {} 的 vars.{var_name}: {e}", step.name)
                })?;
                if let Extractor::Spec(spec) = ex {
                    if let Some(from) = &spec.from {
                        if !seen.contains(&from.as_str()) {
                            return fail(format!(
                                "步骤 {} 的 vars.{var_name} 引用了未在前面出现的步骤 {from}",
                                step.name
                            ));
                        }
                    }
                    if let Some(arr) = &spec.array {
                        if let Some(from) = &arr.in_step {
                            if !seen.contains(&from.as_str()) {
                                return fail(format!(
                                    "步骤 {} 的 vars.{var_name} 的 array 引用了未在前面出现的步骤 {from}",
                                    step.name
                                ));
                            }
                        }
                    }
                }
            }
            seen.push(step.name.as_str());
        }
        // 整 op 的钩子：`parse` 直接取它的返回值，其余取数键运行时不会读。
        if self.script.is_some() {
            let ignored = [
                (self.items.is_some(), "items"),
                (self.id.is_some(), "id"),
                (!self.fields.is_empty(), "fields"),
                (self.limit.is_some(), "limit"),
                (self.region.is_some(), "region"),
                (self.r#where.is_some(), "where"),
                (self.dedup_by.is_some(), "dedupBy"),
                (self.sort.is_some(), "sort"),
                (!self.comic.is_empty(), "comic"),
                (self.chapters.is_some(), "chapters"),
                (self.url.is_some(), "url"),
                (!self.hidden.is_empty(), "hidden"),
            ];
            for (set, name) in ignored {
                if set {
                    return fail(format!("script 与 {name} 不能并存（整 op 钩子自己给出结果）"));
                }
            }
        }
        // 取值规则：变换名、过滤器名、模板占位名。
        for (label, ex) in self.extractors() {
            check_extractor(&ex, placeholders)
                .map_err(|e| format!("op {op_name} 的 {label}: {e}"))?;
        }
        // items 的取值规则单独校验：它只认 select / from / script（见 check_items_extractor）。
        let steps: Vec<&str> = self.request.iter().map(|s| s.name.as_str()).collect();
        if let Some(items) = &self.items {
            check_items_extractor(items, &steps)
                .map_err(|e| format!("op {op_name} 的 items: {e}"))?;
            if self.region.is_some() && items_has_script(items) {
                return fail("items 的 script 与 region 不能并存（钩子直接给出单元列表）".to_string());
            }
        }
        if let Some(ch) = &self.chapters {
            check_items_extractor(&ch.items, &steps)
                .map_err(|e| format!("op {op_name} 的 chapters.items: {e}"))?;
        }
        // 没有 request 也没有 items/comic/script 的 op 是笔误。
        if self.request.is_empty()
            && self.items.is_none()
            && self.comic.is_empty()
            && self.script.is_none()
            && self.url.is_none()
        {
            return fail("既没有 request 也没有取数规则".to_string());
        }
        Ok(())
    }

    /// 本 op 里出现的全部 extractor，带一个人可读的位置标签（用于报错）。
    /// `items` 与 `chapters.items` 不在这里：它们由 [`check_items_extractor`] 校验。
    fn extractors(&self) -> Vec<(String, Extractor)> {
        let mut out: Vec<(String, Extractor)> = Vec::new();
        let mut push = |label: String, ex: &Extractor| out.push((label, ex.clone()));
        if let Some(id) = &self.id {
            push("id".into(), id);
        }
        for (name, field) in &self.fields {
            for (i, ex) in field_extractors(field).into_iter().enumerate() {
                push(format!("fields.{name}[{i}]"), &ex);
            }
        }
        if let Some(w) = &self.r#where {
            push("where".into(), w);
        }
        if let Some(d) = &self.dedup_by {
            push("dedupBy".into(), d);
        }
        for (name, field) in &self.comic {
            for (i, ex) in field_extractors(field).into_iter().enumerate() {
                push(format!("comic.{name}[{i}]"), &ex);
            }
        }
        if let Some(ch) = &self.chapters {
            if let Some(w) = &ch.r#where {
                push("chapters.where".into(), w);
            }
            if let Some(idx) = &ch.index {
                push("chapters.index".into(), idx);
            }
            if let Some(title) = &ch.title {
                for (i, ex) in field_extractors(title).into_iter().enumerate() {
                    push(format!("chapters.title[{i}]"), &ex);
                }
            }
            if let Some(d) = &ch.dedup_by {
                push("chapters.dedupBy".into(), d);
            }
            for (i, f) in ch.sort_by.iter().enumerate() {
                for (j, ex) in field_extractors(f).into_iter().enumerate() {
                    push(format!("chapters.sortBy[{i}][{j}]"), &ex);
                }
            }
            if let Some(e) = &ch.external {
                push("chapters.external".into(), e);
            }
            for (name, ex) in &ch.hidden {
                push(format!("chapters.hidden.{name}"), ex);
            }
        }
        if let Some(url) = &self.url {
            for (i, ex) in field_extractors(url).into_iter().enumerate() {
                push(format!("url[{i}]"), &ex);
            }
        }
        for (name, ex) in &self.hidden {
            push(format!("hidden.{name}"), ex);
        }
        out
    }
}

/// 取一个字段值里的全部 extractor（回退链展开）。
pub fn field_extractors(field: &Field) -> Vec<Extractor> {
    match field {
        Field::One(ex) => vec![ex.clone()],
        Field::Chain(chain) => chain.clone(),
    }
}

/// 校验一个 extractor：变换名、过滤器名、pick 值、模板占位名、array 的形状。
fn check_extractor(ex: &Extractor, placeholders: &[String]) -> Result<(), String> {
    let spec = match ex {
        Extractor::Select(sel) => {
            if sel.is_empty() {
                return Err("选择器为空".to_string());
            }
            return Ok(());
        }
        Extractor::Spec(spec) => spec,
    };
    // 规则自带的局部变量也是本规则模板里可用的占位名
    let mut scope: Vec<String> = placeholders.to_vec();
    scope.extend(spec.vars.keys().cloned());
    let placeholders = &scope;
    // 钩子只出现在 items 上（那里由 check_items_extractor 校验）：写在别处运行时不会读它。
    if spec.script.is_some() {
        return Err("script 只能出现在 items 上（整 op 的钩子写在 ops.<op>.script）".to_string());
    }
    if let Some(pick) = &spec.pick {
        if pick != "first" && pick != "last" {
            return Err(format!("pick 只能是 first 或 last，得到 {pick}"));
        }
    }
    if let Some(fc) = &spec.from_chapter {
        if fc != "first" && fc != "last" {
            return Err(format!("fromChapter 只能是 first 或 last，得到 {fc}"));
        }
    }
    if let Some(filter) = &spec.filter {
        if !FILTERS.iter().any(|f| name_matches(filter, f)) {
            return Err(format!("未知过滤器: {filter}"));
        }
    }
    for t in &spec.transform {
        if !TRANSFORMS.iter().any(|name| name_matches(t, name)) {
            return Err(format!("未知变换: {t}"));
        }
    }
    for tpl in [&spec.default, &spec.template, &spec.then, &spec.r#else]
        .into_iter()
        .flatten()
    {
        check_template(tpl, placeholders)?;
    }
    if let Some(arr) = &spec.array {
        for tpl in [&arr.equals, &arr.contains].into_iter().flatten() {
            check_template(tpl, placeholders)?;
        }
        for ex in field_extractors(&arr.take) {
            check_extractor(&ex, placeholders).map_err(|e| format!("array.take: {e}"))?;
        }
        if let Some(key) = &arr.key {
            for ex in field_extractors(key) {
                check_extractor(&ex, placeholders).map_err(|e| format!("array.key: {e}"))?;
            }
        }
    }
    if spec.select.is_some() && (spec.default.is_some() || spec.template.is_some()) {
        return Err("select 与 default / template 不能同时出现".to_string());
    }
    for (name, ex) in &spec.vars {
        check_extractor(ex, placeholders).map_err(|e| format!("vars.{name}: {e}"))?;
    }
    if (spec.contains.is_some() || spec.equals.is_some()) && spec.then.is_none() {
        return Err("contains / equals 必须配 then".to_string());
    }
    Ok(())
}

/// items 的取值规则：运行时只读 `select` / `from` / `script`，其余键写了也不生效，
/// 所以这里逐条拒绝——格式的边界在文档被接收时就要划清，不留静默忽略的键。
///
/// `script` 是「算法型源的出口」在单元定位上的形态：整个单元列表由文档里的 JS 给出
/// （hentara 的本地搜索），字段仍走声明式；它与 `select` / `from` 互斥。
fn check_items_extractor(items: &Extractor, steps: &[&str]) -> Result<(), String> {
    let spec = match items {
        Extractor::Select(sel) => {
            return if sel.is_empty() {
                Err("选择器为空".to_string())
            } else {
                Ok(())
            };
        }
        Extractor::Spec(spec) => spec,
    };
    let unsupported = [
        (spec.attr.is_some(), "attr"),
        (spec.pick.is_some(), "pick"),
        (spec.filter.is_some(), "filter"),
        (!spec.transform.is_empty(), "transform"),
        (spec.default.is_some(), "default"),
        (spec.array.is_some(), "array"),
        (spec.contains.is_some(), "contains"),
        (spec.equals.is_some(), "equals"),
        (spec.then.is_some(), "then"),
        (spec.r#else.is_some(), "else"),
        (spec.localized.is_some(), "localized"),
        (spec.from_chapter.is_some(), "fromChapter"),
        (spec.template.is_some(), "template"),
        (!spec.vars.is_empty(), "vars"),
    ];
    for (set, name) in unsupported {
        if set {
            return Err(format!("不支持 {name}（items 只读 select / from / script）"));
        }
    }
    if spec.script.is_some() && (spec.select.is_some() || spec.from.is_some()) {
        return Err("script 与 select / from 不能并存（钩子直接给出单元列表）".to_string());
    }
    if let Some(from) = &spec.from {
        if !steps.contains(&from.as_str()) {
            return Err(format!("from 引用了本 op 没有的请求步骤: {from}"));
        }
        if spec.select.is_none() {
            return Err("声明了 from 就要声明 select（从该响应里取单元列表）".to_string());
        }
    }
    Ok(())
}

/// items 是不是那个「整个单元列表由 JS 给出」的钩子形态。
fn items_has_script(items: &Extractor) -> bool {
    matches!(items, Extractor::Spec(spec) if spec.script.is_some())
}

/// 变换/过滤器名匹配：闭集条目以 `:` 结尾表示「名字 + 参数」。
fn name_matches(actual: &str, closed: &str) -> bool {
    match closed.strip_suffix(':') {
        Some(prefix) => actual.starts_with(prefix) && actual.len() > prefix.len(),
        None => actual == closed,
    }
}

/// 校验模板里的占位名。占位可带转换管道（`{keyword|encode}`）。
fn check_template(tpl: &str, placeholders: &[String]) -> Result<(), String> {
    let mut rest = tpl;
    while let Some(open) = rest.find('{') {
        let after = &rest[open + 1..];
        let Some(close) = after.find('}') else {
            return Err(format!("模板里的占位没有闭合: {tpl}"));
        };
        let body = &after[..close];
        let name = body.split('|').next().unwrap_or("").trim();
        if name.is_empty() {
            return Err(format!("模板里的占位为空: {tpl}"));
        }
        // 允许 `resp.步骤名` 形式读取请求步骤响应。
        let ok = placeholders.iter().any(|p| p == name)
            || name == "item"
            || name == "index"
            || name == "resp"
            || name.starts_with("resp.");
        if !ok {
            return Err(format!("模板里的占位名未声明: {{{name}}}"));
        }
        rest = &after[close + 1..];
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINIMAL: &str = r#"{
        "schema": 1,
        "id": "demo",
        "title": "演示",
        "base": "https://example.com",
        "ops": {
            "search": {
                "request": [{ "name": "list", "url": "{base}/search?q={keyword}" }],
                "items": "div.card",
                "id": { "select": "a", "attr": "href" },
                "fields": { "title": ["h3", { "attr": "title" }] }
            }
        }
    }"#;

    #[test]
    fn minimal_document_parses() {
        let doc = SourceDoc::parse(MINIMAL).expect("应解析成功");
        assert_eq!(doc.id, "demo");
        assert_eq!(doc.ops["search"].request.len(), 1);
        assert_eq!(doc.ops["search"].request[0].name, "list");
    }

    #[test]
    fn unknown_key_is_rejected() {
        let json = MINIMAL.replace("\"title\": \"演示\",", "\"titel\": \"演示\",");
        let err = SourceDoc::parse(&json).unwrap_err();
        assert!(err.contains("titel") || err.contains("unknown field"), "err = {err}");
    }

    #[test]
    fn wrong_schema_version_is_rejected() {
        let json = MINIMAL.replace("\"schema\": 1", "\"schema\": 9");
        let err = SourceDoc::parse(&json).unwrap_err();
        assert!(err.contains("格式版本"), "err = {err}");
    }

    #[test]
    fn unknown_op_is_rejected() {
        let json = MINIMAL.replace("\"search\"", "\"serach\"");
        let err = SourceDoc::parse(&json).unwrap_err();
        assert!(err.contains("未知 op"), "err = {err}");
    }

    #[test]
    fn unknown_transform_is_rejected() {
        let json = MINIMAL.replace(
            r#"{ "attr": "title" }"#,
            r#"{ "attr": "title", "transform": ["nope"] }"#,
        );
        let err = SourceDoc::parse(&json).unwrap_err();
        assert!(err.contains("未知变换"), "err = {err}");
    }

    #[test]
    fn unknown_placeholder_is_rejected() {
        let json = MINIMAL.replace("{base}/search?q={keyword}", "{base}/search?q={kw}");
        let err = SourceDoc::parse(&json).unwrap_err();
        assert!(err.contains("占位名未声明"), "err = {err}");
    }

    #[test]
    fn declared_hidden_name_is_a_valid_placeholder() {
        let json = MINIMAL.replace(
            r#""id": { "select": "a", "attr": "href" },"#,
            r#""id": { "select": "a", "attr": "href" },
               "hidden": { "seriesUrl": { "attr": "href" } },"#,
        );
        let json = json.replace("{base}/search?q={keyword}", "{base}/search?q={keyword}&s={seriesUrl}");
        SourceDoc::parse(&json).expect("hidden 名应可作为占位");
    }

    #[test]
    fn later_step_may_use_earlier_step_var() {
        let json = MINIMAL.replace(
            r#""request": [{ "name": "list", "url": "{base}/search?q={keyword}" }],"#,
            r#""request": [
                { "name": "list", "url": "{base}/search?q={keyword}" },
                { "name": "page", "vars": { "url": { "from": "list", "select": "a", "attr": "href" } },
                  "url": "{url}" }
            ],"#,
        );
        SourceDoc::parse(&json).expect("后一步应能用前一步的 vars");
    }

    #[test]
    fn step_var_referring_to_later_step_is_rejected() {
        let json = MINIMAL.replace(
            r#""request": [{ "name": "list", "url": "{base}/search?q={keyword}" }],"#,
            r#""request": [
                { "name": "page", "vars": { "u": { "from": "list", "select": "a" } }, "url": "{u}" },
                { "name": "list", "url": "{base}/x" }
            ],"#,
        );
        let err = SourceDoc::parse(&json).unwrap_err();
        assert!(err.contains("未在前面出现"), "err = {err}");
    }

    #[test]
    fn duplicate_step_name_is_rejected() {
        let json = MINIMAL.replace(
            r#""request": [{ "name": "list", "url": "{base}/search?q={keyword}" }],"#,
            r#""request": [
                { "name": "list", "url": "{base}/a" },
                { "name": "list", "url": "{base}/b" }
            ],"#,
        );
        let err = SourceDoc::parse(&json).unwrap_err();
        assert!(err.contains("重复"), "err = {err}");
    }

    #[test]
    fn items_script_is_the_only_place_a_hook_may_live() {
        // items 上的钩子：整个单元列表由它给出
        let json = MINIMAL.replace(
            r#""items": "div.card","#,
            r#""items": { "script": "function (api) { return [] }" },"#,
        );
        SourceDoc::parse(&json).expect("items 上的钩子应被接受");

        // 字段上的钩子运行时不会读，直接拒绝
        let json = MINIMAL.replace(
            r#""fields": { "title": ["h3", { "attr": "title" }] }"#,
            r#""fields": { "title": { "select": "h3", "script": "function () {}" } }"#,
        );
        let err = SourceDoc::parse(&json).unwrap_err();
        assert!(err.contains("script 只能出现在 items 上"), "err = {err}");
    }

    #[test]
    fn items_script_conflicts_with_select_and_region() {
        let json = MINIMAL.replace(
            r#""items": "div.card","#,
            r#""items": { "select": "div.card", "script": "function () { return [] }" },"#,
        );
        let err = SourceDoc::parse(&json).unwrap_err();
        assert!(err.contains("不能并存"), "err = {err}");

        let json = MINIMAL.replace(
            r#""items": "div.card","#,
            r#""region": "div#main", "items": { "script": "function () { return [] }" },"#,
        );
        let err = SourceDoc::parse(&json).unwrap_err();
        assert!(err.contains("region"), "err = {err}");
    }

    #[test]
    fn items_only_reads_select_from_and_script() {
        let json = MINIMAL.replace(
            r#""items": "div.card","#,
            r#""items": { "select": "div.card", "filter": "nonEmpty" },"#,
        );
        let err = SourceDoc::parse(&json).unwrap_err();
        assert!(err.contains("不支持 filter"), "err = {err}");
    }

    #[test]
    fn items_from_must_name_a_declared_step_and_come_with_select() {
        let json = MINIMAL.replace(
            r#""items": "div.card","#,
            r#""items": { "from": "feed", "select": "data" },"#,
        );
        let err = SourceDoc::parse(&json).unwrap_err();
        assert!(err.contains("没有的请求步骤"), "err = {err}");

        let json = MINIMAL.replace(
            r#""items": "div.card","#,
            r#""items": { "from": "list" },"#,
        );
        let err = SourceDoc::parse(&json).unwrap_err();
        assert!(err.contains("就要声明 select"), "err = {err}");
    }

    #[test]
    fn op_script_rejects_the_keys_it_would_ignore() {
        // 整 op 钩子与 request 并存是它的正常形态（manhuagui 的 images）
        let json = MINIMAL.replace(
            r#""items": "div.card",
                "id": { "select": "a", "attr": "href" },
                "fields": { "title": ["h3", { "attr": "title" }] }"#,
            r#""script": "function (api) { return [] }""#,
        );
        SourceDoc::parse(&json).expect("整 op 钩子 + request 应被接受");

        // 与它并存的取数键会被静默忽略，所以拒绝
        let json = MINIMAL.replace(
            r#""items": "div.card","#,
            r#""items": "div.card", "script": "function (api) { return [] }","#,
        );
        let err = SourceDoc::parse(&json).unwrap_err();
        assert!(err.contains("script 与 items 不能并存"), "err = {err}");
    }

    #[test]
    fn generated_schema_is_valid_json() {
        let schema = SourceDoc::schema_json();
        let v: serde_json::Value = serde_json::from_str(&schema).expect("Schema 应是合法 JSON");
        assert_eq!(v["title"], "SourceDoc");
        // 源仓库与编辑器靠它校验/补全：op 名、变换名、字段结构都要在里面
        let text = schema.as_str();
        for key in ["ops", "request", "items", "chapters", "renderChannel", "hotlinkReferers"] {
            assert!(schema.contains(key), "Schema 里应出现 {key}");
        }
        assert!(schema.contains("anyOf"), "选择器简写与完整写法应是 anyOf");
        println!("schema 长度 {} 字节", text.len());
    }

    /// 入库的 `schema.json` 必须与结构体一致——不一致说明改了格式却没重新生成。
    #[test]
    fn committed_schema_matches_the_structs() {
        let committed = include_str!("../../schema.json");
        assert_eq!(
            SourceDoc::schema_json().trim(),
            committed.trim(),
            "schema.json 与结构体不一致：cargo run -q -p mojuan-core --example source_schema > crates/mojuan-core/schema.json"
        );
    }
}
