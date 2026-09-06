# =============================================================================
# =============================================================================

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class W {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint processId);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr LoadKeyboardLayout(string id, uint flags);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO info);
  [DllImport("imm32.dll")] public static extern IntPtr ImmGetContext(IntPtr h);
  [DllImport("imm32.dll")] public static extern IntPtr ImmGetDefaultIMEWnd(IntPtr h);
  [DllImport("imm32.dll")] public static extern bool ImmGetConversionStatus(IntPtr context, out uint conversion, out uint sentence);
  [DllImport("imm32.dll")] public static extern bool ImmSetConversionStatus(IntPtr context, uint conversion, uint sentence);
  [DllImport("imm32.dll")] public static extern bool ImmReleaseContext(IntPtr h, IntPtr context);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, IntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, IntPtr extra);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct GUITHREADINFO {
    public uint cbSize, flags;
    public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret;
    public RECT rcCaret;
  }
}
"@

$MOUSE_LEFTDOWN = 0x0002
$MOUSE_LEFTUP   = 0x0004
$SW_RESTORE     = 9

function Reply($obj) {
  Write-Output ($obj | ConvertTo-Json -Compress -Depth 6)
}

function Prefer-KoreanInput($windowHandle) {
  $h = if ($windowHandle) { [IntPtr][int64]$windowHandle } else { [W]::GetForegroundWindow() }
  if ($h -eq [IntPtr]::Zero) { return @{ ok = $false; error = 'window-not-found' } }
  [void][W]::SetForegroundWindow($h)
  Start-Sleep -Milliseconds 100
  $layout = [W]::LoadKeyboardLayout('00000412', 1)
  if ($layout -eq [IntPtr]::Zero) { return @{ ok = $false; error = 'korean-layout-unavailable' } }
  [void][W]::PostMessage($h, 0x0050, [IntPtr]::Zero, $layout)
  Start-Sleep -Milliseconds 120
  [W]::keybd_event(0x15, 0xF2, 0, [IntPtr]::Zero)
  [W]::keybd_event(0x15, 0xF2, 2, [IntPtr]::Zero)
  return @{ ok = $true }
}

function Get-Windows {
  $out = New-Object System.Collections.ArrayList
  $cb = [W+EnumProc] {
    param($h, $l)
    if ([W]::IsWindowVisible($h)) {
      $sb = New-Object System.Text.StringBuilder 512
      [void][W]::GetWindowTextW($h, $sb, 512)
      $t = $sb.ToString()
      if ($t.Length -gt 1) {
        $r = New-Object W+RECT
        if ([W]::GetWindowRect($h, [ref]$r)) {
          # 너무 작은 창(트레이·유령 창)은 후보에서 제외
          if (($r.Right - $r.Left) -gt 200 -and ($r.Bottom - $r.Top) -gt 200) {
            $ownerPid = [uint32]0
            [void][W]::GetWindowThreadProcessId($h, [ref]$ownerPid)
            [void]$out.Add([pscustomobject]@{
              handle = [int64]$h
              pid    = $ownerPid
              title  = $t
              left   = $r.Left;  top    = $r.Top
              right  = $r.Right; bottom = $r.Bottom
            })
          }
        }
      }
    }
    return $true
  }
  [void][W]::EnumWindows($cb, [IntPtr]::Zero)
  return $out
}

function Find-Target($keyword, $excludePid) {
  if ([string]::IsNullOrWhiteSpace($keyword)) { $keyword = 'Roll20' }
  $all = Get-Windows
  foreach ($w in $all) {
    if ($w.title -like "*$keyword*" -and (!$excludePid -or $w.pid -ne [uint32]$excludePid)) { return $w }
  }
  return $null
}

function Resolve-Target($windowHandle, $keyword, $excludePid) {
  if ($windowHandle) {
    try {
      $h = [IntPtr][int64]$windowHandle
      if ($h -ne [IntPtr]::Zero -and [W]::IsWindow($h) -and [W]::IsWindowVisible($h)) {
        $ownerPid = [uint32]0
        [void][W]::GetWindowThreadProcessId($h, [ref]$ownerPid)
        if (!$excludePid -or $ownerPid -ne [uint32]$excludePid) {
          $sb = New-Object System.Text.StringBuilder 512
          [void][W]::GetWindowTextW($h, $sb, 512)
          $r = New-Object W+RECT
          if ([W]::GetWindowRect($h, [ref]$r)) {
            return [pscustomobject]@{
              handle = [int64]$h
              pid    = $ownerPid
              title  = $sb.ToString()
              left   = $r.Left
              top    = $r.Top
              right  = $r.Right
              bottom = $r.Bottom
            }
          }
        }
      }
    } catch {}
  }

  return Find-Target $keyword $excludePid
}


$script:AutoTargetHwnd = $null
$script:AutoTargetTitle = ''

function Find-BestChatInputInWindow($w) {
  try {
    $h = [IntPtr][int64]$w.handle
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
    if ($null -eq $root) { return $null }

    $all = $root.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.Condition]::TrueCondition
    )

    $windowHeight = [Math]::Max(1, ($w.bottom - $w.top))
    $best = $null
    $bestInfo = $null
    $bestScore = -99999

    for ($i = 0; $i -lt $all.Count; $i++) {
      $el = $all.Item($i)

      try {
        $cur = $el.Current
        $ct = $cur.ControlType.ProgrammaticName -replace '^ControlType\.', ''
        if ($ct -ne 'Edit') { continue }

        $name = [string]$cur.Name
        $className = [string]$cur.ClassName
        $focusable = [bool]$cur.IsKeyboardFocusable
        $enabled = [bool]$cur.IsEnabled
        $offscreen = [bool]$cur.IsOffscreen
        $rect = $cur.BoundingRectangle

        if (-not $focusable -or -not $enabled -or $offscreen) { continue }

        $supportsValue = $false
        $supportsText = $false
        try {
          $p1 = $null
          $supportsValue = $el.TryGetCurrentPattern(
            [System.Windows.Automation.ValuePattern]::Pattern,
            [ref]$p1
          )
        } catch {}
        try {
          $p2 = $null
          $supportsText = $el.TryGetCurrentPattern(
            [System.Windows.Automation.TextPattern]::Pattern,
            [ref]$p2
          )
        } catch {}

        $width = [Math]::Max(0, [int][Math]::Round($rect.Width))
        $height = [Math]::Max(0, [int][Math]::Round($rect.Height))
        $bottom = [int][Math]::Round($rect.Bottom)

        $score = 60
        if ($supportsValue) { $score += 18 }
        if ($supportsText) { $score += 12 }

        if ($className -match '(?i)ui-autocomplete-input') { $score += 120 }
        if ($className -match '(?i)MuiInputBase-inputMultiline') { $score += 120 }

        # 범용 채팅 입력창 이름
        if ($name -match '(?i)message|chat|text input|메시지를 입력|메시지|채팅') {
          $score += 70
        }
        elseif ($name -match '(?i)text|input') {
          $score += 28
        }

        # 브라우저 주소창은 강하게 제외
        if ($className -match '(?i)OmniboxViewViews') { $score -= 300 }

        if ($width -ge 120) { $score += 10 }
        if ($height -ge 20 -and $height -le 180) { $score += 8 }

        $relativeBottom = $bottom - $w.top
        if ($relativeBottom -ge ($windowHeight * 0.55)) { $score += 15 }
        if ($relativeBottom -ge ($windowHeight * 0.75)) { $score += 15 }

        if ($score -gt $bestScore) {
          $bestScore = $score
          $best = $el
          $bestInfo = @{
            score = $score
            name = $name
            className = $className
          }
        }
      }
      catch {}
    }

    if ($null -eq $best -or $bestScore -lt 180) { return $null }

    return @{
      element = $best
      info = $bestInfo
      score = $bestScore
    }
  }
  catch {
    return $null
  }
}


function Get-CachedAutoWindow($excludePid) {
  if (-not $script:AutoTargetHwnd) { return $null }

  try {
    $h = [IntPtr][int64]$script:AutoTargetHwnd
    if ($h -eq [IntPtr]::Zero) { return $null }
    if (-not [W]::IsWindow($h)) { return $null }
    if (-not [W]::IsWindowVisible($h)) { return $null }

    $pid = [uint32]0
    [void][W]::GetWindowThreadProcessId($h, [ref]$pid)
    if ($excludePid -and $pid -eq [uint32]$excludePid) { return $null }

    $r = New-Object W+RECT
    if (-not [W]::GetWindowRect($h, [ref]$r)) { return $null }

    $sb = New-Object System.Text.StringBuilder 512
    [void][W]::GetWindowTextW($h, $sb, 512)

    return @{
      handle = [string][int64]$h
      title = $sb.ToString()
      pid = $pid
      left = $r.Left
      top = $r.Top
      right = $r.Right
      bottom = $r.Bottom
    }
  }
  catch {
    return $null
  }
}

function Clear-AutoTargetCache {
  $script:AutoTargetHwnd = $null
  $script:AutoTargetTitle = ''
}

function Do-UiaAutoSend($pressEnter, $excludePid) {
  try {
    Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
    Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
  }
  catch {
    return @{ ok = $false; error = 'uia-unavailable'; detail = $_.Exception.Message }
  }

  $bestWindow = $null
  $best = $null
  $bestScore = -99999
  $usedCache = $false

  $cachedWindow = Get-CachedAutoWindow $excludePid
  if ($null -ne $cachedWindow) {
    $candidate = Find-BestChatInputInWindow $cachedWindow
    if ($null -ne $candidate) {
      $bestWindow = $cachedWindow
      $best = $candidate
      $bestScore = [int]$candidate.score
      $usedCache = $true
    }
    else {
      Clear-AutoTargetCache
    }
  }
  elseif ($script:AutoTargetHwnd) {
    Clear-AutoTargetCache
  }

  if ($null -eq $bestWindow) {
    $windows = @(Get-Windows | Where-Object {
      !$excludePid -or $_.pid -ne [uint32]$excludePid
    })

    foreach ($w in $windows) {
      $candidate = Find-BestChatInputInWindow $w
      if ($null -eq $candidate) { continue }

      if ([int]$candidate.score -gt $bestScore) {
        $bestScore = [int]$candidate.score
        $bestWindow = $w
        $best = $candidate
      }
    }

    if ($null -ne $bestWindow) {
      $script:AutoTargetHwnd = [string]$bestWindow.handle
      $script:AutoTargetTitle = [string]$bestWindow.title
    }
  }

  if ($null -eq $bestWindow -or $null -eq $best) {
    Clear-AutoTargetCache
    return @{ ok = $false; error = 'uia-input-not-found' }
  }

  $h = [IntPtr][int64]$bestWindow.handle
  if ([W]::IsIconic($h)) {
    [void][W]::ShowWindow($h, $SW_RESTORE)
    Start-Sleep -Milliseconds 80
  }

  [void][W]::SetForegroundWindow($h)
  Start-Sleep -Milliseconds 55

  try {
    $best.element.SetFocus()
  }
  catch {
    Clear-AutoTargetCache
    return @{
      ok = $false
      error = 'uia-focus-failed'
      detail = $_.Exception.Message
    }
  }

  Start-Sleep -Milliseconds 35

  $hasFocus = $false
  try { $hasFocus = [bool]$best.element.Current.HasKeyboardFocus } catch {}
  if (-not $hasFocus) {
    Clear-AutoTargetCache
    return @{ ok = $false; error = 'uia-focus-failed' }
  }

  [System.Windows.Forms.SendKeys]::SendWait('^v')

  if ($pressEnter) {
    Start-Sleep -Milliseconds 35
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  }

  return @{
    ok = $true
    title = $bestWindow.title
    score = $bestScore
    cached = [bool]$usedCache
  }
}

function Do-DirectPick($timeoutSec, $excludePid) {
  if (-not $timeoutSec) { $timeoutSec = 20 }

  while (([W]::GetAsyncKeyState(1) -band 0x8000) -ne 0) {
    Start-Sleep -Milliseconds 20
  }

  $deadline = (Get-Date).AddSeconds($timeoutSec)
  $clicked = $false

  while ((Get-Date) -lt $deadline) {
    if (([W]::GetAsyncKeyState(1) -band 0x8000) -ne 0) {
      $clicked = $true
      break
    }
    if (([W]::GetAsyncKeyState(27) -band 0x8000) -ne 0) {
      return @{ ok = $false; error = 'cancelled' }
    }
    Start-Sleep -Milliseconds 20
  }

  if (-not $clicked) { return @{ ok = $false; error = 'timeout' } }

  $p = New-Object W+POINT
  [void][W]::GetCursorPos([ref]$p)

  $child = [W]::WindowFromPoint($p)
  if ($child -eq [IntPtr]::Zero) {
    return @{ ok = $false; error = 'window-not-found' }
  }

  $root = [W]::GetAncestor($child, 2)
  if ($root -eq [IntPtr]::Zero) { $root = $child }

  $ownerPid = [uint32]0
  [void][W]::GetWindowThreadProcessId($root, [ref]$ownerPid)
  if ($excludePid -and $ownerPid -eq [uint32]$excludePid) {
    return @{ ok = $false; error = 'self-window' }
  }

  $r = New-Object W+RECT
  if (-not [W]::GetWindowRect($root, [ref]$r)) {
    return @{ ok = $false; error = 'window-not-found' }
  }

  $sb = New-Object System.Text.StringBuilder 512
  [void][W]::GetWindowTextW($root, $sb, 512)

  return @{
    ok = $true
    hwnd = [string][int64]$root
    title = $sb.ToString()
    dx = $p.X - $r.Right
    dy = $p.Y - $r.Bottom
    x = $p.X
    y = $p.Y
  }
}

function Do-Send($windowHandle, $keyword, $dx, $dy, $pressEnter, $excludePid) {
  $w = Resolve-Target $windowHandle $keyword $excludePid
  if ($null -eq $w) { return @{ ok = $false; error = 'window-not-found' } }

  $h = [IntPtr]$w.handle
  if ([W]::IsIconic($h)) { [void][W]::ShowWindow($h, $SW_RESTORE); Start-Sleep -Milliseconds 200 }
  [void][W]::SetForegroundWindow($h)
  Start-Sleep -Milliseconds 150

  $r = New-Object W+RECT
  [void][W]::GetWindowRect($h, [ref]$r)
  $cx = $r.Right  + [int]$dx
  $cy = $r.Bottom + [int]$dy

  # 클릭 지점이 창 밖이면 중단 (캔버스 오폭 방지)
  if ($cx -lt $r.Left -or $cx -gt $r.Right -or $cy -lt $r.Top -or $cy -gt $r.Bottom) {
    return @{ ok = $false; error = 'point-outside-window' }
  }

  $old = New-Object W+POINT
  [void][W]::GetCursorPos([ref]$old)

  [void][W]::SetCursorPos($cx, $cy)
  Start-Sleep -Milliseconds 40
  [W]::mouse_event($MOUSE_LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
  [W]::mouse_event($MOUSE_LEFTUP,   0, 0, 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 80

  [System.Windows.Forms.SendKeys]::SendWait('^v')
  if ($pressEnter) {
    Start-Sleep -Milliseconds 80
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  }

  Start-Sleep -Milliseconds 40
  [void][W]::SetCursorPos($old.X, $old.Y)

  return @{ ok = $true; x = $cx; y = $cy }
}

Reply @{ ready = $true }

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ([string]::IsNullOrWhiteSpace($line)) { continue }

  $id = $null
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id

    switch ($req.cmd) {
      'ping' { Reply @{ id = $id; ok = $true } }

      'list' {
        $ws = Get-Windows | Where-Object { !$req.excludePid -or $_.pid -ne [uint32]$req.excludePid } |
              ForEach-Object { @{ title = $_.title; handle = [string]$_.handle; pid = $_.pid } }
        Reply @{ id = $id; ok = $true; windows = @($ws) }
      }
      'pick-direct' {
        $res = Do-DirectPick $req.timeout $req.excludePid
        $res.id = $id
        Reply $res
      }

      'uia-auto-send' {
        $res = Do-UiaAutoSend ([bool]$req.enter) $req.excludePid
        $res.id = $id
        Reply $res
      }

      'send' {
        $res = Do-Send $req.hwnd $req.match $req.dx $req.dy ([bool]$req.enter) $req.excludePid
        $res.id = $id
        Reply $res
      }
      'prefer-korean' {
        $res = Prefer-KoreanInput $req.hwnd
        $res.id = $id
        Reply $res
      }

      default { Reply @{ id = $id; ok = $false; error = 'unknown-command' } }
    }
  }
  catch {
    Reply @{ id = $id; ok = $false; error = "$_" }
  }
}
