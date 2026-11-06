// 用途：FakeAdapter SkillObservation 发射单测（#9）—— /skill 名 token 精确命中走 skill 分支：事件形状过 C2 zod 契约、self_reported 口径、不入 chat 日志、未命中按普通 prompt
import { describe, expect, it } from "vitest";
import { skillObservationSchema, type AdapterEvent, type ChatEvent, type SkillObservation } from "@kanban/ipc-schema";
import { FakeAdapter, VirtualClock } from "./index";

/** 收集 SkillObservation（无 type 判别字段的成员） */
function collectSkills(adapter: FakeAdapter): SkillObservation[] {
  const out: SkillObservation[] = [];
  adapter.subscribe((e: AdapterEvent) => {
    if (!("type" in e)) out.push(e);
  });
  return out;
}

describe("FakeAdapter SkillObservation（#9 tracker 接线的数据源）", () => {
  it("发送 /design-feature → 发出 self_reported 观察信号，形状过 C2 契约，且驱动 tracker 自动建卡口径（turn 正常完成）", async () => {
    const clock = new VirtualClock();
    const adapter = new FakeAdapter({ clock });
    const skills = collectSkills(adapter);
    const chat: ChatEvent[] = [];
    adapter.subscribe((e) => {
      if ("type" in e) chat.push(e);
    });
    const { sessionId } = await adapter.createSession({ cwd: "C:\\demo" });
    await adapter.sendTurn({ sessionId, text: "/design-feature 做一个需求看板" });
    clock.runToIdle();

    expect(skills).toHaveLength(1);
    const obs = skillObservationSchema.parse(skills[0]); // 硬契约校验（与 main 侧同一 schema）
    expect(obs).toMatchObject({ kind: "skill", sessionId, skill: "design-feature", cli: "codex", evidenceLevel: "self_reported", source: "fake-script" });
    // turn 正常走完（观察信号不干扰消息流）
    expect(chat.some((e) => e.type === "turn_completed")).toBe(true);
    // 不入 chat 日志：readHistory 仅消息流成员（条数与订阅到的 ChatEvent 一致，无 skill 观察成员混入）
    const history = await adapter.readHistory(sessionId);
    expect(history).toHaveLength(chat.length);
    await adapter.dispose();
  });

  it("token 不精确命中（带前缀/未知 skill/非斜杠开头）→ 不发观察信号，按普通 prompt 发送", async () => {
    const clock = new VirtualClock();
    const adapter = new FakeAdapter({ clock });
    const skills = collectSkills(adapter);
    const { sessionId } = await adapter.createSession({ cwd: "C:\\demo" });
    for (const text of ["/vdesign-feature", "/unknown-skill 参数", "design-feature 不带斜杠"]) {
      await adapter.sendTurn({ sessionId, text });
    }
    clock.runToIdle();
    expect(skills).toHaveLength(0);
    const history = await adapter.readHistory(sessionId);
    expect(history.filter((e) => e.type === "turn_started")).toHaveLength(3);
    await adapter.dispose();
  });

  it("自定义脚本可发 verified 事件（模拟 Claude hook 口径，供 tracker 建卡链路测试）", async () => {
    const clock = new VirtualClock();
    const adapter = new FakeAdapter({
      clock,
      pickTurnScript: () => [{ t: "skill", skill: "design-feature", cli: "claude-code", evidenceLevel: "verified" }, { t: "turnEnd" }],
    });
    const skills = collectSkills(adapter);
    const { sessionId } = await adapter.createSession({ cwd: "C:\\demo" });
    await adapter.sendTurn({ sessionId, text: "任意文本（脚本注入）" });
    clock.runToIdle();
    expect(skillObservationSchema.parse(skills[0])).toMatchObject({ skill: "design-feature", cli: "claude-code", evidenceLevel: "verified" });
    await adapter.dispose();
  });

  it("「/skill 名 verified」→ 以 claude-code 口径发 verified 信号（#18 看板自动建卡的 e2e/演示入口，无需脚本注入）", async () => {
    const clock = new VirtualClock();
    const adapter = new FakeAdapter({ clock });
    const skills = collectSkills(adapter);
    const { sessionId } = await adapter.createSession({ cwd: "C:\\demo" });
    await adapter.sendTurn({ sessionId, text: "/design-feature verified 设计阶段2看板" });
    clock.runToIdle();
    expect(skills).toHaveLength(1);
    expect(skillObservationSchema.parse(skills[0])).toMatchObject({
      kind: "skill",
      skill: "design-feature",
      cli: "claude-code",
      evidenceLevel: "verified",
      source: "fake-script",
    });
    await adapter.dispose();
  });
});
