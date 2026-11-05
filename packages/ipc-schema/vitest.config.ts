// 用途：ipc-schema 单测编排（node 环境、零外部依赖）
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
