// 用途：tracker 包入口冒烟 —— 导出面完整（schema/tracker/store/engine），依赖方向仅 ipc-schema + node 内置
import { describe, expect, it } from "vitest";
import { EVIDENCE_EFFECT, RequirementTracker, SKILL_STAGE, Store, TrackerEngine, transformHookEvents, validateEvent } from "./index";

describe("tracker 入口导出面", () => {
  it("核心成员均可导入且形状正确", () => {
    expect(typeof validateEvent).toBe("function");
    expect(new RequirementTracker() instanceof RequirementTracker).toBe(true);
    expect(typeof TrackerEngine).toBe("function");
    expect(typeof Store).toBe("function");
    expect(typeof transformHookEvents).toBe("function");
    expect(EVIDENCE_EFFECT.verified).toEqual({ drive: true, uncertain: false, autoCreate: true });
    expect(Object.keys(SKILL_STAGE)).toHaveLength(4);
  });
});
