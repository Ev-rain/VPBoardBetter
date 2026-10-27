param(
  [Parameter(Mandatory=$true)][string]$Profile,
  [string]$Action = 'hide'
)

$ErrorActionPreference = 'SilentlyContinue'

Add-Type -AssemblyName System.Core
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class WinHide
{
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int max);

    public static List<IntPtr> Find(int[] pids)
    {
        var set = new HashSet<int>(pids);
        var found = new List<IntPtr>();
        EnumWindows(delegate(IntPtr h, IntPtr l)
        {
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            if (!set.Contains((int)pid)) return true;
            var cls = new StringBuilder(256);
            GetClassName(h, cls, 256);
            if (cls.ToString() != "Chrome_WidgetWin_1") return true;
            found.Add(h);
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
'@

$procs = Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($Profile) }
$pids = @($procs | Select-Object -ExpandProperty ProcessId)
if (-not $pids.Count) { Write-Output 'no-profile'; exit 0 }

$wins = [WinHide]::Find([int[]]$pids)
if (-not $wins.Count) { Write-Output 'no-window'; exit 0 }

$n = 0
foreach ($h in $wins) {
    if ($Action -eq 'hide') {
        [void][WinHide]::ShowWindow($h, 0)   # SW_HIDE
        $n++
    } else {
        [void][WinHide]::ShowWindow($h, 5)   # SW_SHOW
        $n++
    }
}

$vis = 0
foreach ($h in $wins) { if ([WinHide]::IsWindowVisible($h)) { $vis++ } }
Write-Output ("{0} {1} visible={2}" -f $Action, $n, $vis)
