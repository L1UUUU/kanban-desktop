// 用途：CliHost 的 Electron utilityProcess 入口（ADR-0001 形态）—— parentPort 消息协议 {id,cmd}→{id,ok,result|error} 与事件 {event}；纯 Node 可加载（不 import electron）
import type { LogKind } from "@kanban/ipc-schema";
import { CliHost, type HostCommand } from "./cli-host";
import { createDesktopAdapterFactory } from "./desktop-adapters";

/** Electron utilityProcess 运行时注入的 parentPort 面（结构性类型声明，避免依赖 electron 模块） */
interface ParentPortLike {
  on(event: "message", listener: (e: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

const port = (process as unknown as { parentPort?: ParentPortLike }).parentPort;
if (!port) {
  // 直接以 node 运行本文件（无 utilityProcess 宿主）：明确报错退出
  console.error("cli-host-worker 须由 Electron utilityProcess 加载（无 parentPort）");
  process.exit(1);
}

// #54（spec #52 B 节）：诊断上报目标 —— (kind, detail) 2 参回调签名不变，改为向父端口发 {log} 消息（与事件/命令响应/停机消息并列，不进 HostCommand；级别映射与落盘归 Main，本文件保持纯 Node，ADR-0001）
const reportLog = (kind: LogKind, detail: string): void => {
  port.postMessage({ log: { kind, detail } });
};

const host = new CliHost(
  createDesktopAdapterFactory({
    cacheDir: process.env.KANBAN_DATA_DIR,
    log: reportLog,
  }),
  reportLog,
);

// 事件流 → 宿主（worker→main 方向，ADR-0001 实测 34k+ events/s 余量充足）
host.subscribe((event) => port.postMessage({ event }));

// 命令往返：{id, cmd} → {id, ok, result} | {id, ok:false, error:{code,message}}
port.on("message", (e) => {
  const { id, cmd } = e.data as { id: number | string; cmd: HostCommand };
  if (id === undefined || !cmd) return;
  void host
    .command(cmd)
    .then((result) => port.postMessage({ id, ok: true, result }))
    .catch((err) => {
      const shape =
        err && typeof err === "object" && "code" in err
          ? { code: String(err.code), message: err instanceof Error ? err.message : String(err) }
          : { code: "E_INTERNAL", message: err instanceof Error ? err.message : String(err) };
      port.postMessage({ id, ok: false, error: shape });
    });
});

// 宿主请求停机：{shutdown:{reason}}
port.on("message", (e) => {
  const shutdown = (e.data as { shutdown?: { reason: string } }).shutdown;
  if (shutdown) {
    void host.shutdown({ reason: shutdown.reason }).finally(() => {
      process.exit(0);
    });
  }
});
