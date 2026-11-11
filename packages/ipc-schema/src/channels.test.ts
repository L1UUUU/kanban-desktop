// 用途：通道名单源密封测试 —— 五通道名称逐字锚点 + 错误方言映射 + schema 配对（改名或改方言即红；#72 C1 Step4）
import { describe, expect, expectTypeOf, it } from "vitest";
import { IPC_CHANNELS } from "./channels";
import { configRequestSchema, diffRequestSchema, ipcRequestSchema, memoryRequestSchema, residueRequestSchema } from ".";

describe("IPC_CHANNELS 通道名单源（#72）", () => {
  it("五通道名称逐字不变（main ipcMain.handle/日志 scope 与 preload invoke 字符串单源的锚点）", () => {
    expect(IPC_CHANNELS.kanban.name).toBe("kanban:ipc");
    expect(IPC_CHANNELS.memory.name).toBe("memory:ipc");
    expect(IPC_CHANNELS.residue.name).toBe("residue:ipc");
    expect(IPC_CHANNELS.diff.name).toBe("diff:ipc");
    expect(IPC_CHANNELS.config.name).toBe("config:ipc");
  });

  it("错误方言映射与既有 wire 形状一致（code×3：kanban/diff/config；reason×2：memory/residue）", () => {
    expect(IPC_CHANNELS.kanban.errorShape).toBe("code");
    expect(IPC_CHANNELS.diff.errorShape).toBe("code");
    expect(IPC_CHANNELS.config.errorShape).toBe("code");
    expect(IPC_CHANNELS.memory.errorShape).toBe("reason");
    expect(IPC_CHANNELS.residue.errorShape).toBe("reason");
  });

  it("request 契约与各通道 schema 单源同物（防止 def 配错 schema）", () => {
    expect(IPC_CHANNELS.kanban.request).toBe(ipcRequestSchema);
    expect(IPC_CHANNELS.memory.request).toBe(memoryRequestSchema);
    expect(IPC_CHANNELS.residue.request).toBe(residueRequestSchema);
    expect(IPC_CHANNELS.diff.request).toBe(diffRequestSchema);
    expect(IPC_CHANNELS.config.request).toBe(configRequestSchema);
    expectTypeOf(Object.keys(IPC_CHANNELS)).toEqualTypeOf<string[]>();
  });
});
