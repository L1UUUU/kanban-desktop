// 用途：斜杠派发判定纯函数密封测试矩阵（issue #92 / spec #82 E 块）—— 三 CLI × 匹配/未匹配/重名/文件缺失/目录不可用：claude/opencode/fake=透传、codex=客户端展开（fail-closed：目录不可用或无来源文件拒绝发送）、未匹配原样、内置 /pty /kanban 优先于 CLI 同名命令
import { describe, expect, it } from "vitest";
import type { CommandEntry } from "@kanban/ipc-schema";
import { APP_SLASH_COMMANDS } from "./components/slash-trigger";
import { APP_COMMAND_NAMES, parseSlashInvocation, resolveSlashDispatch } from "./slash-dispatch";

/** 目录条目工厂（缺省 codex 带来源文件） */
function entry(name: string, cli: CommandEntry["cli"] = "codex", sourcePath: string | null = `C:\\prompts\\${name}.md`): CommandEntry {
  return { name, description: `desc:${name}`, argsHint: null, source: "user", cli, sourcePath, userOnly: false };
}

/** codex 匹配条目（带 userOnly 形态，验证仅用户调用不影响派发形态） */
const CODEX_CMDS: CommandEntry[] = [
  entry("commit"),
  { ...entry("secret"), userOnly: true },
  entry("no-file", "codex", null),
];

describe("parseSlashInvocation（首 token 切分）", () => {
  it("斜杠开头切首词与余文；非斜杠/仅 / 返回 null", () => {
    expect(parseSlashInvocation("/commit fix bug")).toEqual({ name: "commit", args: "fix bug" });
    expect(parseSlashInvocation("/commit")).toEqual({ name: "commit", args: "" });
    expect(parseSlashInvocation("/a\nb")).toEqual({ name: "a", args: "b" });
    expect(parseSlashInvocation("普通文本 /x")).toBeNull();
    expect(parseSlashInvocation(" /commit")).toBeNull(); // 首字符非 /（与菜单触发判定一致）
    expect(parseSlashInvocation("/")).toBeNull();
  });
});

describe("resolveSlashDispatch（派发形态矩阵）", () => {
  it("非斜杠文本 → 原样发送（三 CLI 一致）", () => {
    for (const cli of ["claude", "codex", "opencode", "fake"] as const) {
      expect(resolveSlashDispatch({ text: "普通消息", cli, commands: CODEX_CMDS })).toEqual({ action: "send-text", text: "普通消息" });
    }
  });

  it("claude 匹配（含 userOnly / 无来源文件）→ 透传原文（CLI 侧解析，与文件无关）", () => {
    const cmds: CommandEntry[] = [entry("plan", "claude"), { ...entry("secret", "claude"), userOnly: true }, entry("nofile", "claude", null)];
    expect(resolveSlashDispatch({ text: "/plan 拆分模块", cli: "claude", commands: cmds })).toEqual({ action: "send-text", text: "/plan 拆分模块" });
    expect(resolveSlashDispatch({ text: "/secret", cli: "claude", commands: cmds })).toEqual({ action: "send-text", text: "/secret" });
  });

  it("opencode 匹配 → 透传原文（适配器既有单点判定继续生效，菜单数据同源不漂移）", () => {
    expect(resolveSlashDispatch({ text: "/cmd run", cli: "opencode", commands: [entry("cmd", "opencode", null)] })).toEqual({
      action: "send-text",
      text: "/cmd run",
    });
  });

  it("fake 匹配 → 透传原文（演示通道同 claude 形态）", () => {
    expect(resolveSlashDispatch({ text: "/fake-plan x", cli: "fake", commands: [entry("fake-plan", "fake", null)] })).toEqual({
      action: "send-text",
      text: "/fake-plan x",
    });
  });

  it("codex 匹配带来源文件 → 客户端展开动作（携带名称/实参/来源路径；userOnly 不改变形态）", () => {
    expect(resolveSlashDispatch({ text: "/commit fix bug", cli: "codex", commands: CODEX_CMDS })).toEqual({
      action: "expand",
      name: "commit",
      args: "fix bug",
      sourcePath: `C:\\prompts\\commit.md`,
    });
    expect(resolveSlashDispatch({ text: "/secret now", cli: "codex", commands: CODEX_CMDS })).toMatchObject({ action: "expand", name: "secret" });
  });

  it("codex 匹配但无来源文件 → fail-closed 拒绝（不静默发原文）", () => {
    const d = resolveSlashDispatch({ text: "/no-file x", cli: "codex", commands: CODEX_CMDS });
    expect(d.action).toBe("blocked");
    if (d.action === "blocked") {
      expect(d.code).toBe("E_INTERNAL");
      expect(d.message).toContain("no-file");
    }
  });

  it("codex 目录不可用（null）→ fail-closed 拒绝；透传类 CLI 目录不可用不受影响", () => {
    const d = resolveSlashDispatch({ text: "/commit x", cli: "codex", commands: null });
    expect(d.action).toBe("blocked");
    expect(resolveSlashDispatch({ text: "/plan x", cli: "claude", commands: null })).toEqual({ action: "send-text", text: "/plan x" });
    expect(resolveSlashDispatch({ text: "/cmd x", cli: "opencode", commands: null })).toEqual({ action: "send-text", text: "/cmd x" });
  });

  it("未匹配 /foo → 三 CLI 一律原样发送", () => {
    for (const cli of ["claude", "codex", "opencode", "fake"] as const) {
      expect(resolveSlashDispatch({ text: "/nope hi", cli, commands: CODEX_CMDS })).toEqual({ action: "send-text", text: "/nope hi" });
    }
  });

  it("内置 /pty /kanban 本地执行，优先于 CLI 目录同名命令（重名内置胜出）", () => {
    const clash: CommandEntry[] = [entry("pty"), entry("kanban")];
    expect(resolveSlashDispatch({ text: "/pty", cli: "codex", commands: clash })).toEqual({ action: "app", app: "pty" });
    expect(resolveSlashDispatch({ text: "/kanban", cli: "claude", commands: clash })).toEqual({ action: "app", app: "kanban" });
    // 目录不可用时内置判定仍可用（本地命令不依赖目录）
    expect(resolveSlashDispatch({ text: "/kanban", cli: "codex", commands: null })).toEqual({ action: "app", app: "kanban" });
    // 带参数与大小写不敏感（与菜单过滤口径一致）
    expect(resolveSlashDispatch({ text: "/Kanban foo", cli: "fake", commands: [] })).toEqual({ action: "app", app: "kanban" });
  });

  it("命令名匹配大小写不敏感（Windows 语义，与目录扫描/菜单一致）", () => {
    expect(resolveSlashDispatch({ text: "/Commit fix", cli: "codex", commands: CODEX_CMDS })).toMatchObject({
      action: "expand",
      name: "commit", // 规范形取目录条目名
    });
  });

  it("内置命令名单源：与菜单 APP_SLASH_COMMANDS 一致（隐藏同步点防漂移）", () => {
    expect([...APP_COMMAND_NAMES].sort()).toEqual(APP_SLASH_COMMANDS.map((c) => c.name).sort());
  });
});
