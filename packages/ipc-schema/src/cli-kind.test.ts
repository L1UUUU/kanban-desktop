// 用途：CLI 显示名与默认标题单源密封测试（arch C8）—— 键完备约束 + main/renderer 同源构造点
import { describe, expect, it } from "vitest";
import { CLI_LABELS, cliKindSchema, defaultSessionTitle } from "./cli-kind";

describe("CLI_LABELS（arch C8 双端单源）", () => {
  it("每个 CliKind 成员都有显示名（枚举扩员漏配即编译报错，此断言钉住四值现值）", () => {
    expect(Object.keys(CLI_LABELS).sort()).toEqual([...cliKindSchema.options].sort());
    expect(CLI_LABELS).toEqual({ fake: "Fake", codex: "Codex", claude: "Claude", opencode: "OpenCode" });
  });
});

describe("defaultSessionTitle（新建会话默认标题唯一构造点）", () => {
  it("按 CLI 显示名拼接（main 入库兜底与 renderer 草稿提示行共用此函数）", () => {
    expect(defaultSessionTitle("claude")).toBe("新会话 · Claude");
    expect(defaultSessionTitle("codex")).toBe("新会话 · Codex");
    expect(defaultSessionTitle("opencode")).toBe("新会话 · OpenCode");
    expect(defaultSessionTitle("fake")).toBe("新会话 · Fake");
  });
});
