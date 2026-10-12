// 应用对外的事实。更新通道（apps/updater）的测试要断言「清单里的公钥就是给制品签名的那个」，
// 那两半分别住在两个包里，所以这里给一个具名入口，调用方声明依赖即可，不必拼相对路径。

import { readFileSync } from "node:fs";

const config = JSON.parse(
    readFileSync(new URL("./src-tauri/tauri.conf.json", import.meta.url), "utf8"),
);

/** 桌面端更新器的公钥（tauri.conf.json 的 `plugins.updater.pubkey`）。 */
export const updaterPubkey = config.plugins.updater.pubkey;
