// 用途：声明式桥接工厂（arch D8）—— 一张「通道 + schema」声明表从 window.api 生成带 DEV 校验的 transport 面；工厂自身不含任何具体通道知识（schema 单源 @kanban/ipc-schema，通道名单源 preload）
import type { DesktopApi } from "../../preload/index";
import { createScopedLogger } from "./logger";

// 本文件日志出口（scope 固定 transport，经 lib/logger 唯一出口发出）
const log = createScopedLogger("transport");

/** DEV 校验面：zod schema 的最小结构面（parse/safeParse），zod 类型封装留在 @kanban/ipc-schema 内不外漏 */
export interface DevSchema {
  parse(value: unknown): unknown;
  safeParse(value: unknown): { success: true } | { success: false; error: { issues: unknown } };
}

/** 出站 invoke 声明：一行 = 一条带 DEV 请求校验的 invoke 通道 */
export interface InvokeSpec {
  /** window.api 上的调用通道名（错名编译期即被 DesktopApi 键拦下） */
  channel: keyof DesktopApi;
  /** 出站请求 schema（DEV parse 失败 warn 后重抛；生产不校验） */
  schema: DevSchema;
  /** DEV 校验失败日志标签（warn 消息为 `${label}不符合 schema`） */
  label: string;
}

/** 入站事件订阅声明：一行 = 一条带 DEV 载荷校验的订阅通道 */
export interface EventSpec {
  /** window.api 上的订阅通道名（handler 转发，返回注销函数） */
  channel: keyof DesktopApi;
  /** 事件载荷 schema（DEV safeParse 失败仅 warn，不阻断分发） */
  schema: DevSchema;
  /** DEV 校验失败 warn 全文 */
  message: string;
}

/** invoke 声明表 → 生成面：成员类型 = window.api 对应通道方法的类型 */
type InvokeFace<I extends Record<string, InvokeSpec>> = {
  [K in keyof I]: DesktopApi[I[K]["channel"]];
};

/** 订阅声明表 → 生成面：成员类型 = window.api 对应订阅方法的类型 */
type EventFace<E extends Record<string, EventSpec>> = {
  [K in keyof E]: DesktopApi[E[K]["channel"]];
};

/** dev 态出站校验（#55 迁移）：失败经统一日志记 warn 后原样重抛，保持既有 dev-only throw 语义 */
function devCheck(parse: () => void, label: string): void {
  try {
    parse();
  } catch (e) {
    log.warn(`${label}不符合 schema`, { issues: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

/**
 * 声明驱动生成 transport：invoke 声明各生成「DEV 请求校验 + 转发」成员，订阅声明各生成
 * 「DEV 载荷校验（仅 warn）+ 分发」成员；生产（非 DEV）零校验直转，与手写桥接行为逐字等价。
 */
export function bridged<I extends Record<string, InvokeSpec>, E extends Record<string, EventSpec>>(
  api: DesktopApi,
  spec: { invoke?: I; events?: E },
): InvokeFace<I> & EventFace<E> {
  const face: Record<string, unknown> = {};
  for (const [member, decl] of Object.entries(spec.invoke ?? {})) {
    const call = api[decl.channel] as (req: unknown) => Promise<unknown>;
    face[member] = async (req: unknown) => {
      if (import.meta.env.DEV) devCheck(() => decl.schema.parse(req), decl.label);
      return call(req);
    };
  }
  for (const [member, decl] of Object.entries(spec.events ?? {})) {
    const subscribe = api[decl.channel] as (handler: (event: unknown) => void) => () => void;
    face[member] = (handler: (event: unknown) => void) =>
      subscribe((event) => {
        if (import.meta.env.DEV) {
          const parsed = decl.schema.safeParse(event);
          if (!parsed.success) log.warn(decl.message, { issues: JSON.stringify(parsed.error.issues) });
        }
        handler(event);
      });
  }
  return face as InvokeFace<I> & EventFace<E>;
}
