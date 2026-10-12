#!/usr/bin/env node
/**
 * 打印应用版本，供发布流程用。
 *
 * 事实来源是 apps/mojuan/src-tauri/tauri.conf.json 的 `version`：Android 的 versionName /
 * versionCode 与 iOS 的 CFBundleShortVersionString 都由 tauri 从这里取（少了它，Android 会
 * 退回 Gradle 模板的 `1.0` / `1`，装不上已装的高版本）。Cargo 侧那份跟它一致，由
 * apps/mojuan/src-tauri/tests/tauri_config.rs 的断言守着。
 *
 * 用法（在仓库里任意位置）：node scripts/app-version.mjs
 */
import { readFileSync } from "node:fs";

const config = JSON.parse(
    readFileSync(new URL("../apps/mojuan/src-tauri/tauri.conf.json", import.meta.url), "utf8"),
);

if (!config.version) throw new Error("tauri.conf.json 里没有 version");

process.stdout.write(config.version);
