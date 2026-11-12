// 用途：模型目录通道契约密封测试 —— models:list 请求形状（cli 枚举/非空 cwd）、条目四字段、结果联合（成功数组默认项由 isDefault 派生/错误信封）
import { describe, expect, it } from "vitest";
import { modelEntrySchema, modelsRequestSchema, modelsResultSchema } from "./models";

describe("modelEntrySchema", () => {
  it("四字段条目通过；缺字段/空 id 拒绝", () => {
    expect(() =>
      modelEntrySchema.parse({ id: "openai/gpt-5.4", displayName: "GPT-5.4", description: "", isDefault: true }),
    ).not.toThrow();
    expect(() => modelEntrySchema.parse({ id: "", displayName: "x", description: "", isDefault: false })).toThrow();
    expect(() => modelEntrySchema.parse({ id: "m", displayName: "x", description: "", isDefault: "yes" })).toThrow();
  });
});

describe("modelsRequestSchema", () => {
  it("models:list 请求通过；未知 cli/空 cwd 拒绝", () => {
    expect(modelsRequestSchema.parse({ channel: "models:list", cli: "codex", cwd: "C:\\p" })).toEqual({
      channel: "models:list",
      cli: "codex",
      cwd: "C:\\p",
    });
    expect(() => modelsRequestSchema.parse({ channel: "models:list", cli: "grok", cwd: "C:\\p" })).toThrow();
    expect(() => modelsRequestSchema.parse({ channel: "models:list", cli: "fake", cwd: "" })).toThrow();
    expect(() => modelsRequestSchema.parse({ channel: "models:nuke", cli: "fake", cwd: "C:\\p" })).toThrow();
  });
});

describe("modelsResultSchema", () => {
  it("成功结果携带 models 数组；错误信封 code+message", () => {
    const ok = modelsResultSchema.parse({
      ok: true,
      models: [
        { id: "fake-standard", displayName: "Fake 标准模型", description: "", isDefault: true },
        { id: "fake-lite", displayName: "Fake 轻量模型", description: "", isDefault: false },
      ],
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.models).toHaveLength(2);
    const err = modelsResultSchema.parse({ ok: false, error: { code: "E_INTERNAL", message: "claude 模型目录暂未支持" } });
    expect(err).toMatchObject({ ok: false, error: { code: "E_INTERNAL" } });
  });
});
