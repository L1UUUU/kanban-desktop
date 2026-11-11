// 用途：worker 协议处理器（issue #73 从 worker.ts 抽出）—— parentPort 消息面命令往返 {id,cmd:{kind,payload}}→{id,ok,result|error} 与 {shutdown:{reason}} 停机；纯 Node 可加载，供 worker 入口与密封 roundtrip 测试注入同一协议实现
import type { CliHost } from "./cli-host";
import type { HostCommand } from "./wire";

/** Electron utilityProcess 运行时注入的 parentPort 面（结构性类型声明，避免依赖 electron 模块） */
export interface ParentPortLike {
  on(event: "message", listener: (e: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

/** 注册命令往返与停机两组 message 监听（worker 入口与密封测试共用，协议单源） */
export function createPortHandler(host: CliHost, port: ParentPortLike): void {
  // 命令往返：{id, cmd} → {id, ok, result} | {id, ok:false, error:{code,message}}（result 为方法返回值本身，issue #73）
  port.on("message", (e) => {
    const { id, cmd } = e.data as { id?: number | string; cmd?: HostCommand };
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
}
