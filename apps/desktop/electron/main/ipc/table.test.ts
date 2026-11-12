// 用途：子通道查表密封测试 —— 编译期穷尽性 type 级断言（删任一 feature handler 或 schema 加成员即编译失败）+ 查表分发行为冒烟（#72 C1 Step2）
import { describe, expect, expectTypeOf, it } from "vitest";
import type { IpcRequest, IpcResult } from "@kanban/ipc-schema";
import type { IpcDeps } from "../ipc";
import { allKanbanHandlers, routeByTable, type SubChannelHandlers } from "./table";

describe("子通道路由表：编译期穷尽（#72）", () => {
  it("总表类型 = 27 子通道全量映射（project 3 + session 11 + terminal 4 + kanban 7 + composer 1；漏任一 handler 编译失败）", () => {
    expectTypeOf(allKanbanHandlers).toEqualTypeOf<SubChannelHandlers<IpcRequest, IpcResult, IpcDeps>>();
    // 通道成员清点：schema 删通道或子表漏成员时，上方 type 断言先在编译期红；此处运行期兜底计数
    expect(Object.keys(allKanbanHandlers)).toHaveLength(27);
  });
});

describe("查表分发行为冒烟（穷尽性由 type 断言保证，此处仅验证分发语义）", () => {
  it("routeByTable 按判别成员取对应 handler（req/deps 原样透传）", async () => {
    type DemoRequest = { channel: "a:one"; n: number } | { channel: "a:two"; s: string };
    const seen: string[] = [];
    const table: SubChannelHandlers<DemoRequest, string, { marker: string }> = {
      "a:one": async (req, deps) => {
        seen.push(`one:${req.n}:${deps.marker}`);
        return "r1";
      },
      "a:two": async (req, deps) => {
        seen.push(`two:${req.s}:${deps.marker}`);
        return "r2";
      },
    };
    const deps = { marker: "d" };
    expect(await routeByTable(table, deps, { channel: "a:one", n: 9 })).toBe("r1");
    expect(await routeByTable(table, deps, { channel: "a:two", s: "x" })).toBe("r2");
    expect(seen).toEqual(["one:9:d", "two:x:d"]);
  });
});
