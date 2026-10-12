#!/usr/bin/env node
/**
 * 打印应用版本，供发布流程用。
 *
 * 应用版本只写在仓库根 Cargo.toml 的 `[workspace.package].version`；crate 用
 * `version.workspace = true` 继承，tauri.conf.json 不写 version（tauri 的 CLI、代码生成
 * 与 tauri-action 都回落到 Cargo 的包版本）。这里把它取出来给 release.yml 的移动作业用。
 *
 * 用法（在仓库里任意位置）：node scripts/app-version.mjs
 */
import { execFileSync } from "node:child_process";

const metadata = JSON.parse(
    execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
    }),
);

const app = metadata.packages.find((pkg) => pkg.name === "mojuan");
if (!app) throw new Error("cargo metadata 里没有 mojuan 包");

process.stdout.write(app.version);
