// 用途：五个 :ipc 通道共享的信封工厂 —— 入站 safeParse → 记日志 → 退出门闸 → try/route/catch 错误形状化（#72 C1 Step1：收敛 ipc.ts 五份手抄信封；错误结果构造按方言注入，文案逐字保持既有断言锚点）
import type { ErrorCode } from "@kanban/ipc-schema";
import { AdapterError } from "@kanban/cli-host";
import type { LogFn } from "./logger";

/** 信封共享依赖：收敛既有 5 个通道 Deps interface 重复的退出门闸与诊断日志两成员（业务成员留在各通道自己的 Deps） */
export interface EnvelopeDeps {
  /** 退出序列门闸（true=正在退出，拒绝新请求，spec H 第 1 步；缺省恒 false 供旧测试） */
  isShuttingDown?(): boolean;
  /** #53（spec #52 G 节）：诊断日志 —— safeParse 失败与 route 抛错记 error（code/reason 原样不造新）；业务拒绝不记；缺省 no-op 供既有装配夹具 */
  log?: LogFn;
}

/** 入站请求契约的结构面（zod schema 满足此形状；desktop 不直依赖 zod 包，契约类型单源在 @kanban/ipc-schema） */
export interface EnvelopeSchema<Req> {
  safeParse(raw: unknown): { success: true; data: Req } | { success: false; error: { issues: readonly { path: PropertyKey[]; message: string }[] } };
}

/** 错误方言：入站拒绝与退出门闸的错误结果构造 + 日志码字（wire 形状不变；code/reason 两预设见 codeEnvelope/reasonEnvelope） */
export interface EnvelopeDialect<Res> {
  /** 入站拒绝码字（嵌入日志文案「入站请求不符合契约（码字）：摘要」，逐字锚点） */
  codeWord: string;
  /** 入站 parse 拒绝结果 */
  invalidRequest(detail: string): Res;
  /** 退出门闸拒绝结果 */
  shuttingDown(): Res;
}

/** catch 策略三档（既有五通道行为逐字收敛，不新增分支语义）：
 *  adapter-passthrough = kanban：记「处理异常（code）」+ AdapterError 错误码透传 / 其余 E_INTERNAL 形状化（toError 注入构造）
 *  rethrow = memory/residue/diff：记「处理异常」后原样 rethrow（异常向 ipcMain.handle 传播的既有行为，不吞不造码）
 *  fail = config：记自定义文案并返回明确错误（配置写盘失败是用户可重试动作，不 rethrow） */
export type EnvelopeCatch<Res> =
  | { kind: "adapter-passthrough"; toError(code: ErrorCode, message: string): Res }
  | { kind: "rethrow" }
  | { kind: "fail"; logMessage(message: string): string; toResult(message: string): Res };

/** code 方言预设（kanban/diff/config 共用）：入站拒绝 E_SCHEMA / 退出门闸 E_INTERNAL；文案逐字锚点 */
export const codeEnvelope = {
  codeWord: "E_SCHEMA",
  invalidRequest: (detail: string) => ({ ok: false as const, error: { code: "E_SCHEMA" as const, message: detail } }),
  shuttingDown: () => ({ ok: false as const, error: { code: "E_INTERNAL" as const, message: "应用正在退出，已停止接收新请求" } }),
  /** adapter-passthrough catch 的错误结果构造（AdapterError 原码透传 / 其余 E_INTERNAL 兜底） */
  toError: (code: ErrorCode, message: string) => ({ ok: false as const, error: { code, message } }),
} satisfies EnvelopeDialect<unknown> & { toError(code: ErrorCode, message: string): unknown };

/** reason 方言预设（memory/residue 共用）：入站拒绝 invalid-request / 退出门闸 shutting-down；文案逐字锚点 */
export const reasonEnvelope = {
  codeWord: "invalid-request",
  invalidRequest: (detail: string) => ({ ok: false as const, reason: "invalid-request" as const, detail }),
  shuttingDown: () => ({ ok: false as const, reason: "shutting-down" as const, detail: "应用正在退出，已停止接收新请求" }),
} satisfies EnvelopeDialect<unknown>;

/** 信封工厂：safeParse → 记日志 → 退出门闸 → try/route/catch → 按方言与 catch 策略形状化。
 *  产出 (raw: unknown) => Promise<Res> 处理器，各 handleXxx 薄壳保持 (deps, raw) 既有签名（B 类测试与 1708 行断言的公共面） */
export function createChannelHandler<Req, Res extends { ok: boolean }, D extends EnvelopeDeps>(
  opts: {
    /** log scope（= 通道名，错误日志断言锚点；#72 Step4 起由 IPC_CHANNELS 单源传入） */
    scope: string;
    /** 入站请求契约 */
    schema: EnvelopeSchema<Req>;
    /** 错误方言（codeEnvelope / reasonEnvelope） */
    dialect: EnvelopeDialect<Res>;
    /** catch 策略 */
    catchStyle: EnvelopeCatch<Res>;
  },
  deps: D,
  route: (req: Req, deps: D) => Promise<Res>,
): (raw: unknown) => Promise<Res> {
  const { scope, schema, dialect, catchStyle } = opts;
  return async (raw) => {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const detail = summarizeIssues(parsed.error.issues);
      deps.log?.("error", scope, `入站请求不符合契约（${dialect.codeWord}）：${detail}`);
      return dialect.invalidRequest(detail);
    }
    if (deps.isShuttingDown?.()) {
      return dialect.shuttingDown();
    }
    try {
      return await route(parsed.data, deps);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (catchStyle.kind === "adapter-passthrough") {
        // #53：catch 记一条 error（error.code 原样不造新码）；AdapterError 透传 / 其余 E_INTERNAL 的既有形状不变
        const code = err instanceof AdapterError ? err.code : "E_INTERNAL";
        deps.log?.("error", scope, `处理异常（${code}）：${message}`);
        return catchStyle.toError(code, message);
      }
      if (catchStyle.kind === "rethrow") {
        // #53：记一条 error 后原样 rethrow（既有异常向 ipcMain.handle 传播的行为不变，不吞不造码）
        deps.log?.("error", scope, `处理异常：${message}`);
        throw err;
      }
      deps.log?.("error", scope, catchStyle.logMessage(message));
      return catchStyle.toResult(message);
    }
  };
}

/** zod issue 摘要：路径 + 信息，定位到字段（不含堆栈噪音） */
export function summarizeIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
    .join("; ");
}
