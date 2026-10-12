//! 非爬虫的原生逻辑下沉：WebDAV 备份 + 本地下载/文件 IO + 下载运行时 + Android OTA。
//! 目录路径由原生侧计算后传入（Rust 不感知平台路径）。

pub mod download;
pub mod download_index;
pub mod files;
pub mod ota;
pub mod queue;
pub mod webdav;

mod paths;
