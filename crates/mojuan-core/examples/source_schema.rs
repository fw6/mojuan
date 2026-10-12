//! 打印源文档的 JSON Schema（由 Rust 结构体生成）。
//!
//! 用途：生成 `crates/mojuan-core/schema.json`（入库的产物，有漂移测试守着）与更新通道
//! Worker 的 `src/schema.json`。
//!
//! 用法（在仓库根执行）：
//!   cargo run -q -p mojuan-core --example source_schema > crates/mojuan-core/schema.json

fn main() {
    println!("{}", mojuan_core::source_schema());
}
