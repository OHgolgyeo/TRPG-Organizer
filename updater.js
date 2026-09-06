// =============================================================================
// =============================================================================

const { app, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');

const CHECK_INTERVAL = 6 * 60 * 60 * 1000;   // 6시간마다

let getWindow = () => null;
let manualCheck = false;      // 사용자가 메뉴에서 직접 확인을 눌렀는지
let promptShown = false;      // 재시작 안내를 한 번만 띄우기 위해

let state = { status: 'idle', version: null, percent: 0 };

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;   // 안내를 미뤄도 앱을 끌 때 설치됩니다
autoUpdater.logger = null;


autoUpdater.on('checking-for-update', () => {
  if (state.status === 'idle') state.status = 'checking';
});

autoUpdater.on('download-progress', (p) => {
  state.percent = Math.round(p.percent || 0);
});

autoUpdater.on('update-not-available', () => {
  state = { status: 'idle', version: null, percent: 0 };
  if (!manualCheck) return;
  manualCheck = false;
  dialog.showMessageBox(getWindow(), {
    type: 'info',
    title: '업데이트 확인',
    message: `최신 버전입니다. (v${app.getVersion()})`,
  });
});

autoUpdater.on('update-available', (info) => {
  state = { status: 'downloading', version: info.version, percent: 0 };
  if (!manualCheck) return;
  manualCheck = false;
  dialog.showMessageBox(getWindow(), {
    type: 'info',
    title: '업데이트 확인',
    message: `새 버전 v${info.version} 을 내려받고 있습니다.`,
    detail: '다운로드가 끝나면 다시 알려드립니다.',
  });
});

autoUpdater.on('update-downloaded', async (info) => {
  state = { status: 'downloaded', version: info.version, percent: 100 };
  if (promptShown) return;
  promptShown = true;

  const { response } = await dialog.showMessageBox(getWindow(), {
    type: 'question',
    title: '업데이트 준비 완료',
    message: `새 버전 v${info.version} 이 준비되었습니다.`,
    detail: '지금 다시 시작하면 바로 적용됩니다. 미루시면 앱을 종료할 때 설치됩니다.',
    buttons: ['지금 다시 시작', '나중에'],
    defaultId: 0,
    cancelId: 1,
  });

  if (response === 0) autoUpdater.quitAndInstall();
});

autoUpdater.on('error', (err) => {
  if (state.status !== 'downloaded') state = { status: 'idle', version: null, percent: 0 };
  if (!manualCheck) return;
  manualCheck = false;
  dialog.showMessageBox(getWindow(), {
    type: 'warning',
    title: '업데이트 확인 실패',
    message: '업데이트를 확인하지 못했습니다.',
    detail: String(err?.message || err),
  });
});


function initAutoUpdate(windowGetter) {
  getWindow = windowGetter;
  if (!app.isPackaged || process.platform === 'darwin') return;

  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), CHECK_INTERVAL);
}

function checkForUpdatesManually() {
  if (process.platform === 'darwin') {
    dialog.showMessageBox(getWindow(), {
      type: 'info',
      title: '업데이트 확인',
      message: 'macOS 전달용 빌드에서는 자동 업데이트를 사용하지 않습니다.',
      detail: '새 버전이 필요하면 새로 전달받은 앱으로 교체해 주세요.',
    });
    return;
  }
  if (!app.isPackaged) {
    dialog.showMessageBox(getWindow(), {
      type: 'info',
      title: '업데이트 확인',
      message: '개발 모드에서는 업데이트를 확인할 수 없습니다.',
      detail: '설치된 프로그램에서만 동작합니다.',
    });
    return;
  }
  manualCheck = true;
  autoUpdater.checkForUpdates().catch(() => {});
}

function getUpdateState() {
  return { ...state, devMode: !app.isPackaged, unsupported: process.platform === 'darwin' };
}


function installUpdateNow() {
  if (state.status === 'downloaded') autoUpdater.quitAndInstall();
}

module.exports = { initAutoUpdate, checkForUpdatesManually, getUpdateState, installUpdateNow };
