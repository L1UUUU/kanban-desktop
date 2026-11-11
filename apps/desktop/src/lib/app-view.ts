// 用途：应用视图联合类型单源（#18 chat/kanban → #34 增 memory → #43 增 diff）—— App.tsx 视图状态与 ChatWorkspace view prop 共享，此前两处手抄联合类型
export type AppView = "chat" | "kanban" | "memory" | "diff";
