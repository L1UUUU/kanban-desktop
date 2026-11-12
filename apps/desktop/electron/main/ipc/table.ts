// 用途：kanban:ipc 子通道查表 —— 类型驱动的路由表（编译期穷尽：schema 加成员/删 handler 即编译失败，#72 C1 Step2 替代 25 case switch）+ 四 feature 子表合并总表
import type { IpcRequest, IpcResult } from "@kanban/ipc-schema";
import type { IpcDeps } from "../ipc";
import { composerHandlers } from "./composer";
import { kanbanBoardHandlers } from "./kanban-board";
import { projectHandlers } from "./project";
import { sessionHandlers } from "./sessions";
import { terminalHandlers } from "./terminals";

/** 子通道路由表类型：channel 判别成员 → handler（映射类型保证穷尽——漏任一成员的 handler 即编译失败） */
export type SubChannelHandlers<Req extends { channel: string }, Res, D> = {
  [K in Req["channel"] & string]: (req: Extract<Req, { channel: K }>, deps: D) => Promise<Res>;
};

/** 查表分发：table[req.channel](req, deps)；穷尽性由 SubChannelHandlers 映射类型在表定义处保证，switch 消失 */
export function routeByTable<Req extends { channel: string }, Res, D>(
  table: SubChannelHandlers<Req, Res, D>,
  deps: D,
  req: Req,
): Promise<Res> {
  // 相关记录索引访问的 TS 局限（单点收敛断言）：req.channel 求值期必为表的某个键，对应 handler 的入参 Extract<Req,{channel:K}> 必然兼容该 req
  const handler = table[req.channel as keyof typeof table] as unknown as (req: Req, deps: D) => Promise<Res>;
  return handler(req, deps);
}

/** kanban:ipc 总表 = 五个 feature 子表合并（27 子通道：project 3 + session 12 + terminal 4 + kanban 7 + composer 1；漏任一即此处编译失败） */
export const allKanbanHandlers: SubChannelHandlers<IpcRequest, IpcResult, IpcDeps> = {
  ...projectHandlers,
  ...sessionHandlers,
  ...terminalHandlers,
  ...kanbanBoardHandlers,
  ...composerHandlers,
};
