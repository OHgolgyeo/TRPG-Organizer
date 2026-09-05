const { app, BrowserWindow, Menu, ipcMain, dialog, nativeTheme, shell, screen, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { Roll20Sender } = require('./chat-sender');
const { initAutoUpdate, checkForUpdatesManually, getUpdateState, installUpdateNow } = require('./updater');

// Chromium과 운영체제 기본값에 관계없이 앱의 기본 UI 언어는 한국어로 고정합니다.
app.commandLine.appendSwitch('lang', 'ko');   // Chromium 은 'ko-KR' 이 아니라 'ko' 형식만 받습니다
process.env.LANG = 'ko_KR.UTF-8';
process.env.LC_ALL = 'ko_KR.UTF-8';

// 기본 메뉴바(File / Edit / View ...) 자체를 제거
Menu.setApplicationMenu(null);

// OS 테마와 무관하게 항상 라이트 기준으로 렌더 (디자인 흔들림 방지)
nativeTheme.themeSource = 'light';

const sender = new Roll20Sender();
let win;
let helpWin = null;
let lastHeight = 720;
let activeSubviewCount = 0;

function createWindow() {
  win = new BrowserWindow({
    width: 480,
    height: 720,
    minWidth: 360,
    minHeight: 44,
    frame: false,
    autoHideMenuBar: true,
    resizable: true,
    backgroundColor: '#fbf9fd',
    icon: path.join(__dirname, 'assets', 'cherries.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      webviewTag: true,        // 서브뷰(<webview>)용
    },
  });

  win.loadFile('index.html');
  // Chromium 맞춤법 검사기는 지역 코드가 붙은 'ko-KR' 이 아니라 'ko' 형식을 받습니다.
  // 잘못된 코드를 넘기면 이 호출이 예외를 던지며 창 생성 자체를 방해합니다.
  try { win.webContents.session.setSpellCheckerLanguages(['ko']); } catch (e) { console.warn('[spellchecker]', e.message); }

  // F1 도움말 / F12 개발자 도구를 메인 프로세스에서 처리합니다.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;

    if (input.key === 'F1' &&
        !input.control && !input.alt && !input.meta && !input.shift) {
      event.preventDefault();
      openHelpWindow();
      return;
    }

    if (input.key === 'F12') {
      event.preventDefault();
      const wc = win.webContents;
      wc.isDevToolsOpened() ? wc.closeDevTools() : wc.openDevTools({ mode: 'detach' });
    }
  });

  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      if (!win || win.isDestroyed()) return;
      win.show();
      win.focus();
      await win.webContents.executeJavaScript(`
        (() => {
          const editor = document.getElementById('mock-editor');
          if (!editor) return;
          editor.focus();
          const first = editor.firstElementChild;
          if (!first) return;
          const range = document.createRange();
          range.selectNodeContents(first);
          range.collapse(true);
          const selection = getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        })()
      `).catch(() => {});
    }, 650);
  });

  // 패널은 본 창 밖으로도 옮길 수 있는 보조 창으로 연다.
  // 크기는 렌더러가 내용에 맞춰 resizeTo 로 조정하므로 여기서는 최소값만 준다.
  win.webContents.setWindowOpenHandler(({ frameName, features }) => {
    if (!frameName.startsWith('roll20-panel-')) return { action: 'deny' };
    const owner = win.getBounds();

    // 렌더러가 넘겨준 트리거 버튼의 위치(rTop/rLeft/rWidth/rBottom, 본 창
    // 뷰포트 기준 CSS px)를 읽어, 본 창은 창틀이 없으므로 그 좌표에 본 창의
    // 화면상 원점(owner.x, owner.y)을 그대로 더하면 절대 좌표가 됩니다.
    // 여러 모니터/배율 환경에서도 안정적이도록, 좌표 계산과 화면 경계 클램프를
    // 전부 Electron 의 screen 모듈로 처리합니다 (렌더러의 window.screenX 나
    // popup.screen 은 모니터마다 배율이 다르면 자주 어긋납니다).
    const pick = (name) => {
      const m = new RegExp(`(?:^|,)\\s*${name}\\s*=\\s*(-?\\d+)`).exec(features || '');
      return m ? Number(m[1]) : null;
    };
    const rTop = pick('rTop'), rLeft = pick('rLeft'), rWidth = pick('rWidth'), rBottom = pick('rBottom');
    const wMatch = /(?:^|,)\s*width\s*=\s*(\d+)/.exec(features || '');
    const hMatch = /(?:^|,)\s*height\s*=\s*(\d+)/.exec(features || '');
    const panelWidth = wMatch ? Number(wMatch[1]) : 360;
    const panelHeight = hMatch ? Number(hMatch[1]) : 200;
    const isAppMenu = frameName === 'roll20-panel-appmenu';

    let x, y;
    if (rTop != null && rLeft != null && rWidth != null && rBottom != null) {
      // 앱 메뉴는 제목의 왼쪽에 맞추고, 그 외 보조 패널은 기존처럼 트리거 중앙 정렬.
      x = isAppMenu
        ? Math.round(owner.x + rLeft)
        : Math.round(owner.x + rLeft + (rWidth - panelWidth) / 2);
      y = Math.round(owner.y + rBottom + 4);
    } else {
      x = Math.round(owner.x + owner.width + 12);
      y = Math.round(owner.y + 60);
    }

    // 계산된 지점이 속한 모니터의 작업영역 안으로 클램프합니다.
    const display = screen.getDisplayNearestPoint({ x, y });
    const area = display.workArea;
    x = Math.max(area.x, Math.min(x, area.x + area.width - panelWidth));
    y = Math.max(area.y, Math.min(y, area.y + area.height - panelHeight));

    return { action: 'allow', overrideBrowserWindowOptions: {
      width: panelWidth, height: panelHeight,
      x, y,
      parent: win,
      modal: false,
      // 본 창은 기본적으로 '항상 위' 상태로 시작합니다. Windows 는 최상위 창의 소유
      // 창이 최상위가 아니면 뒤로 깔리는 특성이 있어, 자식도 같은 단계로 맞춰야 합니다.
      alwaysOnTop: true,
      frame: false,
      transparent: true,        // 패널 바깥은 완전히 투명 — 그림자는 패널 CSS 가 그림
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      skipTaskbar: true,
      autoHideMenuBar: true,
      useContentSize: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    }};
  });

  win.webContents.on('did-create-window', (child) => {
    // parent 옵션에서 이미 소유 관계가 정해지므로 setParentWindow 를 다시 부르지
    // 않습니다 (Windows 에서 z-order 관계가 오히려 흐트러질 수 있습니다).
    //
    // 주의: setAlwaysOnTop 을 반복 호출하면(과거에 0.4초 간격으로 재확인하던 코드)
    // Windows 에서 드물게 창틀 없는 투명 창의 스타일이 초기화되며 기본 창틀
    // (최소화/최대화/닫기 버튼)이 되살아나는 문제가 있었습니다. 그래서 지금은
    // 창이 뜨는 시점에 딱 한 번만 적용합니다. focus() 도 함께 불러야 합니다 —
    // 렌더러의 openDetachedPanel 은 패널이 포커스를 잃으면 스스로 닫히는 로직을
    // 갖고 있어서, 한 번도 포커스를 못 받으면 뜨자마자 닫힌 것처럼 보입니다.
    const activate = () => {
      if (child.isDestroyed()) return;
      // 본 창(플로팅 단계)보다 한 단계 위에 놓습니다. 서로 다른 단계는 Windows 에서도
      // 완전히 다른 층으로 취급되어, 본 창이 자기 층 안에서 앞뒤로 움직여도
      // 이 층에 있는 패널은 영향을 받지 않습니다. 딱 한 번만 호출합니다 —
      // 반복 호출이 창틀을 흐트러뜨리는 원인이었습니다.
      child.setAlwaysOnTop(true, 'pop-up-menu');
      child.moveTop();
      child.focus();
    };
    if (child.isVisible()) activate();
    child.once('ready-to-show', () => { child.show(); activate(); });
    child.once('show', activate);
  });

}

// =============================================================================
//  Roll20 전송
// =============================================================================

const ERRORS = {
  'window-not-found': '대상 창을 찾지 못했습니다. 사용자 도구에서 대상 창을 직접 골라주세요.',
  'point-outside-window': '보정된 클릭 위치가 창 밖입니다. 위치 보정을 다시 해주세요.',
  'unsupported-platform': '이 기능은 현재 Windows에서만 동작합니다.',
  'bridge-unavailable': '전송 도구를 시작하지 못했습니다.',
  'bridge-dead': '전송 도구가 종료되었습니다. 앱을 다시 실행해주세요.',
  'uia-unavailable': '이 Windows 환경에서 UI Automation 구성 요소를 불러오지 못했습니다.',
  'uia-root-unavailable': '선택한 창의 UI Automation 정보를 읽지 못했습니다.',
  'uia-scan-failed': 'UI Automation 탐색 중 오류가 발생했습니다.',
  'uia-input-not-found': '포커스를 줄 만한 입력창 후보를 찾지 못했습니다.',
  'uia-focus-failed': '입력창을 찾았지만 포커스를 옮기지 못했습니다.',
  'uia-input-test-failed': '입력창 테스트 입력 중 오류가 발생했습니다.',
  'timeout': '응답이 없습니다.',
  'empty': '보낼 내용이 없습니다.',
  'direct-not-configured': '직접 지정 모드의 입력 위치가 아직 지정되지 않았습니다.',
  'self-window': 'Organizer 창 자체는 직접 지정 대상으로 사용할 수 없습니다.',
};

function explain(code) {
  return ERRORS[code] || `전송에 실패했습니다. (${code})`;
}

async function handleSend(text) {
  const res = await sender.send(text);
  if (!res.ok && res.error !== 'cancelled') {
    dialog.showMessageBox(win, { type: 'warning', title: '전송 실패', message: explain(res.error) });
  }
  return res;
}

// =============================================================================
//  보정 / 테스트
// =============================================================================

async function runCalibration() {
  const label = sender.modeLabel;
  const { response } = await dialog.showMessageBox(win, {
    type: 'info',
    title: '위치 보정',
    message: `확인을 누른 뒤, ${label}에서 사용할 입력칸을 한 번 클릭하세요.`,
    detail:
      `현재 전송 모드: ${label}\n\n` +
      '20초 안에 클릭하시면 이 모드의 위치로 따로 기억합니다.\n' +
      '입력칸 가운데쯤을 눌러주세요. 취소하려면 ESC를 누르세요.',
    buttons: ['확인', '취소'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 1) return;

  const res = await sender.calibrate();
  if (res.ok) {
    dialog.showMessageBox(win, {
      type: 'info',
      title: '위치 보정 완료',
      message: '위치를 기억했습니다.',
      detail: `모드: ${label}\n대상 창: ${res.title}\n\n"전송 테스트"로 확인해보세요. 테스트는 붙여넣기까지만 하고 엔터는 치지 않습니다.`,
    });
  } else if (res.error !== 'cancelled') {
    dialog.showMessageBox(win, { type: 'warning', title: '위치 보정 실패', message: explain(res.error) });
  }
}

async function runTest() {
  const res = await sender.send('[위치 확인용 테스트]', { dryRun: true });
  if (!res.ok) {
    dialog.showMessageBox(win, { type: 'warning', title: '테스트 실패', message: explain(res.error) });
    return;
  }
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    title: '전송 테스트',
    message: `${sender.modeLabel} 대상 입력칸에 테스트 문구가 들어갔나요?`,
    detail: '들어갔다면 그대로 지우시면 됩니다. 엔터는 치지 않았습니다.',
    buttons: ['잘 들어갔어요', '엉뚱한 곳에 들어갔어요'],
    defaultId: 0,
  });
  if (response === 1) await runCalibration();
}


async function runUiaScan() {
  const res = await sender.scanUi();

  if (!res.ok) {
    return {
      ok: false,
      error: res.error || 'uia-scan-failed',
      detail: res.detail || '',
      report: [
        'TRPG Organizer - UI Automation 입력창 탐색 결과',
        `모드: ${sender.modeLabel}`,
        '상태: 탐색 실패',
        `오류: ${explain(res.error)}`,
        res.detail ? `상세: ${res.detail}` : '',
      ].filter(Boolean).join('\n'),
    };
  }

  const candidates = Array.isArray(res.candidates) ? res.candidates : [];

  const report = [
    'TRPG Organizer - UI Automation 입력창 탐색 결과',
    `모드: ${sender.modeLabel}`,
    `대상 창: ${res.title}`,
    `HWND: ${res.handle}`,
    `탐색한 UIA 요소 수: ${res.scanned}`,
    `후보 수: ${candidates.length}`,
    '',
    ...candidates.map((c, i) => (
      `[${i + 1}] score=${c.score}` +
      ` type=${c.controlType}` +
      ` name=${JSON.stringify(c.name || '')}` +
      ` automationId=${JSON.stringify(c.automationId || '')}` +
      ` className=${JSON.stringify(c.className || '')}` +
      ` focusable=${c.focusable}` +
      ` enabled=${c.enabled}` +
      ` offscreen=${c.offscreen}` +
      ` hasFocus=${c.hasFocus}` +
      ` valuePattern=${c.supportsValue}` +
      ` textPattern=${c.supportsText}` +
      ` rect=${c.left},${c.top},${c.width},${c.height}`
    )),
  ].join('\n');

  return {
    ok: true,
    title: res.title,
    scanned: res.scanned,
    candidateCount: candidates.length,
    report,
  };
}


async function runUiaFocus() {
  const res = await sender.focusUi();
  const selected = res.selected || {};
  const focused = res.focused || {};

  const report = [
    'TRPG Organizer - UI Automation 입력창 포커스 테스트',
    `모드: ${sender.modeLabel}`,
    res.title ? `대상 창: ${res.title}` : '',
    res.handle ? `HWND: ${res.handle}` : '',
    Number.isFinite(Number(res.scanned)) ? `탐색한 UIA 요소 수: ${res.scanned}` : '',
    `상태: ${res.ok ? '포커스 성공' : '포커스 실패'}`,
    res.error ? `오류: ${explain(res.error)}` : '',
    res.detail ? `상세: ${res.detail}` : '',
    '',
    selected.controlType ? '[선택된 입력창]' : '',
    selected.controlType ? `score=${selected.score}` : '',
    selected.controlType ? `type=${selected.controlType}` : '',
    selected.controlType ? `name=${JSON.stringify(selected.name || '')}` : '',
    selected.controlType ? `automationId=${JSON.stringify(selected.automationId || '')}` : '',
    selected.controlType ? `className=${JSON.stringify(selected.className || '')}` : '',
    selected.controlType ? `valuePattern=${selected.supportsValue}` : '',
    selected.controlType ? `textPattern=${selected.supportsText}` : '',
    selected.controlType ? `rect=${selected.left},${selected.top},${selected.width},${selected.height}` : '',
    selected.controlType ? `hasKeyboardFocus=${!!res.hasFocus}` : '',
    '',
    focused.controlType ? '[실제 포커스된 요소]' : '',
    focused.controlType ? `type=${focused.controlType}` : '',
    focused.controlType ? `name=${JSON.stringify(focused.name || '')}` : '',
    focused.controlType ? `automationId=${JSON.stringify(focused.automationId || '')}` : '',
    focused.controlType ? `className=${JSON.stringify(focused.className || '')}` : '',
  ].filter(line => line !== '').join('\n');

  return {
    ok: !!res.ok,
    error: res.error || '',
    report,
  };
}


async function runUiaInputTest() {
  const TEST_TEXT = '[TRPG Organizer 입력 테스트]';
  const oldClipboard = clipboard.readText();

  let res;
  try {
    clipboard.writeText(TEST_TEXT);
    res = await sender.inputUiTest();
  } finally {
    // 붙여넣기가 끝난 뒤 사용자의 기존 클립보드를 되돌립니다.
    clipboard.writeText(oldClipboard);
  }

  const selected = res?.selected || {};
  const focused = res?.focused || {};

  const report = [
    'TRPG Organizer - UI Automation 입력 테스트',
    `테스트 문구: ${TEST_TEXT}`,
    `모드: ${sender.modeLabel}`,
    res?.title ? `대상 창: ${res.title}` : '',
    res?.handle ? `HWND: ${res.handle}` : '',
    Number.isFinite(Number(res?.scanned)) ? `탐색한 UIA 요소 수: ${res.scanned}` : '',
    `상태: ${res?.ok ? '입력 시도 완료' : '입력 실패'}`,
    '전송: 하지 않음',
    res?.error ? `오류: ${explain(res.error)}` : '',
    res?.detail ? `상세: ${res.detail}` : '',
    '',
    selected.controlType ? '[선택된 입력창]' : '',
    selected.controlType ? `score=${selected.score}` : '',
    selected.controlType ? `type=${selected.controlType}` : '',
    selected.controlType ? `name=${JSON.stringify(selected.name || '')}` : '',
    selected.controlType ? `automationId=${JSON.stringify(selected.automationId || '')}` : '',
    selected.controlType ? `className=${JSON.stringify(selected.className || '')}` : '',
    selected.controlType ? `valuePattern=${selected.supportsValue}` : '',
    selected.controlType ? `textPattern=${selected.supportsText}` : '',
    selected.controlType ? `rect=${selected.left},${selected.top},${selected.width},${selected.height}` : '',
    selected.controlType ? `hasKeyboardFocus=${!!res?.hasFocus}` : '',
    '',
    focused.controlType ? '[실제 포커스된 요소]' : '',
    focused.controlType ? `type=${focused.controlType}` : '',
    focused.controlType ? `name=${JSON.stringify(focused.name || '')}` : '',
    focused.controlType ? `automationId=${JSON.stringify(focused.automationId || '')}` : '',
    focused.controlType ? `className=${JSON.stringify(focused.className || '')}` : '',
    '',
    res?.ok
      ? `대상 채팅 입력창에 ${JSON.stringify(TEST_TEXT)}가 보이는지 확인해주세요.`
      : '',
  ].filter(line => line !== '').join('\n');

  return {
    ok: !!res?.ok,
    error: res?.error || '',
    testText: TEST_TEXT,
    report,
  };
}

async function pickTargetWindow() {
  const res = await sender.listWindows();
  if (!res.ok) {
    dialog.showMessageBox(win, { type: 'warning', title: '창 목록', message: explain(res.error) });
    return;
  }

  const windows = (res.windows || []).slice(0, 40);
  if (!windows.length) {
    dialog.showMessageBox(win, {
      type: 'info',
      title: '창 목록',
      message: '선택할 수 있는 창을 찾지 못했습니다.',
    });
    return;
  }

  Menu.buildFromTemplate(
    windows.map((item) => {
      const title = String(item.title || '(제목 없는 창)');
      const handle = item.handle != null ? String(item.handle) : null;

      return {
        label: title.length > 60 ? title.slice(0, 60) + '…' : title,
        click: () => {
          // 현재 선택된 모드에만 이 창을 저장합니다.
          sender.saveProfile({
            match: title.slice(0, 120),
            targetHwnd: handle,
          });

          dialog.showMessageBox(win, {
            type: 'info',
            title: '대상 창 지정',
            message: `${sender.modeLabel} 모드의 대상 창을 지정했습니다.`,
            detail:
              `${title}\n\n` +
              '이 창 선택은 다른 전송 모드와 별도로 저장됩니다. ' +
              '필요하면 사용자 도구 → 채팅 위치 보정에서 입력 위치를 지정해 주세요.',
          });
        },
      };
    })
  ).popup({ window: win });
}


async function chooseDirectTarget() {
  const { response } = await dialog.showMessageBox(win, {
    type: 'info',
    title: '직접 지정 모드',
    message: '확인을 누른 뒤 사용할 채팅 입력칸을 한 번 클릭하세요.',
    detail:
      '20초 안에 입력칸 가운데를 클릭하면 그 창과 위치를 함께 기억합니다.\n' +
      '취소하려면 ESC를 누르세요.',
    buttons: ['확인', '취소'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });

  if (response === 1) return { ok: false, error: 'cancelled' };

  const res = await sender.pickDirectTarget();

  if (!res.ok) {
    if (res.error !== 'cancelled') {
      await dialog.showMessageBox(win, {
        type: 'warning',
        title: '직접 지정 실패',
        message: explain(res.error),
      });
    }
    return res;
  }

  sender.setMode('direct');

  await dialog.showMessageBox(win, {
    type: 'info',
    title: '직접 지정 완료',
    message: '직접 지정 모드의 입력 위치를 기억했습니다.',
    detail: res.title || '',
    buttons: ['확인'],
  });

  return { ok: true, mode: 'direct', label: sender.modeLabel };
}


function openHelpWindow() {
  if (helpWin && !helpWin.isDestroyed()) {
    if (helpWin.isMinimized()) helpWin.restore();
    helpWin.show();
    helpWin.focus();
    return;
  }

  helpWin = new BrowserWindow({
    width: 860,
    height: 720,
    icon: path.join(__dirname, 'assets', 'cherries.ico'),
    minWidth: 640,
    minHeight: 520,
    title: 'TRPG Organizer 도움말',
    parent: win || undefined,
    modal: false,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f7f4f0',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  helpWin.loadFile(path.join(__dirname, 'help.html'));
  helpWin.once('ready-to-show', () => helpWin?.show());
  helpWin.on('closed', () => { helpWin = null; });
}

// =============================================================================
//  IPC
// =============================================================================

ipcMain.handle('roll20:send', (_e, text) => handleSend(text));

// ---- 제목 메뉴의 '사용자 도구' 항목들 ----------------------------------------
ipcMain.handle('tools:get-mode', () => sender.mode);
ipcMain.handle('tools:set-mode', async (_e, mode) => {
  if (mode === 'auto') {
    sender.setMode('auto');
    return { ok: true, mode: 'auto', label: sender.modeLabel };
  }

  if (mode === 'direct') {
    return chooseDirectTarget();
  }

  return { ok: false, mode: sender.mode, label: sender.modeLabel };
});
ipcMain.handle('tools:devtools', () => win?.webContents.openDevTools({ mode: 'detach' }));
ipcMain.handle('tools:help', () => { openHelpWindow(); return true; });
ipcMain.handle('tools:get-enter', () => !!sender.settings.enter);
ipcMain.handle('tools:set-enter', (_e, v) => { sender.save({ enter: !!v }); return !!v; });
ipcMain.handle('input:prefer-korean', async () => {
  if (!win || win.isDestroyed()) return { ok: false, error: 'window-unavailable' };
  const handle = win.getNativeWindowHandle();
  const hwnd = handle.length === 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
  return sender.preferKorean(hwnd);
});

// ---- 편집 (execCommand 대신 Electron 정식 API) --------------------------------
// document.execCommand('paste') 는 Chromium 에서 막혀 있어 렌더러에서는 붙여넣기가 안 됩니다.
const EDIT_ACTIONS = ['undo', 'redo', 'cut', 'copy', 'paste', 'delete', 'selectAll'];
ipcMain.handle('edit:run', (_e, action) => {
  const wc = BrowserWindow.getFocusedWindow()?.webContents || win?.webContents;
  if (wc && EDIT_ACTIONS.includes(action)) wc[action]();
});

// ---- 업데이트 ---------------------------------------------------------------
ipcMain.handle('update:state', () => getUpdateState());
ipcMain.handle('update:check', () => checkForUpdatesManually());
ipcMain.handle('update:install', () => installUpdateNow());
ipcMain.handle('app:open-external', async (_e, url) => {
  if (url !== 'https://x.com/5golgyeo') return { ok: false };
  await shell.openExternal(url);
  return { ok: true };
});
ipcMain.handle('file:save-json', async (_e, payload = {}) => {
  let filename = String(payload.filename || 'roll20-organizer.json').trim() || 'roll20-organizer.json';
  if (!/\.json$/i.test(filename)) filename += '.json';
  filename = path.basename(filename);
  const result = await dialog.showSaveDialog(win, {
    title: 'Roll20 Organizer 저장',
    defaultPath: filename,
    filters: [{ name: 'Roll20 Organizer 파일', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true, filename };
  try {
    await fs.promises.writeFile(result.filePath, String(payload.contents || ''), 'utf8');
    return { ok: true, filename: path.basename(result.filePath), filePath: result.filePath };
  } catch (error) {
    return { ok: false, error: error.message, filename };
  }
});

// 서브뷰를 열고 닫을 때 창 너비만 늘리고 줄입니다.
ipcMain.on('win:widen', (_e, request) => {
  if (!win) return;
  const delta = Math.round(Number(typeof request === 'object' ? request?.delta : request) || 0);
  const side = typeof request === 'object' ? request?.side : 'right';
  if (!delta) return;

  // 메인 입력영역과 각 열린 서브뷰는 각각 최소 300px을 보장합니다.
  // 서브뷰 0개: 300px / 1개: 600px / 2개: 900px
  if (delta > 0) activeSubviewCount = Math.min(2, activeSubviewCount + 1);
  else activeSubviewCount = Math.max(0, activeSubviewCount - 1);

  const minimumWidth = 360 + 300 * activeSubviewCount;
  const [, currentMinHeight] = win.getMinimumSize();
  win.setMinimumSize(minimumWidth, currentMinHeight || 44);

  const bounds = win.getBounds();
  const width = Math.max(minimumWidth, bounds.width + delta);
  const applied = width - bounds.width;
  win.setBounds({
    x: side === 'left' ? bounds.x - applied : bounds.x,
    y: bounds.y,
    width,
    height: bounds.height,
  });
});

// 커스텀 리사이즈 핸들은 내부 레이어가 아니라 실제 Electron 창 자체를 조절합니다.
ipcMain.on('win:resize', (_e, request = {}) => {
  if (!win || win.isDestroyed()) return;

  const bounds = win.getBounds();
  const minimumWidth = 360 + 300 * activeSubviewCount;
  const width = Math.max(
    minimumWidth,
    Math.round(Number(request.width) || bounds.width)
  );
  const height = Math.max(
    240,
    Math.round(Number(request.height) || bounds.height)
  );

  const edges = request.edges || {};
  let x = bounds.x;
  let y = bounds.y;

  // 왼쪽/위쪽 테두리를 끌 때는 반대쪽 가장자리가 제자리에 있도록 원점을 이동합니다.
  if (edges.left) x += bounds.width - width;
  if (edges.top) y += bounds.height - height;

  win.setBounds({ x, y, width, height });
});

ipcMain.on('win:close', () => win?.close());
ipcMain.on('win:always-on-top', (_e, v) => {
  if (!win) return;
  win.setAlwaysOnTop(!!v);   // 본 창은 'floating' 단계 (레벨 지정 없는 기본값)
  // 자식 패널은 항상 그보다 위 단계('pop-up-menu')를 유지해야 합니다.
  // 본 창의 토글 한 번에 한 번만 다시 확인합니다 (반복 호출 아님).
  win.getChildWindows().forEach((child) => {
    if (child.isDestroyed()) return;
    child.setAlwaysOnTop(true, 'pop-up-menu');
    child.moveTop();
  });
});
ipcMain.on('win:opacity', (_e, v) => win?.setOpacity(Math.min(1, Math.max(0.2, Number(v) || 1))));
ipcMain.on('win:full-screen', (_e, v) => win?.setFullScreen(!!v));
ipcMain.on('win:collapsed', (_e, v) => {
  if (!win) return;
  const [w, h] = win.getSize();
  if (v) { lastHeight = h; win.setSize(w, 44); }
  else { win.setSize(w, lastHeight); }
});

// =============================================================================

app.whenReady().then(() => {
  sender.start();
  createWindow();
  initAutoUpdate(() => win);
});

app.on('window-all-closed', () => { sender.stop(); app.quit(); });
app.on('before-quit', () => sender.stop());
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
