// 用途：Windows KILL_ON_JOB_CLOSE Job guard PowerShell 脚本（t0-01 T1 实证语义；#29 起为单一事实源，desktop cli-host-client 与 e2e Job 覆盖验证共用）—— guard 持 job 句柄等宿主(main)死亡后退出 → 句柄关 → OS 终止 job 内全部 CLI 子孙进程（worker 内 spawn 的一次性进程自动入 job）
// 修正记录（#29）：历史版本把 C# 结构体字段缩写为 LF 但赋值仍写 .LimitFlags（PS PropertyAssignmentException → guard 必然 exit 1，Job 保护从未生效且静默），且 TargetPid 句柄权限 0x0010 非 SYNCHRONIZE；本版按 t0-01 原版语义修正（字段名全程一致 + 0x00100000）
// 修正记录（#45 实证发现）：`$info.B.LimitFlags = …` 是 PS 5.1 嵌套 struct 赋值经典静默无效（读取 $info.B 副本上改，改动随副本丢弃）——guard 不再崩溃但 KILL_ON_JOB_CLOSE 从未布防，强杀宿主后 CLI 子孙进程全部存活（本机实证：JobObjectBasicLimitInformation 读回 LimitFlags=0x0，job 销毁后成员存活）。修法：先取副本改完再整体拷回（$__b = $info.B; $__b.LimitFlags = …; $info.B = $__b）；修正后实证 LimitFlags=0x2000、job 销毁成员全灭。门控 e2e force-kill-job 按 job 名查询 LimitFlags+成员清单作回归。
/** ASCII-only 防 PS5.1 ANSI 解析坑（无 BOM 文件被 PS 5.1 按 ANSI 解析，ASCII 内容两种解析等价） */
export const JOB_GUARD_PS = [
  "param(",
  "  [Parameter(Mandatory = $true)][int]$MemberPid,",
  "  [Parameter(Mandatory = $true)][int]$TargetPid,",
  "  [Parameter(Mandatory = $true)][string]$JobName",
  ")",
  "$ErrorActionPreference = 'Stop'",
  "$src = @'",
  "using System;",
  "using System.Runtime.InteropServices;",
  "public static class JobGuardNative {",
  "  [DllImport(\"kernel32.dll\", CharSet = CharSet.Unicode, SetLastError = true)]",
  "  public static extern IntPtr CreateJobObject(IntPtr a, string n);",
  "  [DllImport(\"kernel32.dll\", SetLastError = true)]",
  "  public static extern bool SetInformationJobObject(IntPtr h, int c, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION i, int cb);",
  "  [DllImport(\"kernel32.dll\", SetLastError = true)]",
  "  public static extern bool AssignProcessToJobObject(IntPtr h, IntPtr p);",
  "  [DllImport(\"kernel32.dll\", SetLastError = true)]",
  "  public static extern IntPtr OpenProcess(uint a, bool i, int pid);",
  "  [DllImport(\"kernel32.dll\", SetLastError = true)]",
  "  public static extern int WaitForSingleObject(IntPtr h, int ms);",
  "  [StructLayout(LayoutKind.Sequential)]",
  "  public struct IO_COUNTERS { public ulong R, W, O, RT, WT, OT; }",
  "  [StructLayout(LayoutKind.Sequential)]",
  "  public struct JOBOBJECT_BASIC_LIMIT_INFORMATION { public long PUT, JUT; public uint LimitFlags; public UIntPtr MWS, XWS; public uint APL; public UIntPtr AF; public int PC, SC; }",
  "  [StructLayout(LayoutKind.Sequential)]",
  "  public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { public JOBOBJECT_BASIC_LIMIT_INFORMATION B; public IO_COUNTERS IO; public UIntPtr PM, JM, PP, PJ; }",
  "}",
  "'@",
  "Add-Type -TypeDefinition $src",
  "$job = [JobGuardNative]::CreateJobObject([IntPtr]::Zero, $JobName)",
  "if ($job -eq [IntPtr]::Zero) { exit 1 }",
  "$info = New-Object JobGuardNative+JOBOBJECT_EXTENDED_LIMIT_INFORMATION",
  "$__b = $info.B", // PS 5.1 嵌套 struct 字段赋值静默无效（#45 实证）：必须副本改完整体拷回
  "$__b.LimitFlags = 0x2000", // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
  "$info.B = $__b",
  "$size = [System.Runtime.InteropServices.Marshal]::SizeOf([type][JobGuardNative+JOBOBJECT_EXTENDED_LIMIT_INFORMATION])",
  "if (-not [JobGuardNative]::SetInformationJobObject($job, 9, [ref]$info, $size)) { exit 1 }",
  "$member = [JobGuardNative]::OpenProcess(0x0101, $false, $MemberPid)", // PROCESS_SET_QUOTA|PROCESS_TERMINATE（AssignProcessToJobObject 要求）
  "if ($member -eq [IntPtr]::Zero) { exit 1 }",
  "if (-not [JobGuardNative]::AssignProcessToJobObject($job, $member)) { exit 1 }",
  "$target = [JobGuardNative]::OpenProcess(0x00100000, $false, $TargetPid)", // SYNCHRONIZE（等待句柄必需权限；0x0010 是 VM_READ 会立刻 WAIT_FAILED）
  "if ($target -eq [IntPtr]::Zero) { exit 0 }",
  "[void][JobGuardNative]::WaitForSingleObject($target, -1)",
].join("\n");
