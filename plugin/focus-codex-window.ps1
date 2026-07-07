$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class Win32Focus {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsZoomed(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr SetFocus(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();
}
"@

$SW_RESTORE = 9
$SW_SHOWMAXIMIZED = 3
$matches = New-Object System.Collections.Generic.List[object]

function Get-WindowTitle {
    param([IntPtr]$Hwnd)

    $length = [Win32Focus]::GetWindowTextLength($Hwnd)
    if ($length -le 0) {
        return ""
    }

    $builder = New-Object System.Text.StringBuilder ($length + 1)
    [void][Win32Focus]::GetWindowText($Hwnd, $builder, $builder.Capacity)
    return $builder.ToString().Trim()
}

function Get-ProcessPath {
    param([uint32]$ProcessIdValue)

    try {
        return (Get-Process -Id $ProcessIdValue -ErrorAction Stop).Path
    } catch {
        return ""
    }
}

$callback = [Win32Focus+EnumWindowsProc]{
    param([IntPtr]$Hwnd, [IntPtr]$LParam)

    if (-not [Win32Focus]::IsWindowVisible($Hwnd)) {
        return $true
    }

    $pidRef = 0
    [void][Win32Focus]::GetWindowThreadProcessId($Hwnd, [ref]$pidRef)
    if ($pidRef -le 0) {
        return $true
    }

    $title = Get-WindowTitle -Hwnd $Hwnd
    $imagePath = [string](Get-ProcessPath -ProcessIdValue $pidRef)
    $imageNameRaw = [System.IO.Path]::GetFileName($imagePath)
    $imageName = if ($imageNameRaw) { $imageNameRaw.ToLowerInvariant() } else { "" }
    $imagePathLower = if ($imagePath) { $imagePath.ToLowerInvariant() } else { "" }

    $isCodex = ($title -eq "Codex" -and $imageName -eq "codex.exe") -or
        ($imageName -eq "codex.exe" -and $imagePathLower.Contains("\openai.codex_"))

    if ($isCodex) {
        $priority = if ($title -eq "Codex") { 0 } else { 1 }
        $matches.Add([pscustomobject]@{ Priority = $priority; Hwnd = $Hwnd }) | Out-Null
    }

    return $true
}

[void][Win32Focus]::EnumWindows($callback, [IntPtr]::Zero)

if ($matches.Count -eq 0) {
    exit 2
}

$target = ($matches | Sort-Object Priority | Select-Object -First 1).Hwnd
$currentThread = [Win32Focus]::GetCurrentThreadId()
$targetPid = 0
$targetThread = [Win32Focus]::GetWindowThreadProcessId($target, [ref]$targetPid)
$foreground = [Win32Focus]::GetForegroundWindow()
$foregroundPid = 0
$foregroundThread = if ($foreground -ne [IntPtr]::Zero) {
    [Win32Focus]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid)
} else {
    0
}

$attached = New-Object System.Collections.Generic.List[uint32]
foreach ($threadId in @($targetThread, $foregroundThread)) {
    if ($threadId -ne 0 -and $threadId -ne $currentThread) {
        if ([Win32Focus]::AttachThreadInput($currentThread, $threadId, $true)) {
            $attached.Add($threadId) | Out-Null
        }
    }
}

try {
    if ([Win32Focus]::IsIconic($target)) {
        [void][Win32Focus]::ShowWindow($target, $SW_RESTORE)
    } elseif ([Win32Focus]::IsZoomed($target)) {
        [void][Win32Focus]::ShowWindow($target, $SW_SHOWMAXIMIZED)
    }

    [void][Win32Focus]::BringWindowToTop($target)
    $ok = [Win32Focus]::SetForegroundWindow($target)
    [void][Win32Focus]::SetFocus($target)
    if (-not $ok) {
        exit 3
    }
} finally {
    foreach ($threadId in $attached) {
        [void][Win32Focus]::AttachThreadInput($currentThread, $threadId, $false)
    }
}
