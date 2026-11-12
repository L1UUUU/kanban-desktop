// 用途：命令条目 schema 往返测试（issue #89 / spec #82 E 块）—— 斜杠命令统一形状：名称/描述/参数提示/来源/所属 CLI/来源文件路径/仅用户调用标记
import { describe, expect, it } from "vitest";
import { commandEntrySchema } from "./commands";

describe("commandEntry（#89 统一命令条目）", () => {
  it("claude skill 条目往返：项目级来源 + 来源文件路径 + 仅用户调用标记", () => {
    const entry = {
      name: "kb-probe-skill",
      description: "E2E 探针 skill——被调用时只回复固定标记",
      argsHint: null,
      source: "project",
      cli: "claude",
      sourcePath: "C:\\w\\.claude\\skills\\kb-probe-skill\\SKILL.md",
      userOnly: true,
    };
    expect(commandEntrySchema.parse(entry)).toEqual(entry);
  });

  it("codex prompt 条目往返：用户级来源 + argument-hint 参数提示", () => {
    const entry = {
      name: "commit",
      description: "按仓库规范生成提交信息",
      argsHint: "$ARGUMENTS",
      source: "user",
      cli: "codex",
      sourcePath: "C:\\Users\\u\\.codex\\prompts\\commit.md",
      userOnly: false,
    };
    expect(commandEntrySchema.parse(entry)).toEqual(entry);
  });

  it("opencode 原生 API 条目往返：source=native、无来源文件（sourcePath=null）", () => {
    const entry = { name: "share", description: "分享会话", argsHint: null, source: "native", cli: "opencode", sourcePath: null, userOnly: false };
    expect(commandEntrySchema.parse(entry)).toEqual(entry);
  });

  it("非法形状被拒：空名 / source 枚举外 / cli 枚举外 / userOnly 缺失", () => {
    const base = { name: "x", description: "", argsHint: null, source: "user", cli: "fake", sourcePath: null, userOnly: false };
    expect(() => commandEntrySchema.parse({ ...base, name: "" })).toThrow();
    expect(() => commandEntrySchema.parse({ ...base, source: "global" })).toThrow();
    expect(() => commandEntrySchema.parse({ ...base, cli: "pi" })).toThrow();
    expect(() => commandEntrySchema.parse({ ...base, userOnly: undefined })).toThrow();
  });
});
