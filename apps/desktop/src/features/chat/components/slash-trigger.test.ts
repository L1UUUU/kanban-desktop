// 用途：斜杠触发检测纯函数密封测试（issue #90 / spec #82 E 块）—— 首 token 触发 / 空 query / 边界字符 / 过滤分组 / 补全替换 / 高亮环移
import { describe, expect, it } from "vitest";
import {
  APP_SLASH_COMMANDS,
  applySlashCompletion,
  detectSlashTrigger,
  filterSlashCommands,
  nextSlashHighlight,
  toMenuCommand,
} from "./slash-trigger";
import type { CommandEntry } from "@kanban/ipc-schema";

/** fake 固定命令集拷贝（驱动过滤/分组断言；与 FakeAdapter.FAKE_COMMANDS 同形不直引——纯函数模块不依赖 cli-host） */
const FAKE_ENTRIES: CommandEntry[] = [
  { name: "fake-plan", description: "演示命令：请求一份轻量计划", argsHint: null, source: "native", cli: "fake", sourcePath: null, userOnly: false },
  { name: "fake-skill", description: "演示 Skill：模拟技能观察信号", argsHint: "$ARGUMENTS", source: "native", cli: "fake", sourcePath: null, userOnly: false },
  { name: "fake-user-only", description: "演示仅用户调用标记", argsHint: null, source: "native", cli: "fake", sourcePath: null, userOnly: true },
];

describe("detectSlashTrigger（首 token 以 / 开头激活）", () => {
  it("空草稿只打 / ：光标在 / 后即触发，query 为空", () => {
    expect(detectSlashTrigger("/", 1)).toEqual({ query: "", tokenStart: 0, tokenEnd: 1 });
  });

  it("首个 slash token 内打字：query 为 / 与光标之间的片段，tokenEnd 指向其后首个空白", () => {
    expect(detectSlashTrigger("/fa", 3)).toEqual({ query: "fa", tokenStart: 0, tokenEnd: 3 });
    expect(detectSlashTrigger("/fa bar", 3)).toEqual({ query: "fa", tokenStart: 0, tokenEnd: 3 });
  });

  it("光标停在 token 尾空白之前仍触发；越过空白（进入第二 token）不触发", () => {
    expect(detectSlashTrigger("/fa bar", 3)).toEqual({ query: "fa", tokenStart: 0, tokenEnd: 3 });
    expect(detectSlashTrigger("/fa bar", 4)).toBeNull();
  });

  it("非首 token 的 slash 不触发（首个 token 以 / 开头才激活）", () => {
    expect(detectSlashTrigger("bar /fa", 7)).toBeNull();
    expect(detectSlashTrigger("看板 /设计", 6)).toBeNull();
  });

  it("首 token 不以 / 开头不触发；光标在首字符之前/越界返回 null", () => {
    expect(detectSlashTrigger("fa", 2)).toBeNull();
    expect(detectSlashTrigger("/fa", 0)).toBeNull(); // 光标在 / 上：尚未进入 token
    expect(detectSlashTrigger("/fa", -1)).toBeNull();
    expect(detectSlashTrigger("/fa", 99)).toBeNull();
  });

  it("边界字符：制表符/换行视为 token 边界；换行后的 slash 属第二 token 不触发", () => {
    expect(detectSlashTrigger("/fa\tbar", 3)).toEqual({ query: "fa", tokenStart: 0, tokenEnd: 3 });
    expect(detectSlashTrigger("前言\n/fa", 6)).toBeNull();
    expect(detectSlashTrigger("/fa\nbar", 3)).toEqual({ query: "fa", tokenStart: 0, tokenEnd: 3 });
  });
});

describe("filterSlashCommands（前缀/模糊过滤 + 应用组在前）", () => {
  const items = [...APP_SLASH_COMMANDS, ...FAKE_ENTRIES.map(toMenuCommand)];

  it("空 query：全部返回，应用命令组在前、CLI 命令组在后，组内按名称序", () => {
    const got = filterSlashCommands(items, "");
    expect(got.map((c) => c.name)).toEqual(["kanban", "pty", "fake-plan", "fake-skill", "fake-user-only"]);
  });

  it("前缀命中：名称前缀优先于子串命中", () => {
    const got = filterSlashCommands(items, "fa");
    // fake-* 全命中（fake-plan 前缀、fake-skill/fake-user-only 前缀）——全部同为前缀，按名称序
    expect(got.map((c) => c.name)).toEqual(["fake-plan", "fake-skill", "fake-user-only"]);
  });

  it("模糊命中：名称子串（或子序列）与描述包含均可召回", () => {
    const byDesc = filterSlashCommands(items, "轻量计划");
    expect(byDesc.map((c) => c.name)).toEqual(["fake-plan"]);
    const bySub = filterSlashCommands(items, "ser-on");
    expect(bySub.map((c) => c.name)).toEqual(["fake-user-only"]); // 子序列模糊命中
  });

  it("匹配不分大小写", () => {
    expect(filterSlashCommands(items, "FAKE-PL").map((c) => c.name)).toEqual(["fake-plan"]);
  });

  it("无命中返回空数组（菜单显示无匹配提示由组件层负责）", () => {
    expect(filterSlashCommands(items, "zzz")).toEqual([]);
  });
});

describe("applySlashCompletion（命令引用置入输入流）", () => {
  it("替换整个 slash token 为 /name 尾随空格，光标落在空格后（实参位）", () => {
    expect(applySlashCompletion("/fa bar", { query: "fa", tokenStart: 0, tokenEnd: 3 }, "fake-plan")).toEqual({
      value: "/fake-plan  bar",
      cursor: 11,
    });
  });

  it("token 即整段草稿：直接替换", () => {
    expect(applySlashCompletion("/fa", { query: "fa", tokenStart: 0, tokenEnd: 3 }, "fake-plan")).toEqual({
      value: "/fake-plan ",
      cursor: 11,
    });
  });

  it("替换后新光标处不再触发（尾随空格截断 token）", () => {
    const { value, cursor } = applySlashCompletion("/fa", { query: "fa", tokenStart: 0, tokenEnd: 3 }, "fake-plan");
    expect(detectSlashTrigger(value, cursor)).toBeNull();
  });
});

describe("nextSlashHighlight（↑↓ 循环高亮）", () => {
  it("向下到尾回绕到 0；向上到头回绕到尾；空列表返回 0", () => {
    expect(nextSlashHighlight(0, 3, 1)).toBe(1);
    expect(nextSlashHighlight(2, 3, 1)).toBe(0);
    expect(nextSlashHighlight(0, 3, -1)).toBe(2);
    expect(nextSlashHighlight(2, 3, -1)).toBe(1);
    expect(nextSlashHighlight(0, 0, 1)).toBe(0);
  });
});
