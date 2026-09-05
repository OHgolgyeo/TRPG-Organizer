const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('roll20Native', {
  sendToRoll20:  (t) => ipcRenderer.invoke('roll20:send', t),
  saveJson:      (filename, contents) => ipcRenderer.invoke('file:save-json', { filename, contents }),
  openExternal:  (url) => ipcRenderer.invoke('app:open-external', url),

  // 제목 메뉴 '사용자 도구'
  getTargetMode:  ()  => ipcRenderer.invoke('tools:get-mode'),
  setTargetMode:  (m) => ipcRenderer.invoke('tools:set-mode', m),
  openDevTools:   ()  => ipcRenderer.invoke('tools:devtools'),
  openHelp:       ()  => ipcRenderer.invoke('tools:help'),
  getEnterOnSend: ()  => ipcRenderer.invoke('tools:get-enter'),
  setEnterOnSend: (v) => ipcRenderer.invoke('tools:set-enter', v),
  preferKorean:   ()  => ipcRenderer.invoke('input:prefer-korean'),

  // 제목 메뉴 '편집'
  editAction:    (a) => ipcRenderer.invoke('edit:run', a),

  // 업데이트
  updateState:   ()  => ipcRenderer.invoke('update:state'),
  checkUpdate:   ()  => ipcRenderer.invoke('update:check'),
  installUpdate: ()  => ipcRenderer.invoke('update:install'),

  widenWindow:    (d, side) => ipcRenderer.send('win:widen', { delta:d, side }),
  resizeWindow:   (options) => ipcRenderer.send('win:resize', options),
  close:          ()  => ipcRenderer.send('win:close'),
  setAlwaysOnTop: (v) => ipcRenderer.send('win:always-on-top', v),
  setOpacity:     (v) => ipcRenderer.send('win:opacity', v),
  setFullScreen:  (v) => ipcRenderer.send('win:full-screen', v),
  setCollapsed:   (v) => ipcRenderer.send('win:collapsed', v),
});
