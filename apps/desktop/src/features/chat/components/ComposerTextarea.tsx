// 用途：带斜杠补全菜单的 composer 输入框（issue #90 / spec #82 E 块）—— 会话 Composer 与草稿 DraftPane 共用：textarea + 上方补全菜单（触发/键盘/IME 由 use-slash-menu 状态机持有）；占位符文案单源（e2e 定位器依赖，勿散抄）
import { useRef } from "react";
import type { CliKind } from "@kanban/ipc-schema";
import type { ComposerCommandSource } from "../composer-command-source";
import type { MenuCommand } from "./slash-trigger";
import { SlashMenu } from "./SlashMenu";
import { useSlashMenu } from "./use-slash-menu";

export const COMPOSER_PLACEHOLDER = "输入消息，/ 开头触发 Skill…";

export interface ComposerTextareaProps {
  value: string;
  onChange(next: string): void;
  commands: ComposerCommandSource;
  cli: CliKind;
  /** 命令目录拉取 cwd（null = 不拉取不弹菜单） */
  cwd: string | null;
  disabled?: boolean;
  rows?: number;
  /** 选中命令回调（#92 执行接线数据面） */
  onAcceptCommand?(cmd: MenuCommand): void;
}

/** composer 输入框 + 斜杠补全菜单（菜单绝对定位于输入框上方；焦点永不离输入框） */
export function ComposerTextarea({ value, onChange, commands, cli, cwd, disabled = false, rows = 2, onAcceptCommand }: ComposerTextareaProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const slash = useSlashMenu({ value, onChange, source: commands, cli, cwd, disabled, onAcceptCommand, textareaRef });
  return (
    <div className="relative w-full">
      <textarea
        ref={textareaRef}
        placeholder={COMPOSER_PLACEHOLDER}
        rows={rows}
        disabled={disabled}
        value={value}
        onChange={slash.onChange}
        onKeyDown={slash.onKeyDown}
        onCompositionStart={slash.onCompositionStart}
        onCompositionEnd={slash.onCompositionEnd}
        onSelect={slash.onSelect}
        className="min-h-[46px] w-full resize-none bg-transparent text-[13px] outline-none placeholder:text-fg-faint disabled:text-muted-foreground"
      />
      {slash.menu.open ? (
        <SlashMenu items={slash.menu.items} highlight={slash.menu.highlight} onHover={slash.menu.onHover} onAccept={slash.menu.onAccept} />
      ) : null}
    </div>
  );
}
