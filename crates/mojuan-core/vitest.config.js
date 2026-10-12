import { defineConfig } from "vitest/config";

// 源文档的 JS 测试跑在本 crate 里：驱动（source-harness.js）、文档（sources/*.json）与
// fixture（tests/fixtures/）都在本 crate 内，jsdom 实现宿主绑定 __host.select。
// 引擎差异（真 QuickJS + 真 scraper）由 tests/source_doc_test.rs 兜底。
export default defineConfig({
    test: {
        environment: "jsdom",
        include: ["src/js/**/*.test.js"],
    },
});
