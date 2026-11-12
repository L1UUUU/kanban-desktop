// 用途：set_model 控制请求纯函数面密封测试（issue #79 / spec #75）—— 请求报文形状（spec Further Notes：claude 2.1.317 二进制检索实证 {subtype:"set_model", model}）与 control_response 解析（成功提取 payload 实际模型名、三错误码映射、协议漂移防御）；真实进程往返由 B 类 e2e 覆盖
import { describe, expect, it } from "vitest";
import { buildSetModelControlRequest, parseSetModelResponse } from "./client";

describe("set_model 请求报文形状（与 interrupt 同通道 control_request）", () => {
  it("请求：{request_id, type:'control_request', request:{subtype:'set_model', model}}", () => {
    expect(buildSetModelControlRequest("req-1", "claude-sonnet-4")).toEqual({
      request_id: "req-1",
      type: "control_request",
      request: { subtype: "set_model", model: "claude-sonnet-4" },
    });
  });
});

describe("set_model control_response 解析", () => {
  it("成功：payload.model 提取为下一 turn 实际模型名", () => {
    const resp = { type: "control_response", response: { subtype: "success", request_id: "req-1", response: { model: "claude-actual-id" } } };
    expect(parseSetModelResponse(resp, "requested-id")).toEqual({ ok: true, model: "claude-actual-id" });
  });

  it.each(["invalid_request", "catalog_unknown", "not_found"])("失败：错误码 %s 映射为 ok:false + 原始 code/message", (code) => {
    const resp = { type: "control_response", response: { subtype: "error", request_id: "req-1", error: { code, message: "boom" } } };
    expect(parseSetModelResponse(resp, "requested-id")).toEqual({ ok: false, code, message: "boom" });
  });

  it("协议漂移防御：成功但 payload 无模型名 → 回退请求值；错误对象缺 code → unknown_error；整体缺 response → 明确报错", () => {
    expect(parseSetModelResponse({ response: { subtype: "success", response: {} } }, "requested-id")).toEqual({ ok: true, model: "requested-id" });
    expect(parseSetModelResponse({ response: { subtype: "error", error: { message: "x" } } }, "r")).toMatchObject({ ok: false, code: "unknown_error" });
    expect(parseSetModelResponse({}, "r")).toMatchObject({ ok: false, code: "unknown_error" });
  });
});
