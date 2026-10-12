//! WebDAV 备份：PUT/GET + Basic Auth（移植自旧 WebDavModule）。
//! 返回 JSON 字符串，由原生方法层解析回 result model。

use base64::Engine;
use serde_json::json;

fn base_url(base: &str) -> String {
    if base.ends_with('/') {
        base.to_string()
    } else {
        format!("{}/", base)
    }
}

fn basic_auth(user: &str, password: &str) -> String {
    format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode(format!("{}:{}", user, password))
    )
}

/// PUT 备份文件，返回 JSON `{"success":bool,"status":int}`。
pub fn webdav_put(base: &str, user: &str, password: &str, file_name: &str, content: &str) -> String {
    let url = format!("{}{}", base_url(base), file_name);
    let resp = crate::crawler::http::client()
        .put(&url)
        .header("Authorization", basic_auth(user, password))
        .body(content.to_string())
        .send();
    match resp {
        Ok(r) => {
            let status = r.status().as_u16();
            json!({ "success": r.status().is_success(), "status": status }).to_string()
        }
        Err(_) => json!({ "success": false, "status": 0 }).to_string(),
    }
}

/// GET 读取备份文件，返回 JSON `{"ok":bool,"content":string?,"status":int?,"error":string?}`。
pub fn webdav_get(base: &str, user: &str, password: &str, file_name: &str) -> String {
    let url = format!("{}{}", base_url(base), file_name);
    let resp = crate::crawler::http::client()
        .get(&url)
        .header("Authorization", basic_auth(user, password))
        .send();
    match resp {
        Ok(r) => {
            let status = r.status().as_u16();
            if r.status().is_success() {
                match r.text() {
                    Ok(content) => json!({ "ok": true, "content": content }).to_string(),
                    Err(e) => json!({ "ok": false, "status": status, "error": e.to_string() }).to_string(),
                }
            } else {
                json!({ "ok": false, "status": status }).to_string()
            }
        }
        Err(e) => json!({ "ok": false, "error": e.to_string() }).to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_url_appends_slash() {
        assert_eq!(base_url("https://dav.example.com/remote.php/dav/files/u"), "https://dav.example.com/remote.php/dav/files/u/");
        assert_eq!(base_url("https://dav.example.com/"), "https://dav.example.com/");
    }

    #[test]
    fn basic_auth_is_no_wrap_base64() {
        assert_eq!(
            basic_auth("user", "pass"),
            "Basic dXNlcjpwYXNz"
        );
    }
}
