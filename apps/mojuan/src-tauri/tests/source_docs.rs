//! 渲染通道探针要读的源文档目录确实存在。
//!
//! `render_probe` 是 example，不在 `cargo test` 的默认范围里；它读的仓库路径写错时只有真跑
//! 一次探针才会发现（布局改动就踩过一次）。这里把那条路径固定成断言，路径的定义在
//! `mojuan_core::SOURCE_DOC_DIR`。

use std::path::Path;

#[test]
fn source_doc_dir_lists_documents() {
    let dir = Path::new(mojuan_core::SOURCE_DOC_DIR);
    assert!(dir.is_dir(), "源文档目录不存在：{}", dir.display());

    let documents = std::fs::read_dir(dir)
        .expect("读源文档目录")
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
        .count();
    assert!(documents > 0, "源文档目录里没有 json：{}", dir.display());
}
