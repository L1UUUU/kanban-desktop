# Open an existing named Job Object and list its member pids via
# QueryInformationJobObject(JobObjectBasicProcessIdList). Prints "MEMBERS <csv>" on stdout.
# Layout: ULONG_PTR NumberOfAssignedProcesses; ULONG_PTR NumberOfProcessIdsInList; ULONG_PTR ProcessIdList[1]
# NOTE: ASCII-only on purpose - Windows PowerShell 5.1 parses BOM-less .ps1 as ANSI (GBK).
param(
  [Parameter(Mandatory = $true)][string]$JobName
)

$ErrorActionPreference = "Stop"
$src = @'
using System;
using System.Runtime.InteropServices;

public static class JobQueryNative {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr OpenJobObject(uint desiredAccess, bool inheritHandle, string lpName);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool QueryInformationJobObject(IntPtr hJob, int infoClass, IntPtr info, int cb, out IntPtr returned);
}
'@
Add-Type -TypeDefinition $src

# JOB_OBJECT_QUERY = 0x0004
$job = [JobQueryNative]::OpenJobObject(0x0004, $false, $JobName)
if ($job -eq [IntPtr]::Zero) { Write-Output ("QUERY_ERROR open " + [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()); exit 1 }

# Layout (winnt.h JOBOBJECT_BASIC_PROCESS_ID_LIST, x64):
#   ULONG     NumberOfAssignedProcesses   @0 (32-bit)
#   ULONG     NumberOfProcessIdsInList    @4 (32-bit)
#   ULONG_PTR ProcessIdList[1]            @8 (64-bit stride)
$maxPids = 1024
$cb = 8 + 8 * $maxPids
$buf = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($cb)
try {
  # zero the buffer, then query member pid list (infoClass 3 = JobObjectBasicProcessIdList)
  for ($off = 0; $off -lt $cb; $off += 8) { [System.Runtime.InteropServices.Marshal]::WriteInt64($buf, $off, 0) }
  $ret = [IntPtr]::Zero
  if (-not [JobQueryNative]::QueryInformationJobObject($job, 3, $buf, $cb, [ref]$ret)) { Write-Output "QUERY_ERROR query"; exit 1 }
  $n = [System.Runtime.InteropServices.Marshal]::ReadInt32($buf, 4)
  if ($n -lt 0 -or $n -gt $maxPids) { Write-Output ("QUERY_ERROR count " + $n); exit 1 }
  $pids = @()
  for ($i = 0; $i -lt $n; $i++) { $pids += [System.Runtime.InteropServices.Marshal]::ReadInt64($buf, 8 + 8 * $i) }
  Write-Output ("MEMBERS " + ($pids -join ","))
} finally {
  [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buf)
}
exit 0
