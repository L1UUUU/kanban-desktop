// 用途：CliHost 消息面 wire 契约（issue #73）—— 会话级命令的 HostCommand 联合与各 kind 返回值类型由 CliAdapter 接口经映射类型机械派生：接口加命令方法即自动收录，漏 switch case/漏 client 方法即编译红（手写镜像变类型强制镜像）；arch D2 起目录级四命令（createSession/listModels/listCommands/adoptSession）自 CliAdapter 拆出到 CliDirectory，wire 报文顶层携带 cli 参数（payload 仍为 CliDirectory 方法首参，不含 cli 字段；缺省 fake 兜底单点在 worker 内 AdapterRouter.forCli）；纯类型零运行时
import type { CliAdapter, CliDirectory } from "../adapter";

/** 会话级命令方法键（subscribe 为同步订阅面、capabilities 为数据面、forCli 为目录级句柄入口，均非 wire 命令；可选成员 listChildPids/runOnce/cancelRunOnce 一并收录） */
export type CommandKeys = Exclude<keyof CliAdapter, "subscribe" | "capabilities" | "forCli">;

/** 目录级命令键（arch D2）：CliDirectory 四命令的 kind 与 CliAdapter 会话级键无重叠 */
export type DirectoryKeys = keyof CliDirectory;

type Fn = (...args: never[]) => unknown;

/**
 * 单命令 wire 报文：{kind, payload}——payload 即方法首参（零参方法 payload 为 undefined）；
 * 返回值为方法返回值本身（readHistory 直传 ChatEvent[]，无 HostCommandResult 大包袱）。
 * 目录级四命令额外顶层携带 cli（缺省 undefined 透传，由 worker 内 Router.forCli 兜底 fake）。
 */
export type HostCommand =
  | {
      [K in CommandKeys]: { kind: K; payload: Parameters<NonNullable<Extract<CliAdapter[K], Fn>>>[0] };
    }[CommandKeys]
  | {
      [K in DirectoryKeys]: { kind: K; cli?: string; payload: Parameters<NonNullable<Extract<CliDirectory[K], Fn>>>[0] };
    }[DirectoryKeys];

/** 各 kind 的返回值类型（方法返回值的 Awaited；client.send<K> 与 CliHost switch 按此对齐——目录级按 CliDirectory、会话级按 CliAdapter 派生） */
export type ReturnOf<K extends HostCommand["kind"]> = K extends DirectoryKeys
  ? Awaited<ReturnType<NonNullable<Extract<CliDirectory[K], Fn>>>>
  : K extends CommandKeys
    ? Awaited<ReturnType<NonNullable<Extract<CliAdapter[K], Fn>>>>
    : never;
