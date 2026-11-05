// 本地最小 UI 基础件：替换上游 components/ui.tsx（855 行）中被
// TurnChangesCard 用到的 Button 与 cx 两个导出。
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function Button({
  variant = "default",
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "ghost" }) {
  return (
    <button
      type="button"
      className={cx("demo-button", variant === "ghost" && "demo-button-ghost", className)}
      {...rest}
    />
  );
}
