import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // 純單元測試：注入 KV fake 與 mock fetch，不依賴 Workers 執行階段。
  },
});
