# =============================================================================
#  Roll20 Organizer - Windows 브리지
#
#  stdin 으로 JSON 한 줄을 받고 stdout 으로 JSON 한 줄을 답합니다.
#  앱이 살아 있는 동안 상주합니다. (매번 새로 띄우면 호출당 0.5초씩 걸립니다)
#
#  cmd: ping | pick-direct | send | uia-auto-send | prefer-korean
#       공통 인자 excludePid — 앱 자신의 창을 대상에서 제외
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
  # 앱 시작 후 딱 한 번만 호출됩니다. 현재 IME 상태(ImmGetConversionStatus)를
  # 확인해서 필요할 때만 토글하려 했었는데, 최신 Windows(TSF 기반 IME)에서는
  # 이 레거시 API 가 실제 상태와 다른 값을 돌려주는 경우가 흔해서, "이미 한글"로
  # 잘못 판단해 토글을 건너뛰는 문제가 있었습니다. 어차피 한 번만 실행되니,
  # 상태를 확인하지 않고 무조건 토글합니다.
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

# ---- 보이는 창 전부 나열 ----------------------------------------------------
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

# ---- 제목에 keyword 가 들어간 창 찾기 ---------------------------------------
function Find-Target($keyword, $excludePid) {
  if ([string]::IsNullOrWhiteSpace($keyword)) { $keyword = 'Roll20' }
  $all = Get-Windows
  foreach ($w in $all) {
    if ($w.title -like "*$keyword*" -and (!$excludePid -or $w.pid -ne [uint32]$excludePid)) { return $w }
  }
  return $null
}

# ---- 직접 고른 창은 HWND를 우선 사용하고, 없거나 닫혔으면 제목 검색으로 fallback ----
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


# ---- UI Automation 입력창 후보 진단 ------------------------------------------
# 실제 전송은 하지 않습니다. 선택한 창의 접근성(UIA) 트리에서 입력 가능한
# 컨트롤 후보를 수집해 Electron 쪽으로 돌려줍니다.
function Do-UiaScan($windowHandle, $keyword, $excludePid) {
  $w = Resolve-Target $windowHandle $keyword $excludePid
  if ($null -eq $w) { return @{ ok = $false; error = 'window-not-found' } }

  # UI Automation은 진단 기능을 사용할 때만 로드합니다.
  # 로드 실패가 기존 전송 브리지까지 종료시키지 않도록 반드시 여기서 처리합니다.
  try {
    Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
    Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
  }
  catch {
    return @{
      ok = $false
      error = 'uia-unavailable'
      detail = $_.Exception.Message
    }
  }

  try {
    $h = [IntPtr][int64]$w.handle
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
    if ($null -eq $root) { return @{ ok = $false; error = 'uia-root-unavailable' } }

    $condition = [System.Windows.Automation.Condition]::TrueCondition
    $scope = [System.Windows.Automation.TreeScope]::Descendants
    $all = $root.FindAll($scope, $condition)

    $items = New-Object System.Collections.ArrayList
    $windowHeight = [Math]::Max(1, ($w.bottom - $w.top))

    for ($i = 0; $i -lt $all.Count; $i++) {
      $el = $all.Item($i)

      try {
        $cur = $el.Current
        $ct = $cur.ControlType.ProgrammaticName -replace '^ControlType\.', ''
        $name = [string]$cur.Name
        $automationId = [string]$cur.AutomationId
        $className = [string]$cur.ClassName
        $focusable = [bool]$cur.IsKeyboardFocusable
        $enabled = [bool]$cur.IsEnabled
        $offscreen = [bool]$cur.IsOffscreen
        $hasFocus = [bool]$cur.HasKeyboardFocus
        $rect = $cur.BoundingRectangle

        # 진단 단계에서는 입력 가능성이 있는 요소를 넓게 잡습니다.
        $interesting =
          $focusable -or
          $ct -in @('Edit','Document','ComboBox','Custom') -or
          $name -match '(?i)message|chat|text|input|send'

        if (-not $interesting) { continue }

        $supportsValue = $false
        $supportsText = $false
        try {
          $pattern = $null
          $supportsValue = $el.TryGetCurrentPattern(
            [System.Windows.Automation.ValuePattern]::Pattern,
            [ref]$pattern
          )
        } catch {}
        try {
          $pattern2 = $null
          $supportsText = $el.TryGetCurrentPattern(
            [System.Windows.Automation.TextPattern]::Pattern,
            [ref]$pattern2
          )
        } catch {}

        $width = [Math]::Max(0, [int][Math]::Round($rect.Width))
        $height = [Math]::Max(0, [int][Math]::Round($rect.Height))
        $left = [int][Math]::Round($rect.Left)
        $top = [int][Math]::Round($rect.Top)
        $bottom = [int][Math]::Round($rect.Bottom)

        # 범용 후보 점수. 아직 자동 선택에는 사용하지 않고 정렬용으로만 씁니다.
        $score = 0
        if ($ct -eq 'Edit') { $score += 45 }
        elseif ($ct -eq 'Document') { $score += 25 }
        elseif ($ct -eq 'ComboBox') { $score += 12 }

        if ($focusable) { $score += 25 }
        if ($enabled) { $score += 5 }
        if ($supportsValue) { $score += 18 }
        if ($supportsText) { $score += 10 }

        if ($name -match '(?i)message|chat') { $score += 40 }
        elseif ($name -match '(?i)text|input') { $score += 22 }

        if ($width -ge 120) { $score += 8 }
        if ($height -ge 20 -and $height -le 180) { $score += 7 }

        $relativeBottom = $bottom - $w.top
        if ($relativeBottom -ge ($windowHeight * 0.55)) { $score += 12 }
        if ($relativeBottom -ge ($windowHeight * 0.75)) { $score += 8 }

        if ($offscreen) { $score -= 100 }
        if ($width -le 2 -or $height -le 2) { $score -= 50 }

        [void]$items.Add([pscustomobject]@{
          score = $score
          controlType = $ct
          name = $name
          automationId = $automationId
          className = $className
          focusable = $focusable
          enabled = $enabled
          offscreen = $offscreen
          hasFocus = $hasFocus
          supportsValue = [bool]$supportsValue
          supportsText = [bool]$supportsText
          left = $left
          top = $top
          width = $width
          height = $height
        })
      }
      catch {
        # 브라우저 접근성 트리는 탐색 중 일부 노드가 사라질 수 있으므로
        # 개별 노드 오류는 건너뜁니다.
      }
    }

    # Windows PowerShell 5 호환: 단순 속성 정렬 사용
    $sorted = @(
      $items |
      Sort-Object -Property score, top -Descending |
      Select-Object -First 40
    )

    return @{
      ok = $true
      title = $w.title
      handle = [string]$w.handle
      scanned = $all.Count
      candidates = $sorted
    }
  }
  catch {
    return @{ ok = $false; error = 'uia-scan-failed'; detail = "$_" }
  }
}


# ---- UI Automation 입력창 포커스 진단 ----------------------------------------
# 입력/전송은 하지 않고, 가장 유력한 입력창을 찾아 SetFocus()만 수행합니다.
function Do-UiaFocus($windowHandle, $keyword, $excludePid) {
  $w = Resolve-Target $windowHandle $keyword $excludePid
  if ($null -eq $w) { return @{ ok = $false; error = 'window-not-found' } }

  try {
    Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
    Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
  }
  catch {
    return @{
      ok = $false
      error = 'uia-unavailable'
      detail = $_.Exception.Message
    }
  }

  try {
    $h = [IntPtr][int64]$w.handle
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
    if ($null -eq $root) { return @{ ok = $false; error = 'uia-root-unavailable' } }

    $condition = [System.Windows.Automation.Condition]::TrueCondition
    $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
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
        $automationId = [string]$cur.AutomationId
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
        $left = [int][Math]::Round($rect.Left)
        $top = [int][Math]::Round($rect.Top)
        $bottom = [int][Math]::Round($rect.Bottom)

        $score = 60
        if ($supportsValue) { $score += 18 }
        if ($supportsText) { $score += 12 }

        # Roll20의 안정적인 채팅 입력 클래스
        if ($className -match '(?i)ui-autocomplete-input') { $score += 120 }

        # CCFOLIA의 멀티라인 채팅 입력 클래스
        if ($className -match '(?i)MuiInputBase-inputMultiline') { $score += 120 }

        if ($name -match '(?i)message|chat|text input') { $score += 70 }
        elseif ($name -match '(?i)text|input') { $score += 28 }

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
            controlType = $ct
            name = $name
            automationId = $automationId
            className = $className
            supportsValue = [bool]$supportsValue
            supportsText = [bool]$supportsText
            left = $left
            top = $top
            width = $width
            height = $height
          }
        }
      }
      catch {}
    }

    if ($null -eq $best) {
      return @{
        ok = $false
        error = 'uia-input-not-found'
        title = $w.title
        scanned = $all.Count
      }
    }

    if ([W]::IsIconic($h)) {
      [void][W]::ShowWindow($h, $SW_RESTORE)
      Start-Sleep -Milliseconds 180
    }

    [void][W]::SetForegroundWindow($h)
    Start-Sleep -Milliseconds 160

    $focusError = ''
    try {
      $best.SetFocus()
    }
    catch {
      $focusError = $_.Exception.Message
    }

    Start-Sleep -Milliseconds 180

    $hasFocus = $false
    try { $hasFocus = [bool]$best.Current.HasKeyboardFocus } catch {}

    $focusedInfo = $null
    try {
      $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
      if ($null -ne $focused) {
        $fc = $focused.Current
        $focusedInfo = @{
          controlType = ($fc.ControlType.ProgrammaticName -replace '^ControlType\.', '')
          name = [string]$fc.Name
          automationId = [string]$fc.AutomationId
          className = [string]$fc.ClassName
        }
      }
    }
    catch {}

    return @{
      ok = ($hasFocus -and [string]::IsNullOrEmpty($focusError))
      error = $(if ($hasFocus) { '' } else { 'uia-focus-failed' })
      detail = $focusError
      title = $w.title
      handle = [string]$w.handle
      scanned = $all.Count
      selected = $bestInfo
      hasFocus = [bool]$hasFocus
      focused = $focusedInfo
    }
  }
  catch {
    return @{ ok = $false; error = 'uia-focus-failed'; detail = "$_" }
  }
}


# ---- UI Automation 입력 테스트 ------------------------------------------------
# 가장 유력한 입력창을 찾아 포커스 후 Ctrl+V만 수행합니다.
# Enter 또는 전송 버튼은 절대 누르지 않습니다.
function Do-UiaInputTest($windowHandle, $keyword, $excludePid) {
  $w = Resolve-Target $windowHandle $keyword $excludePid
  if ($null -eq $w) { return @{ ok = $false; error = 'window-not-found' } }

  try {
    Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
    Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
  }
  catch {
    return @{
      ok = $false
      error = 'uia-unavailable'
      detail = $_.Exception.Message
    }
  }

  try {
    $h = [IntPtr][int64]$w.handle
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
    if ($null -eq $root) { return @{ ok = $false; error = 'uia-root-unavailable' } }

    # 전체 접근성 트리를 훑지 않고 Edit 컨트롤만 직접 검색합니다.
    $editCondition = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Edit
    )
    $all = $root.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      $editCondition
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
        $automationId = [string]$cur.AutomationId
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
        $left = [int][Math]::Round($rect.Left)
        $top = [int][Math]::Round($rect.Top)
        $bottom = [int][Math]::Round($rect.Bottom)

        $score = 60
        if ($supportsValue) { $score += 18 }
        if ($supportsText) { $score += 12 }

        if ($className -match '(?i)ui-autocomplete-input') { $score += 120 }
        if ($className -match '(?i)MuiInputBase-inputMultiline') { $score += 120 }

        if ($name -match '(?i)message|chat|text input') { $score += 70 }
        elseif ($name -match '(?i)text|input') { $score += 28 }

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
            controlType = $ct
            name = $name
            automationId = $automationId
            className = $className
            supportsValue = [bool]$supportsValue
            supportsText = [bool]$supportsText
            left = $left
            top = $top
            width = $width
            height = $height
          }
        }
      }
      catch {}
    }

    if ($null -eq $best) {
      return @{
        ok = $false
        error = 'uia-input-not-found'
        title = $w.title
        scanned = $all.Count
      }
    }

    if ([W]::IsIconic($h)) {
      [void][W]::ShowWindow($h, $SW_RESTORE)
      Start-Sleep -Milliseconds 180
    }

    [void][W]::SetForegroundWindow($h)
    Start-Sleep -Milliseconds 160

    try {
      $best.SetFocus()
    }
    catch {
      return @{
        ok = $false
        error = 'uia-focus-failed'
        detail = $_.Exception.Message
        title = $w.title
        handle = [string]$w.handle
        scanned = $all.Count
        selected = $bestInfo
      }
    }

    Start-Sleep -Milliseconds 120

    $hasFocus = $false
    try { $hasFocus = [bool]$best.Current.HasKeyboardFocus } catch {}

    if (-not $hasFocus) {
      return @{
        ok = $false
        error = 'uia-focus-failed'
        title = $w.title
        handle = [string]$w.handle
        scanned = $all.Count
        selected = $bestInfo
        hasFocus = $false
      }
    }

    # 실제 키보드 입력과 동일하게 붙여넣기합니다.
    # Enter는 누르지 않습니다.
    [System.Windows.Forms.SendKeys]::SendWait('^v')
    Start-Sleep -Milliseconds 180

    $focusedInfo = $null
    try {
      $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
      if ($null -ne $focused) {
        $fc = $focused.Current
        $focusedInfo = @{
          controlType = ($fc.ControlType.ProgrammaticName -replace '^ControlType\.', '')
          name = [string]$fc.Name
          automationId = [string]$fc.AutomationId
          className = [string]$fc.ClassName
        }
      }
    }
    catch {}

    return @{
      ok = $true
      title = $w.title
      handle = [string]$w.handle
      scanned = $all.Count
      selected = $bestInfo
      hasFocus = $true
      focused = $focusedInfo
      pasted = $true
    }
  }
  catch {
    return @{ ok = $false; error = 'uia-input-test-failed'; detail = "$_" }
  }
}



# ---- 자동 탐색 캐시 -----------------------------------------------------------
# 첫 성공 후에는 같은 창만 우선 검사합니다.
# 창이 사라지거나 채팅 입력창이 없어지면 자동으로 캐시를 폐기하고 전체 재탐색합니다.
$script:AutoTargetHwnd = $null
$script:AutoTargetTitle = ''

# ---- 범용 채팅 입력창 탐색 ----------------------------------------------------
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

        # 확인된 Roll20 / CCFOLIA의 안정적인 입력창 특징
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

# ---- 자동 탐색 모드 전송 ------------------------------------------------------
# 별도의 대상 창/좌표 지정 없이, 현재 보이는 창들을 Z-order 순서로 검사합니다.
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

  # 1) 지난번 성공한 창이 아직 살아 있다면 그 창만 먼저 검사합니다.
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

  # 2) 캐시가 없거나 실패했을 때만 전체 창을 다시 탐색합니다.
  if ($null -eq $bestWindow) {
    $windows = @(Get-Windows | Where-Object {
      !$excludePid -or $_.pid -ne [uint32]$excludePid
    })

    foreach ($w in $windows) {
      $candidate = Find-BestChatInputInWindow $w
      if ($null -eq $candidate) { continue }

      # EnumWindows의 앞쪽(Z-order 상단)부터 검사.
      # 점수가 같다면 먼저 발견한 창을 유지합니다.
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
    # DOM 변경 등으로 캐시된 AutomationElement가 낡았을 가능성이 있으므로
    # 다음 전송 때는 다시 전체 탐색하도록 합니다.
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

# ---- 직접 지정 모드: 다음 클릭 지점과 그 최상위 창을 함께 기억 ------------------
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

  # GA_ROOT = 2
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

# ---- 전송 (클립보드는 Electron 쪽에서 미리 채워둡니다) ------------------------
function Do-Send($windowHandle, $keyword, $dx, $dy, $pressEnter, $excludePid) {
  $w = Resolve-Target $windowHandle $keyword $excludePid
  if ($null -eq $w) { return @{ ok = $false; error = 'window-not-found' } }

  $h = [IntPtr]$w.handle
  if ([W]::IsIconic($h)) { [void][W]::ShowWindow($h, $SW_RESTORE); Start-Sleep -Milliseconds 200 }
  [void][W]::SetForegroundWindow($h)
  Start-Sleep -Milliseconds 150

  # 창이 방금 움직였을 수 있으니 좌표를 다시 읽습니다.
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

# ---- 보정: 사용자의 다음 좌클릭을 잡아서 오프셋으로 환산 ---------------------
function Do-Pick($windowHandle, $keyword, $timeoutSec, $excludePid) {
  if (-not $timeoutSec) { $timeoutSec = 20 }

  # 이미 눌려 있으면 먼저 떼기를 기다립니다.
  while (([W]::GetAsyncKeyState(1) -band 0x8000) -ne 0) { Start-Sleep -Milliseconds 20 }

  $deadline = (Get-Date).AddSeconds($timeoutSec)
  $clicked = $false
  while ((Get-Date) -lt $deadline) {
    if (([W]::GetAsyncKeyState(1) -band 0x8000) -ne 0) { $clicked = $true; break }
    if (([W]::GetAsyncKeyState(27) -band 0x8000) -ne 0) { return @{ ok = $false; error = 'cancelled' } }  # ESC
    Start-Sleep -Milliseconds 20
  }
  if (-not $clicked) { return @{ ok = $false; error = 'timeout' } }

  $p = New-Object W+POINT
  [void][W]::GetCursorPos([ref]$p)

  $w = Resolve-Target $windowHandle $keyword $excludePid
  if ($null -eq $w) { return @{ ok = $false; error = 'window-not-found' } }

  # 채팅 입력칸은 사이드바 하단에 붙어 있어, 오른쪽 아래 모서리 기준 거리는
  # 창 크기가 바뀌어도 거의 유지됩니다.
  return @{
    ok    = $true
    dx    = $p.X - $w.right
    dy    = $p.Y - $w.bottom
    title = $w.title
  }
}

# ---- 메인 루프 ---------------------------------------------------------------
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

      'pick' {
        $res = Do-Pick $req.hwnd $req.match $req.timeout $req.excludePid
        $res.id = $id
        Reply $res
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

      'uia-scan' {
        $res = Do-UiaScan $req.hwnd $req.match $req.excludePid
        $res.id = $id
        Reply $res
      }

      'uia-focus' {
        $res = Do-UiaFocus $req.hwnd $req.match $req.excludePid
        $res.id = $id
        Reply $res
      }

      'uia-input-test' {
        $res = Do-UiaInputTest $req.hwnd $req.match $req.excludePid
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
