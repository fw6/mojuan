//! 非爬虫的原生逻辑下沉：WebDAV 备份 + 本地下载/文件 IO + 下载运行时 + Android OTA。
//! 目录路径由原生侧计算后传入（Rust 不感知平台路径）。

pub mod comic_meta;
pub mod download;
pub mod download_index;
pub mod files;
pub mod integrity;
pub mod ota;
pub mod page_manifest;
pub mod queue;
pub mod repair;
pub mod webdav;

mod paths;
