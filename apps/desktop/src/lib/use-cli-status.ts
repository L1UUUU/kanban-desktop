// 用途：「＋」新建菜单 CLI 安装状态小控制器（#80，spec #75 实现决策 7）—— 两处菜单（侧栏项目「＋」/详情面板「＋新建会话」）共享的禁用逻辑：菜单打开时经 cli:status 通道拉取三真实 CLI 安装表；结果未回/桥不可用（jsdom 降级）/查询失败一律不拦菜单（点击后由创建链报错），fake/pty 恒可选不入判定
import { useEffect, useState } from "react";
import type { CliInstalledMap, CliKind } from "@kanban/ipc-schema";

/** 未装项悬停说明（spec：可悬停查看说明） */
export const CLI_NOT_INSTALLED_HINT = "未安装该 CLI，安装后重新打开菜单即可选用";

/**
 * 菜单打开期间拉取安装表：active=false（菜单关闭）不查询；每次打开重新拉取（main 侧未装不缓存——重开即重探）。
 * 返回 null = 尚无结果（不拦菜单）。
 */
export function useCliInstallStatus(active: boolean): CliInstalledMap | null {
  const [installed, setInstalled] = useState<CliInstalledMap | null>(null);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const api = window.api;
    if (!api?.invokeCliStatus) return; // 桥不可用（jsdom/降级）：保持不拦菜单
    api
      .invokeCliStatus({ channel: "cli:status" })
      .then((r) => {
        if (!cancelled && r.ok) setInstalled(r.installed);
      })
      .catch(() => undefined); // 查询失败不拦菜单，点击后由创建链报错
    return () => {
      cancelled = true;
    };
  }, [active]);
  return installed;
}

/** 禁用判定：仅三真实 CLI 的显式 false 才灰置（fake/pty 无探测恒可选；结果未回不拦） */
export function isCliUnavailable(installed: CliInstalledMap | null, cli: CliKind): boolean {
  if (!installed) return false;
  // fake 恒可用先行返回：CliKind 含 fake 而 CliInstalledMap 仅三真实 CLI，显式收窄替代宽化 cast
  if (cli === "fake") return false;
  return installed[cli] === false;
}
