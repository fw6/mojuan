import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  resolve: {
    // beui 组件源码以 "@/lib/utils" 这类路径引用内部工具
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  // 测试（#10 定案：vitest + jsdom；seam 测试走显式 import，不用 globals）。
  // 源文档的 JS 测试在 crates/mojuan-core 自己的 vitest 里跑（见那个包的 vitest.config.js）。
  test: {
    environment: "jsdom",
    setupFiles: ["src/test-setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    server: {
      // codemirror-json-schema 的 ESM 产物用无扩展名的相对 import（`./features/completion`），
      // 打包器能解析、Node 的原生 ESM 不能。测试里让 Vite 处理这个包，不走 node 原生加载。
      deps: { inline: ["codemirror-json-schema"] },
    },
  },
}));
