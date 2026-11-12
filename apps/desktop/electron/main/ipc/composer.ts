// 用途：composer 子通道路由表 —— composer:listCommands（issue #89 / spec #82 E 块）：斜杠命令列举经 CommandCatalog（短 TTL 缓存，重复调用不重复扫描；缓存只服务列举，发送/派发判定不依赖）；composer:expandCommand（issue #92）：codex 展开类派发的 Main 侧读文件 + 占位符替换（文件不可读 E_INTERNAL fail-closed，不静默）
import { readFileSync } from "node:fs";
import type { IpcRequest, IpcResult } from "@kanban/ipc-schema";
import { AdapterError, expandCodexPromptCommand } from "@kanban/cli-host";
import { CommandCatalog } from "../command-catalog";
import type { IpcDeps } from "../ipc";
import type { SubChannelHandlers } from "./table";

/** composer:* 请求子集 */
export type ComposerRequest = Extract<IpcRequest, { channel: `composer:${string}` }>;

/** deps.commandCatalog 缺省目录：按 adapter 记忆化（生产单 adapter 生命周期即单目录；显式注入见 IpcDeps.commandCatalog） */
const defaultCatalogs = new WeakMap<IpcDeps["adapter"], CommandCatalog>();

function catalogFor(deps: IpcDeps): CommandCatalog {
  if (deps.commandCatalog) return deps.commandCatalog;
  let catalog = defaultCatalogs.get(deps.adapter);
  if (!catalog) {
    catalog = new CommandCatalog({ adapter: deps.adapter });
    defaultCatalogs.set(deps.adapter, catalog);
  }
  return catalog;
}

/** composer 通道 handler 子表（#89 列举 + #92 展开） */
export const composerHandlers: SubChannelHandlers<ComposerRequest, IpcResult, IpcDeps> = {
  "composer:listCommands": async (req, deps) => ({
    ok: true,
    commands: await catalogFor(deps).list(req.cli, req.cwd),
  }),
  "composer:expandCommand": async (req) => {
    // 读来源文件 + 展开为普通文本；不可读明确报错（fail-closed，调用方走错误卡片，不静默发原文）
    let fileText: string;
    try {
      fileText = readFileSync(req.sourcePath, "utf8");
    } catch (err) {
      throw new AdapterError("E_INTERNAL", `斜杠命令文件不可读（${req.sourcePath}）：${err instanceof Error ? err.message : String(err)}`);
    }
    return { ok: true, text: expandCodexPromptCommand(fileText, req.args) };
  },
};
