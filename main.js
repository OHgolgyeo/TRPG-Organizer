const { app, BrowserWindow, Menu, ipcMain, dialog, nativeTheme, shell, screen, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { ChatSender } = require('./chat-sender');
const { initAutoUpdate, checkForUpdatesManually, getUpdateState, installUpdateNow } = require('./updater');

app.commandLine.appendSwitch('lang', 'ko');   // Chromium 은 'ko-KR' 이 아니라 'ko' 형식만 받습니다
process.env.LANG = 'ko_KR.UTF-8';
process.env.LC_ALL = 'ko_KR.UTF-8';

Menu.setApplicationMenu(null);

// OS 테마와 무관하게 항상 라이트 기준으로 렌더 (디자인 흔들림 방지)
nativeTheme.themeSource = 'light';

const sender = new ChatSender();
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
    ...(process.platform === 'darwin' ? {} : { icon: path.join(__dirname, 'assets', 'cherries.ico') }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      webviewTag: true,        // 서브뷰(<webview>)용
    },
  });

  win.loadFile('index.html');
  try { win.webContents.session.setSpellCheckerLanguages(['ko']); } catch (e) { console.warn('[spellchecker]', e.message); }

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

  win.webContents.setWindowOpenHandler(({ frameName, features }) => {
    if (!frameName.startsWith('roll20-panel-')) return { action: 'deny' };
    const owner = win.getBounds();

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
      x = isAppMenu
        ? Math.round(owner.x + rLeft)
        : Math.round(owner.x + rLeft + (rWidth - panelWidth) / 2);
      y = Math.round(owner.y + rBottom + 4);
    } else {
      x = Math.round(owner.x + owner.width + 12);
      y = Math.round(owner.y + 60);
    }

    const display = screen.getDisplayNearestPoint({ x, y });
    const area = display.workArea;
    x = Math.max(area.x, Math.min(x, area.x + area.width - panelWidth));
    y = Math.max(area.y, Math.min(y, area.y + area.height - panelHeight));

    return { action: 'allow', overrideBrowserWindowOptions: {
      width: panelWidth, height: panelHeight,
      x, y,
      parent: win,
      modal: false,
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
    const activate = () => {
      if (child.isDestroyed()) return;
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
// =============================================================================

const ERRORS = {
  'window-not-found': '대상 창을 찾지 못했습니다. 사용자 도구에서 대상 창을 직접 골라주세요.',
  'point-outside-window': '보정된 클릭 위치가 창 밖입니다. 위치 보정을 다시 해주세요.',
  'unsupported-platform': '현재 운영체제에서는 이 전송 기능을 사용할 수 없습니다.',
  'mac-accessibility-denied': 'macOS의 손쉬운 사용 권한이 필요합니다. 시스템 설정 → 개인정보 보호 및 보안 → 손쉬운 사용에서 TRPG Organizer를 허용해 주세요.',
  'mac-bridge-failed': 'macOS 전송 도구를 실행하지 못했습니다.',
  'mac-bridge-empty': 'macOS 전송 도구에서 응답을 받지 못했습니다.',
  'mac-bridge-invalid-response': 'macOS 전송 도구의 응답을 읽지 못했습니다.',
  'mac-target-not-found': '지정할 앱이나 입력창을 확인하지 못했습니다.',
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

async function chooseDirectTarget() {
  const { response } = await dialog.showMessageBox(win, {
    type: 'info',
    title: '직접 지정 모드',
    message: '확인을 누른 뒤 사용할 채팅 입력칸을 한 번 클릭하세요.',
    detail: process.platform === 'darwin'
      ? '20초 안에 사용할 채팅 입력칸을 직접 클릭하세요. 해당 앱과 입력창 정보를 기억합니다.\nmacOS에서는 시스템 설정의 손쉬운 사용 권한이 필요합니다.'
      : '20초 안에 입력칸 가운데를 클릭하면 그 창과 위치를 함께 기억합니다.\n취소하려면 ESC를 누르세요.',
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
    ...(process.platform === 'darwin' ? {} : { icon: path.join(__dirname, 'assets', 'cherries.ico') }),
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
  if (process.platform !== 'win32') return { ok: true, skipped: true };
  if (!win || win.isDestroyed()) return { ok: false, error: 'window-unavailable' };
  const handle = win.getNativeWindowHandle();
  const hwnd = handle.length === 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
  return sender.preferKorean(hwnd);
});

const EDIT_ACTIONS = ['undo', 'redo', 'cut', 'copy', 'paste', 'delete', 'selectAll'];
ipcMain.handle('edit:run', (_e, action) => {
  const wc = BrowserWindow.getFocusedWindow()?.webContents || win?.webContents;
  if (wc && EDIT_ACTIONS.includes(action)) wc[action]();
});

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

ipcMain.on('win:widen', (_e, request) => {
  if (!win) return;
  const delta = Math.round(Number(typeof request === 'object' ? request?.delta : request) || 0);
  const side = typeof request === 'object' ? request?.side : 'right';
  if (!delta) return;

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

  if (edges.left) x += bounds.width - width;
  if (edges.top) y += bounds.height - height;

  win.setBounds({ x, y, width, height });
});

ipcMain.on('win:close', () => win?.close());
ipcMain.on('win:always-on-top', (_e, v) => {
  if (!win) return;
  win.setAlwaysOnTop(!!v);   // 본 창은 'floating' 단계 (레벨 지정 없는 기본값)
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
