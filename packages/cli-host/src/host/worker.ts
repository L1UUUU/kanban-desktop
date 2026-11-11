// 用途：CliHost 的 Electron utilityProcess 入口（ADR-0001 形态）—— parentPort 接线 + {log}/{event} 上报；协议处理经 createPortHandler（issue #73 抽出供密封测试复用）；纯 Node 可加载（不 import electron）
import type { LogKind } from "@kanban/ipc-schema";
import { CliHost } from "./cli-host";
import { createPortHandler, type ParentPortLike } from "./port-handler";
import { createDesktopAdapterFactory } from "./desktop-adapters";

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

// 命令往返与停机监听（issue #73：协议处理器单源，worker 入口只剩 parentPort 接线）
createPortHandler(host, port);
