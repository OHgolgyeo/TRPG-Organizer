// =============================================================================
// TRPG Organizer - Auto Updater
// =============================================================================

const { app, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const fs = require('fs');
const path = require('path');

const CHECK_INTERVAL = 6 * 60 * 60 * 1000; // 6시간마다

let getWindow = () => null;
let manualCheck = false;
let promptShown = false;
let lastErrorKey = '';
let lastErrorAt = 0;
let state = { status: 'idle', version: null, percent: 0, error: null };

function getLogPath() {
  try {
    return path.join(app.getPath('userData'), 'updater.log');
  } catch {
    return null;
  }
}

function writeLog(level, ...parts) {
  const line = `[${new Date().toISOString()}] [${level}] ${parts.map(v => {
    if (v instanceof Error) return v.stack || v.message || String(v);
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v); } catch { return String(v); }
  }).join(' ')}\n`;

  try {
    const logPath = getLogPath();
    if (logPath) fs.appendFileSync(logPath, line, 'utf8');
  } catch {}

  try {
    const method = level === 'ERROR' ? 'error' : level === 'WARN' ? 'warn' : 'log';
    console[method]('[updater]', ...parts);
  } catch {}
}

// electron-updater 내부 로그도 같은 파일에 남깁니다.
autoUpdater.logger = {
  info: (...args) => writeLog('INFO', ...args),
  warn: (...args) => writeLog('WARN', ...args),
  error: (...args) => writeLog('ERROR', ...args),
  debug: (...args) => writeLog('DEBUG', ...args),
};

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

function resetState() {
  state = { status: 'idle', version: null, percent: 0, error: null };
}

function showUpdaterError(err, phase = 'update') {
  const message = String(err?.message || err || '알 수 없는 오류');
  const key = `${phase}:${message}`;
  const now = Date.now();

  writeLog('ERROR', `phase=${phase}`, err);
  state = {
    status: 'error',
    version: state.version,
    percent: state.percent || 0,
    error: message,
  };

  // error 이벤트와 Promise reject가 같은 오류를 연달아 전달하는 경우 한 번만 표시합니다.
  if (key === lastErrorKey && now - lastErrorAt < 2000) return;
  lastErrorKey = key;
  lastErrorAt = now;

  const wasManual = manualCheck;
  const wasDownloading = phase === 'download' || state.status === 'downloading';
  manualCheck = false;

  // 수동 확인 중 오류나, 새 버전을 실제로 내려받던 중 오류는 반드시 사용자에게 보여줍니다.
  if (!wasManual && !wasDownloading) return;

  const logPath = getLogPath();
  dialog.showMessageBox(getWindow(), {
    type: 'error',
    title: wasDownloading ? '업데이트 다운로드 실패' : '업데이트 확인 실패',
    message: wasDownloading
      ? '새 버전을 내려받지 못했습니다.'
      : '업데이트를 확인하지 못했습니다.',
    detail: `${message}${logPath ? `\n\n로그: ${logPath}` : ''}`,
  }).catch(() => {});
}

autoUpdater.on('checking-for-update', () => {
  writeLog('INFO', 'checking-for-update', `current=${app.getVersion()}`);
  if (state.status !== 'downloading' && state.status !== 'downloaded') {
    state = { status: 'checking', version: null, percent: 0, error: null };
  }
});

autoUpdater.on('update-not-available', (info) => {
  writeLog('INFO', 'update-not-available', info?.version || 'unknown');
  resetState();

  if (!manualCheck) return;
  manualCheck = false;
  dialog.showMessageBox(getWindow(), {
    type: 'info',
    title: '업데이트 확인',
    message: `최신 버전입니다. (v${app.getVersion()})`,
  }).catch(() => {});
});

autoUpdater.on('update-available', (info) => {
  writeLog('INFO', 'update-available', info?.version || 'unknown', info?.files || '');
  state = { status: 'downloading', version: info.version, percent: 0, error: null };

  // 여기서 manualCheck를 false로 만들지 않습니다.
  // 다운로드 실패까지 같은 수동 업데이트 세션으로 추적해야 오류를 사용자에게 보여줄 수 있습니다.
  if (!manualCheck) return;

  dialog.showMessageBox(getWindow(), {
    type: 'info',
    title: '업데이트 확인',
    message: `새 버전 v${info.version} 을 내려받고 있습니다.`,
    detail: '다운로드 진행률은 앱 메뉴의 업데이트 항목에서 확인할 수 있습니다.',
  }).catch(() => {});
});

autoUpdater.on('download-progress', (p) => {
  const percent = Math.max(0, Math.min(100, Math.round(Number(p?.percent) || 0)));
  state = {
    status: 'downloading',
    version: state.version,
    percent,
    error: null,
  };
  writeLog(
    'INFO',
    'download-progress',
    `${percent}%`,
    `transferred=${p?.transferred ?? '?'}`,
    `total=${p?.total ?? '?'}`
  );
});

autoUpdater.on('update-downloaded', async (info) => {
  writeLog('INFO', 'update-downloaded', info?.version || 'unknown');
  state = { status: 'downloaded', version: info.version, percent: 100, error: null };
  manualCheck = false;

  if (promptShown) return;
  promptShown = true;

  try {
    const { response } = await dialog.showMessageBox(getWindow(), {
      type: 'question',
      title: '업데이트 준비 완료',
      message: `새 버전 v${info.version} 이 준비되었습니다.`,
      detail: '지금 다시 시작하면 바로 적용됩니다. 미루시면 앱을 종료할 때 설치됩니다.',
      buttons: ['지금 다시 시작', '나중에'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) {
      writeLog('INFO', 'quitAndInstall requested');
      autoUpdater.quitAndInstall();
    }
  } catch (err) {
    writeLog('ERROR', 'downloaded dialog failed', err);
  }
});

autoUpdater.on('error', (err) => {
  const phase = state.status === 'downloading' ? 'download' : 'check';
  showUpdaterError(err, phase);
});

function runCheck(source) {
  writeLog('INFO', `checkForUpdates source=${source}`, `packaged=${app.isPackaged}`, `platform=${process.platform}`);
  return autoUpdater.checkForUpdates().catch((err) => {
    // 일부 오류는 error 이벤트 없이 Promise reject로만 올 수 있으므로 여기서도 기록/표시합니다.
    const phase = state.status === 'downloading' ? 'download' : 'check';
    showUpdaterError(err, phase);
    return null;
  });
}

function initAutoUpdate(windowGetter) {
  getWindow = typeof windowGetter === 'function' ? windowGetter : (() => null);
  writeLog('INFO', 'initAutoUpdate', `version=${app.getVersion()}`);

  if (!app.isPackaged || process.platform === 'darwin') {
    writeLog('INFO', 'auto update disabled for this runtime');
    return;
  }

  runCheck('startup');
  setInterval(() => runCheck('interval'), CHECK_INTERVAL);
}

function checkForUpdatesManually() {
  if (process.platform === 'darwin') {
    dialog.showMessageBox(getWindow(), {
      type: 'info',
      title: '업데이트 확인',
      message: 'macOS 전달용 빌드에서는 자동 업데이트를 사용하지 않습니다.',
      detail: '새 버전이 필요하면 새로 전달받은 앱으로 교체해 주세요.',
    }).catch(() => {});
    return;
  }

  if (!app.isPackaged) {
    dialog.showMessageBox(getWindow(), {
      type: 'info',
      title: '업데이트 확인',
      message: '개발 모드에서는 업데이트를 확인할 수 없습니다.',
      detail: '설치된 프로그램에서만 동작합니다.',
    }).catch(() => {});
    return;
  }

  manualCheck = true;
  promptShown = false;
  state = { status: 'checking', version: null, percent: 0, error: null };
  return runCheck('manual');
}

function getUpdateState() {
  return {
    ...state,
    devMode: !app.isPackaged,
    unsupported: process.platform === 'darwin',
    logPath: getLogPath(),
  };
}

function installUpdateNow() {
  if (state.status !== 'downloaded') return;
  writeLog('INFO', 'installUpdateNow');
  autoUpdater.quitAndInstall();
}

module.exports = {
  initAutoUpdate,
  checkForUpdatesManually,
  getUpdateState,
  installUpdateNow,
};
