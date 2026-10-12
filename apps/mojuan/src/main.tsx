import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initImgProxy, setImgProxyDownloadDir } from "./api";
import { getSettings } from "./lib/storage/settings";
import "./styles/beui.css";

// 图片代理端口在渲染前取到：避免首屏封面/阅读页图片 URL 落在兜底值
// （research #31 换代理：端口由 Rust 侧本机 HTTP 服务分配）。
async function bootstrap() {
    try {
        await initImgProxy();
    } catch (err) {
        console.error("initImgProxy failed", err);
    }
    // 同步下载目录给代理（离线阅读按 url 查下载索引，wayfinder #31）
    try {
        const s = await getSettings();
        if (s.downloadDir) setImgProxyDownloadDir(s.downloadDir);
    } catch (err) {
        console.error("init download dir failed", err);
    }
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
        <React.StrictMode>
            <App />
        </React.StrictMode>,
    );
}

void bootstrap();
