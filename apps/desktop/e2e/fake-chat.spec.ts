// 用途：Fake 链路 E2E（#6 验收第 3 条自动化）—— 多轮对话 + 审批三键真实改变后续输出 + 取消保留会话 + 权限切换，全部经真 preload/IPC 全链
import { test, expect, _electron, type ElectronApplication, type Page } from "@playwright/test";
import { resolve } from "node:path";

/** 启动应用并等待首会话就绪 */
async function launchApp(): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await _electron.launch({ args: [resolve(__dirname, "..")] });
  const win = await app.firstWindow();
  await expect(win.getByText("演示会话 · Fake")).toBeVisible({ timeout: 15_000 });
  return { app, win };
}

/** 在 composer 输入并发送 */
async function send(win: Page, text: string): Promise<void> {
  await win.getByPlaceholder("输入消息，/ 开头触发 Skill…").fill(text);
  await win.getByRole("button", { name: "发送 ➤" }).click();
}

/** 经项目行「＋」新建 Fake 会话（原型一致项 2：悬浮显示 ＋ → 点击弹菜单） */
async function createSession(win: Page): Promise<void> {
  await win.locator("aside").getByText("kanban-desktop").hover(); // 悬浮项目行显示「＋」
  await win.getByRole("button", { name: "＋" }).click();
  await win.getByText("新建 Fake 会话").click();
  await expect(win.getByText("新会话 · Fake").first()).toBeVisible({ timeout: 10_000 });
}

test("多轮对话：两轮流式 + 工具卡完成 + 权限 chip 三档切换", async () => {
  const { app, win } = await launchApp();

  // 第一轮：流式助手文本 + 工具卡终态（时长/输出）
  await send(win, "把 ipc-schema 的类型拆成独立文件");
  await expect(win.getByText("把 ipc-schema 的类型拆成独立文件")).toBeVisible();
  await expect(win.getByText("好的，我先跑一遍现有测试确认基线，然后开始拆分。")).toBeVisible({ timeout: 20_000 });
  await expect(win.getByText("完成 · 3.6s")).toBeVisible({ timeout: 20_000 });
  await expect(win.getByText(/Tests\s+13 passed/)).toBeVisible();
  await expect(win.getByText("空闲")).toBeVisible({ timeout: 20_000 });

  // 第二轮：会话保留、可继续（多轮）
  await send(win, "第二轮：再确认一遍导出面");
  await expect(win.getByText("第二轮：再确认一遍导出面")).toBeVisible();
  await expect(win.getByText("基线全绿。现在把 chat 与 session 两个命名空间拆成独立文件，并在 index 里保持原导出面不变。")).toBeVisible({
    timeout: 20_000,
  });

  // 权限 chip：三档切换（菜单含说明文案）
  await win.getByText("⚡ 权限：自动 ▾").click();
  await expect(win.getByText("🔒 请求")).toBeVisible();
  await expect(win.getByText("所有工具调用前弹出审批卡片")).toBeVisible();
  await win.getByText("🔒 请求").click();
  await expect(win.getByText("🔒 权限：请求 ▾")).toBeVisible();

  await app.close();
});

test("审批三键：拒绝 / 允许一次（二次仍问）/ 总是允许（二次跳过）", async () => {
  const { app, win } = await launchApp();

  // —— 拒绝：工具被拒 + 道歉文本 + 回到空闲
  await send(win, "审批演示");
  await expect(win.getByText(/⚙ 需要审批：Edit packages\/ipc-schema\/src\/index\.ts/)).toBeVisible({ timeout: 20_000 });
  await expect(win.getByText("等待审批")).toBeVisible();
  await win.getByRole("button", { name: "拒绝" }).click();
  await expect(win.getByText("已拒绝")).toBeVisible({ timeout: 20_000 });
  await expect(win.getByText("好的，我不改这个文件。需要我先列出计划再逐条确认吗？")).toBeVisible({ timeout: 20_000 });
  await expect(win.getByText("空闲").first()).toBeVisible({ timeout: 20_000 });

  // —— 允许一次：仅本次允许 + 第二个审批仍会询问 → 再允许后完成
  await createSession(win);
  await send(win, "审批演示");
  await expect(win.getByText(/⚙ 需要审批：Edit packages\/ipc-schema\/src\/index\.ts/)).toBeVisible({ timeout: 20_000 });
  await win.getByRole("button", { name: "允许一次" }).click();
  await expect(win.getByText(/仅本次允许/)).toBeVisible({ timeout: 20_000 });
  await expect(win.getByText(/⚙ 需要审批：Edit packages\/ipc-schema\/src\/session\/create\.ts/)).toBeVisible({ timeout: 20_000 });
  await win.getByRole("button", { name: "允许一次" }).click();
  await expect(win.getByText("拆分完成，index.ts 的导出面保持不变，测试仍然全绿。")).toBeVisible({ timeout: 20_000 });

  // —— 总是允许：记住规则 + 第二个审批直接跳过
  await createSession(win);
  await expect(win.getByText("新会话 · Fake").nth(1)).toBeVisible({ timeout: 10_000 });
  await send(win, "审批演示");
  await expect(win.getByText(/⚙ 需要审批：Edit packages\/ipc-schema\/src\/index\.ts/)).toBeVisible({ timeout: 20_000 });
  await win.getByRole("button", { name: "总是允许" }).click();
  await expect(win.getByText(/记住规则，后续同类不再询问/).first()).toBeVisible({ timeout: 20_000 });
  await expect(win.getByText("拆分完成，index.ts 的导出面保持不变，测试仍然全绿。")).toBeVisible({ timeout: 20_000 });

  await app.close();
});

test("取消 Turn：停止输出 → 「本轮已取消」+ 已中断，会话保留可继续", async () => {
  const { app, win } = await launchApp();

  await send(win, "默认演示");
  // 流式中：停止按钮出现并点击
  await win.getByRole("button", { name: "⏹ 停止输出" }).click({ timeout: 10_000 });
  await expect(win.getByText("— 本轮已取消，会话保留，可继续发消息 —")).toBeVisible({ timeout: 10_000 });
  await expect(win.getByText("已中断").first()).toBeVisible();

  // 会话保留：可继续发消息并完成
  await send(win, "中断后继续");
  await expect(win.getByText("中断后继续")).toBeVisible();
  await expect(win.getByText("基线全绿。现在把 chat 与 session 两个命名空间拆成独立文件，并在 index 里保持原导出面不变。")).toBeVisible({
    timeout: 20_000,
  });

  await app.close();
});
