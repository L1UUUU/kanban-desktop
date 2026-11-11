// 用途：main→renderer 事件发送器工厂 —— 出站 schema 校验（失败 throw，DEV 出站校验语义）+ 目标窗口不在/已销毁静默丢弃（#72 C1 Step3：收敛 index.ts 五处 sendXxx 手抄样板）

/** 出站载荷契约结构面（zod schema 满足此形状；desktop 不直依赖 zod 包，契约单源在 @kanban/ipc-schema） */
export interface EventPayloadSchema<T> {
  parse(payload: unknown): T;
}

/** 事件发送目标窗口的结构面（BrowserWindow 满足；测试注入 fake） */
export interface EventTarget {
  webContents: { send(channel: string, payload: unknown): void };
}

/** 事件发送器工厂：parse 失败 throw / getWindow 返回 null（窗口未建或已销毁）静默丢弃不发 */
export function createValidatedSender<T>(
  schema: EventPayloadSchema<T>,
  channel: string,
  getWindow: () => EventTarget | null,
): (payload: T) => void {
  return (payload) => {
    schema.parse(payload);
    const win = getWindow();
    if (win) win.webContents.send(channel, payload);
  };
}
