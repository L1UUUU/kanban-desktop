// 用途：CliHost 消息面 wire 契约（issue #73）—— HostCommand 联合与各 kind 返回值类型由 CliAdapter 接口经映射类型机械派生：接口加命令方法即自动收录，漏 switch case/漏 client 方法即编译红（手写镜像变类型强制镜像）；纯类型零运行时
import type { CliAdapter } from "../adapter";

/** 命令方法键（subscribe 为同步订阅面、capabilities 为数据面，均非命令；可选成员 adoptSession/listChildPids/runOnce/cancelRunOnce 一并收录） */
export type CommandKeys = Exclude<keyof CliAdapter, "subscribe" | "capabilities">;

type Fn = (...args: never[]) => unknown;

/**
 * 单命令 wire 报文：{kind, payload}——payload 即方法首参（零参方法 payload 为 undefined）；
 * 返回值为方法返回值本身（readHistory 直传 ChatEvent[]，无 HostCommandResult 大包袱）。
 */
export type HostCommand = {
  [K in CommandKeys]: { kind: K; payload: Parameters<NonNullable<Extract<CliAdapter[K], Fn>>>[0] };
}[CommandKeys];

/** 各 kind 的返回值类型（方法返回值的 Awaited；client.send<K> 与 CliHost switch 按此对齐） */
export type ReturnOf<K extends CommandKeys> = Awaited<ReturnType<NonNullable<Extract<CliAdapter[K], Fn>>>>;
