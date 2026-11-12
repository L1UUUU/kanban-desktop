// 用途：斜杠命令统一条目契约（issue #89 / spec #82 E 块）—— composer:listCommands 通道载荷形状单源（cli-host 各实现与 renderer 消费方共用；派发形态由后续票按 PoC 结论定夺，本包只管列举）
import { z } from "zod";
import { cliKindSchema } from "./cli-kind";

/** 统一命令条目：名称/描述/参数提示/来源/所属 CLI + 来源文件路径与仅用户调用标记（列举不解析正文，路径供后续派发按需读取） */
export const commandEntrySchema = z.object({
  /** 命令名（不带 / 前缀；菜单展示与派发匹配键） */
  name: z.string().min(1),
  description: z.string(),
  /** 参数提示（如 codex prompt 的 $ARGUMENTS 占位说明；无提示为 null） */
  argsHint: z.string().nullable(),
  /** 来源：user=用户级目录 / project=项目级目录 / native=原生 API 聚合（opencode /command 合并两层，不区分层级） */
  source: z.enum(["user", "project", "native"]),
  /** 所属 CLI（菜单分组与派发路由依据；fake 为演示固定集） */
  cli: cliKindSchema,
  /** 来源文件路径（claude SKILL.md / codex prompt md；opencode 原生 API 无文件为 null） */
  sourcePath: z.string().nullable(),
  /** 仅用户调用标记（claude skill frontmatter disable-model-invocation；true=模型不可自主调用，仅用户 / 触发） */
  userOnly: z.boolean(),
});
export type CommandEntry = z.infer<typeof commandEntrySchema>;
