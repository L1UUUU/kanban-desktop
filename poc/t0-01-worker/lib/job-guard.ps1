# Job Object guard: create a named job with KILL_ON_JOB_CLOSE, assign the worker host pid into it,
# then wait for host death. When the host dies (any cause incl. taskkill /F), this guard exits,
# its job handle closes, and the OS terminates every remaining process in the job.
# NOTE: ASCII-only on purpose - Windows PowerShell 5.1 parses BOM-less .ps1 as ANSI (GBK), so
# non-ASCII comments corrupt parsing.
param(
  [Parameter(Mandatory = $true)][int]$WorkerPid,
  [Parameter(Mandatory = $true)][string]$JobName
)

$ErrorActionPreference = "Stop"
$src = @'
using System;
using System.Runtime.InteropServices;

public static class JobGuardNative {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int cb);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern int WaitForSingleObject(IntPtr h, int ms);

  [StructLayout(LayoutKind.Sequential)]
  public struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity; public int PriorityClass; public int SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
  }
}
'@
Add-Type -TypeDefinition $src

$job = [JobGuardNative]::CreateJobObject([IntPtr]::Zero, $JobName)
if ($job -eq [IntPtr]::Zero) { Write-Output ("GUARD_ERROR create " + [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()); exit 1 }
$info = New-Object JobGuardNative+JOBOBJECT_EXTENDED_LIMIT_INFORMATION
$info.BasicLimitInformation.LimitFlags = 0x2000 # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
$size = [System.Runtime.InteropServices.Marshal]::SizeOf([type][JobGuardNative+JOBOBJECT_EXTENDED_LIMIT_INFORMATION])
if (-not [JobGuardNative]::SetInformationJobObject($job, 9, [ref]$info, $size)) { Write-Output "GUARD_ERROR setinfo"; exit 1 } # 9 = JobObjectExtendedLimitInformation

# PROCESS_SET_QUOTA(0x0100) | PROCESS_TERMINATE(0x0001) as required by AssignProcessToJobObject
$worker = [JobGuardNative]::OpenProcess(0x0101, $false, $WorkerPid)
if ($worker -eq [IntPtr]::Zero) { Write-Output ("GUARD_ERROR openworker " + [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()); exit 1 }
if (-not [JobGuardNative]::AssignProcessToJobObject($job, $worker)) { Write-Output ("GUARD_ERROR assign " + [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()); exit 1 }
Write-Output "GUARD_READY $JobName"

# SYNCHRONIZE(0x00100000) wait on host handle; returns when host dies in any way (incl. taskkill /F)
$sync = [JobGuardNative]::OpenProcess(0x00100000, $false, $WorkerPid)
if ($sync -eq [IntPtr]::Zero) { Write-Output "GUARD_ERROR opensync"; exit 1 }
$null = [JobGuardNative]::WaitForSingleObject($sync, -1)
Write-Output "GUARD_HOST_DEAD"
# Guard exit closes all its handles; the job's last handle closes; the OS kills all remaining job members.
exit 0
