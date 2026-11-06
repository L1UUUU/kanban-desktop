// 用途：memory 包单测编排（node 环境，密封测试紧邻源码）
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
