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
let lastExpandedBounds = null;
let lastMinimumSize = [360, 44];
const COLLAPSED_ICON_SIZE = 84;
let activeSubviewCount = 0;
let isIconCollapsed = false;

// Windows IME는 BrowserWindow마다 입력 컨텍스트가 따로 잡힐 수 있습니다.
// 메인 창에서 한글 우선을 한 번 적용했더라도 환경설정/스타일/자료창 같은 자식 창을
// 열면 그 창이 영문(A) 상태로 시작할 수 있으므로, 창별로 최초 1회만 한글 우선을 요청합니다.
// 같은 창 안에서 본문 -> 코멘트처럼 포커스만 이동할 때는 재요청하지 않아
// 한/영 상태가 반복 요청 때문에 뒤집히는 문제도 막습니다.
const koreanImeWindowState = new WeakMap();
async function requestKoreanImeForWindow(targetWindow) {
  if (process.platform !== 'win32') return { ok: true, skipped: true };
  if (!targetWindow || targetWindow.isDestroyed()) return { ok: false, error: 'window-unavailable' };

  const now = Date.now();
  let state = koreanImeWindowState.get(targetWindow);
  if (!state) {
    state = { requestedAt: 0, promise: null, primed: false };
    koreanImeWindowState.set(targetWindow, state);
  }
  if (state.promise) return state.promise;
  if (state.primed) return { ok: true, skipped: true, reason: 'window-already-primed' };
  if (now - state.requestedAt < 1200) return { ok: true, skipped: true, reason: 'debounced' };

  state.requestedAt = now;
  const handle = targetWindow.getNativeWindowHandle();
  const hwnd = handle.length === 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
  state.promise = Promise.resolve(sender.preferKorean(hwnd))
    .then(result => {
      // 실패한 경우에는 다음 포커스 때 다시 시도할 수 있도록 primed로 잠그지 않습니다.
      state.primed = result?.ok !== false;
      return result;
    })
    .catch(error => {
      state.primed = false;
      throw error;
    })
    .finally(() => { state.promise = null; });
  return state.promise;
}

function requestKoreanImeOnce() {
  return requestKoreanImeForWindow(win);
}

function primeKoreanImeAfterFocus(targetWindow, delay = 140) {
  if (process.platform !== 'win32' || !targetWindow || targetWindow.isDestroyed()) return;
  setTimeout(() => {
    if (!targetWindow || targetWindow.isDestroyed() || !targetWindow.isFocused()) return;
    requestKoreanImeForWindow(targetWindow).catch(() => {});
  }, delay);
}

function roundedWindowShape(width, height, radius = 12) {
  const w = Math.max(1, Math.round(Number(width) || 1));
  const h = Math.max(1, Math.round(Number(height) || 1));
  const r = Math.max(0, Math.min(Math.round(radius), Math.floor(w / 2), Math.floor(h / 2)));
  if (!r) return [{ x:0, y:0, width:w, height:h }];
  const rects = [];
  if (h > r * 2) rects.push({ x:0, y:r, width:w, height:h - r * 2 });
  for (let y = 0; y < r; y++) {
    const dy = r - y - 0.5;
    const inset = Math.max(0, Math.ceil(r - Math.sqrt(Math.max(0, r * r - dy * dy))));
    const rowWidth = Math.max(1, w - inset * 2);
    rects.push({ x:inset, y, width:rowWidth, height:1 });
    const bottomY = h - 1 - y;
    if (bottomY !== y) rects.push({ x:inset, y:bottomY, width:rowWidth, height:1 });
  }
  return rects;
}

function applyWindowShape() {
  if (!win || win.isDestroyed() || process.platform === 'darwin' || typeof win.setShape !== 'function') return;
  try {
    // 아이콘 접기 모드에서는 OS 모양 마스크를 제거합니다. 투명 PNG의 픽셀 알파를
    // Chromium/Windows 합성기가 그대로 표시하게 해야 사각/흰 배경이 생기지 않습니다.
    if (isIconCollapsed || win.isFullScreen()) {
      win.setShape([]);
      return;
    }
    const [width, height] = win.getSize();
    win.setShape(roundedWindowShape(width, height, 12));
  } catch (error) {
    console.warn('[window-shape]', error?.message || error);
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 480,
    height: 720,
    minWidth: 360,
    minHeight: 44,
    frame: false,
    autoHideMenuBar: true,
    // frameless 창의 Windows 네이티브 resize border와 커스텀 서브뷰 resize가
    // 서로 다른 레이어처럼 경쟁하지 않도록 사용자 네이티브 리사이즈는 끕니다.
    // 창 크기 변경은 index.html의 커스텀 핸들 -> win:resize IPC로 계속 가능합니다.
    resizable: false,
    roundedCorners: true,
    transparent: true,
    backgroundColor: '#00000000',
    backgroundMaterial: 'none', // Windows 11: Mica/Acrylic 기본값이 transparent와 충돌해 순수 투명 대신 시스템 배경색이 비치는 걸 방지
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
  win.on('resize', applyWindowShape);
  win.on('enter-full-screen', applyWindowShape);
  win.on('leave-full-screen', () => setImmediate(applyWindowShape));

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
      applyWindowShape();
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
      // renderer의 focusin 요청이 놓쳐도 창 포커스가 완전히 정착한 뒤 한 번 보강합니다.
      // 창별 상태를 공유하므로 renderer 요청이 이미 성공했다면 자동으로 건너뜁니다.
      primeKoreanImeAfterFocus(win, 180);
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
      // 분리 패널은 메인 창의 항상 위 상태를 그대로 따릅니다.
      // parent 관계만으로 메인 창 위에는 유지되므로, 고정 모드가 꺼진 상태에서
      // 다른 앱 위까지 떠버리지 않도록 child 자체를 강제로 topmost로 만들지 않습니다.
      alwaysOnTop: !!win?.isAlwaysOnTop?.(),
      frame: false,
      roundedCorners: true,
      transparent: true,        // 패널 바깥은 완전히 투명 — 그림자는 패널 CSS 가 그림
      backgroundColor: '#00000000',
      backgroundMaterial: 'none', // Windows 11 Mica/Acrylic 기본값과 충돌 방지
      hasShadow: false,
      resizable: false,
      skipTaskbar: true,
      autoHideMenuBar: true,
      useContentSize: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    }};
  });

  win.webContents.on('did-create-window', (child) => {
    const applyChildShape = () => {
      if (child.isDestroyed() || process.platform === 'darwin' || typeof child.setShape !== 'function') return;
      try {
        const [width, height] = child.getSize();
        child.setShape(roundedWindowShape(width, height, 11));
      } catch (error) {
        console.warn('[child-window-shape]', error?.message || error);
      }
    };

    try { child.setBackgroundColor('#00000000'); } catch {}
    try { child.setBackgroundMaterial?.('none'); } catch {}
    child.on('resize', applyChildShape);

    const syncWithMain = () => {
      if (child.isDestroyed() || !win || win.isDestroyed()) return;
      const pinned = win.isAlwaysOnTop();
      child.setAlwaysOnTop(pinned, pinned ? 'pop-up-menu' : undefined);
      // parent: win 이므로 pinned=false 여도 메인 창 앞에는 유지됩니다.
      // 다만 다른 앱보다 위에 남지는 않습니다.
    };

    const activate = () => {
      if (child.isDestroyed()) return;
      syncWithMain();
      child.moveTop();
      child.focus();
      primeKoreanImeAfterFocus(child, 160);
    };

    if (child.isVisible()) { applyChildShape(); activate(); }
    child.once('ready-to-show', () => { applyChildShape(); child.show(); activate(); });
    child.once('show', () => { applyChildShape(); activate(); });
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
ipcMain.handle('input:prefer-korean', () => requestKoreanImeOnce());
ipcMain.handle('clipboard:write-text', (_e, text) => {
  try {
    clipboard.writeText(String(text ?? ''));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
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
  const allowed = new Set([
    'https://x.com/5golgyeo',
    'https://kor.pngtree.com/freepng/dice_5629572.html?sol=downref&id=bef',
  ]);
  if (!allowed.has(url)) return { ok: false };
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
  if (!win || win.isDestroyed()) return;
  const delta = Math.round(Number(typeof request === 'object' ? request?.delta : request) || 0);
  const side = typeof request === 'object' ? request?.side : 'right';
  const countDelta = Math.round(Number(typeof request === 'object' ? request?.countDelta : 0) || 0);
  const requestedMinimum = Math.round(Number(typeof request === 'object' ? request?.minimumWidth : 0) || 0);
  if (!delta && !countDelta && !requestedMinimum) return;

  if (countDelta) activeSubviewCount = Math.max(0, Math.min(2, activeSubviewCount + countDelta));

  const minimumWidth = Math.max(360, requestedMinimum || (360 + 300 * activeSubviewCount));
  const [, currentMinHeight] = win.getMinimumSize();
  win.setMinimumSize(minimumWidth, currentMinHeight || 44);

  if (!delta) return;
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

ipcMain.on('win:min-width', (_e, value) => {
  if (!win || win.isDestroyed()) return;
  const minimumWidth = Math.max(360, Math.round(Number(value) || 360));
  const [, currentMinHeight] = win.getMinimumSize();
  win.setMinimumSize(minimumWidth, currentMinHeight || 44);
});

ipcMain.on('win:resize', (_e, request = {}) => {
  if (!win || win.isDestroyed()) return;

  const bounds = win.getBounds();
  const [nativeMinimumWidth] = win.getMinimumSize();
  const requestedMinimum = Math.round(Number(request.minimumWidth) || 0);
  const minimumWidth = Math.max(360, requestedMinimum || nativeMinimumWidth || (360 + 300 * activeSubviewCount));
  if (requestedMinimum && requestedMinimum !== nativeMinimumWidth) {
    const [, currentMinHeight] = win.getMinimumSize();
    win.setMinimumSize(minimumWidth, currentMinHeight || 44);
  }
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
  if (!win || win.isDestroyed()) return;
  const pinned = !!v;
  win.setAlwaysOnTop(pinned);   // 본 창은 기본 always-on-top 레벨 사용
  win.getChildWindows().forEach((child) => {
    if (child.isDestroyed()) return;
    // 환경설정/명령어/스타일 분리 패널도 메인 창의 고정 상태를 그대로 따릅니다.
    child.setAlwaysOnTop(pinned, pinned ? 'pop-up-menu' : undefined);
    if (pinned) child.moveTop();
  });
});
ipcMain.on('win:move-by', (_e, request = {}) => {
  if (!win || win.isDestroyed()) return;
  const dx = Math.round(Number(request.dx) || 0);
  const dy = Math.round(Number(request.dy) || 0);
  if (!dx && !dy) return;
  const bounds = win.getBounds();
  win.setPosition(bounds.x + dx, bounds.y + dy, false);
});
ipcMain.on('win:opacity', (_e, v) => win?.setOpacity(Math.min(1, Math.max(0.2, Number(v) || 1))));
ipcMain.on('win:full-screen', (_e, v) => win?.setFullScreen(!!v));
ipcMain.on('win:collapsed', (_e, v) => {
  if (!win || win.isDestroyed()) return;
  const collapsed = !!v;
  isIconCollapsed = collapsed;

  if (collapsed) {
    win.setBackgroundColor('#00000000');
    applyWindowShape();
    if (!lastExpandedBounds) {
      lastExpandedBounds = win.getBounds();
      lastMinimumSize = win.getMinimumSize();
      lastHeight = lastExpandedBounds.height;
    }
    win.setMinimumSize(COLLAPSED_ICON_SIZE, COLLAPSED_ICON_SIZE);
    win.setBounds({
      x: lastExpandedBounds.x,
      y: lastExpandedBounds.y,
      width: COLLAPSED_ICON_SIZE,
      height: COLLAPSED_ICON_SIZE,
    });
    win.setBackgroundColor('#00000000');
    return;
  }

  const minimumWidth = Math.max(360, Number(lastMinimumSize?.[0]) || (360 + 300 * activeSubviewCount));
  const minimumHeight = Math.max(44, Number(lastMinimumSize?.[1]) || 44);
  win.setMinimumSize(minimumWidth, minimumHeight);
  if (lastExpandedBounds) {
    win.setBounds(lastExpandedBounds);
    lastExpandedBounds = null;
  } else {
    const [w] = win.getSize();
    win.setSize(Math.max(minimumWidth, w), Math.max(240, lastHeight));
  }
  setImmediate(applyWindowShape);
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
