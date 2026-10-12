//! 下载目录布局：`<dir>/<source>/<comicId>`，扁平布局（旧数据/导入文件夹）为 `<dir>/<comicId>`。
//! 下载、扫描与下载索引都按这一份规则算路径。

use std::path::{Path, PathBuf};

/// 扁平布局的伪 source。
pub(crate) const FLAT_SOURCE: &str = "local";

/// 某漫画的根目录。
pub(crate) fn comic_dir(dir: &str, source: &str, comic_id: &str) -> PathBuf {
    if source == FLAT_SOURCE {
        Path::new(dir).join(comic_id)
    } else {
        Path::new(dir).join(source).join(comic_id)
    }
}
