// 用途：frontmatter 最小解析器测试（issue #89 / spec #82 E 块）—— `---` 围栏 + `key: value` 行的手写切分（仓内零新依赖约定，不引 yaml 库；claude SKILL.md 与 codex prompt md 共用）
import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "./frontmatter";

describe("parseFrontmatter（#89）", () => {
  it("标准块：name/description/disable-model-invocation 各键解析为字符串", () => {
    const text = "---\nname: kb-probe-skill\ndescription: E2E 探针 skill——回复固定标记\ndisable-model-invocation: true\n---\n\n正文不参与解析\n";
    expect(parseFrontmatter(text)).toEqual({
      name: "kb-probe-skill",
      description: "E2E 探针 skill——回复固定标记",
      "disable-model-invocation": "true",
    });
  });

  it("引号值去引号；值内冒号不切断（首个冒号分隔）；未知键保留", () => {
    const text = '---\ndescription: "说明：含冒号"\nargument-hint: \'[消息]\'\ncustom-key: v\n---\nbody';
    expect(parseFrontmatter(text)).toEqual({
      description: "说明：含冒号",
      "argument-hint": "[消息]",
      "custom-key": "v",
    });
  });

  it("无 frontmatter / 未闭合 / 非 `key: value` 行（忽略）各自安全", () => {
    expect(parseFrontmatter("普通正文，无围栏")).toBeNull();
    expect(parseFrontmatter("---\nname: x\n")).toBeNull(); // 未闭合
    expect(parseFrontmatter("---\n杂行\nname: y\n---\n")).toEqual({ name: "y" }); // 杂行忽略
  });
});
