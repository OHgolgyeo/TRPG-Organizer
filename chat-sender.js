// =============================================================================
// =============================================================================

const { app, clipboard } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const macBridge = process.platform === 'darwin' ? require('./mac-chat-bridge') : null;

const DEFAULTS = {
  mode: 'auto',
  enter: true,
  direct: {
    targetHwnd: null,
    title: '',
    dx: -250,
    dy: -110,
    appName: '',
    windowTitle: '',
    signature: null,
  },
};

class ChatSender {
  constructor() {
    this.ps = null;
    this.pending = new Map();
    this.seq = 0;
    this.settingsPath = path.join(app.getPath('userData'), 'roll20-organizer-settings.json');
    this.settings = this._load();
  }

  get supported() {
    return process.platform === 'win32' || process.platform === 'darwin';
  }

  get platform() {
    return process.platform;
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8'));

      const oldDirect = raw.direct || raw.profiles?.custom || {};
      const mode = raw.mode === 'custom' || raw.mode === 'direct' ? 'direct' : 'auto';

      return {
        ...DEFAULTS,
        ...raw,
        mode,
        direct: {
          ...DEFAULTS.direct,
          ...oldDirect,
          targetHwnd: oldDirect.targetHwnd ?? null,
          title: oldDirect.title || oldDirect.match || '',
          dx: Number.isFinite(Number(oldDirect.dx)) ? Number(oldDirect.dx) : -250,
          dy: Number.isFinite(Number(oldDirect.dy)) ? Number(oldDirect.dy) : -110,
          appName: oldDirect.appName || '',
          windowTitle: oldDirect.windowTitle || '',
          signature: oldDirect.signature || null,
        },
      };
    } catch {
      return JSON.parse(JSON.stringify(DEFAULTS));
    }
  }

  get mode() {
    return this.settings.mode === 'direct' ? 'direct' : 'auto';
  }

  get modeLabel() {
    return this.mode === 'direct' ? '직접 지정' : '자동 탐색';
  }

  setMode(mode) {
    if (!['auto', 'direct'].includes(mode)) return this.mode;
    this.save({ mode });
    return this.mode;
  }

  saveDirect(patch) {
    return this.save({
      direct: {
        ...this.settings.direct,
        ...patch,
      },
    });
  }

  save(patch) {
    this.settings = { ...this.settings, ...patch };
    try {
      fs.writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2), 'utf8');
    } catch (e) {
      console.warn('[sender] 설정 저장 실패:', e.message);
    }
    return this.settings;
  }

  _script() {
    return app.isPackaged
      ? path.join(process.resourcesPath, 'win-bridge.ps1')
      : path.join(__dirname, 'win-bridge.ps1');
  }

  start() {
    if (process.platform !== 'win32' || this.ps) return;

    this.ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', this._script(),
    ], { windowsHide: true });

    readline.createInterface({ input: this.ps.stdout }).on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.ready) return;
      const resolve = this.pending.get(msg.id);
      if (resolve) { this.pending.delete(msg.id); resolve(msg); }
    });

    this.ps.stderr.on('data', (d) => console.warn('[sender:ps]', String(d).trim()));

    this.ps.on('exit', () => {
      this.ps = null;
      for (const resolve of this.pending.values()) resolve({ ok: false, error: 'bridge-dead' });
      this.pending.clear();
    });
  }

  stop() {
    if (this.ps) { this.ps.kill(); this.ps = null; }
  }

  _call(payload, timeoutMs = 30000) {
    if (process.platform !== 'win32') return Promise.resolve({ ok: false, error: 'unsupported-platform' });
    if (!this.ps) this.start();
    if (!this.ps) return Promise.resolve({ ok: false, error: 'bridge-unavailable' });

    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: 'timeout' });
      }, timeoutMs);

      this.pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      this.ps.stdin.write(JSON.stringify({ id, ...payload }) + '\n');
    });
  }


  async send(text, { dryRun = false } = {}) {
    if (typeof text !== 'string' || !text.length) {
      return { ok: false, error: 'empty' };
    }

    clipboard.writeText(text);

    if (process.platform === 'darwin') {
      if (this.mode === 'auto') {
        return macBridge.autoSend(!dryRun && this.settings.enter);
      }

      const direct = this.settings.direct || DEFAULTS.direct;
      if (!direct.appName) return { ok: false, error: 'direct-not-configured' };
      return macBridge.sendToTarget(direct, !dryRun && this.settings.enter);
    }

    if (this.mode === 'auto') {
      return this._call({
        cmd: 'uia-auto-send',
        enter: !dryRun && this.settings.enter,
        excludePid: process.pid,
      }, 20000);
    }

    const direct = this.settings.direct || DEFAULTS.direct;
    if (!direct.targetHwnd) {
      return { ok: false, error: 'direct-not-configured' };
    }

    return this._call({
      cmd: 'send',
      match: direct.title || '',
      hwnd: direct.targetHwnd,
      dx: direct.dx,
      dy: direct.dy,
      enter: !dryRun && this.settings.enter,
      excludePid: process.pid,
    }, 15000);
  }

  async pickDirectTarget() {
    if (process.platform === 'darwin') {
      const res = await macBridge.pickTarget(20);
      if (res.ok) {
        this.saveDirect({
          appName: res.appName || '',
          windowTitle: res.windowTitle || '',
          signature: res.signature || null,
          title: res.title || res.appName || '',
          targetHwnd: null,
        });
      }
      return res;
    }

    const res = await this._call({
      cmd: 'pick-direct',
      timeout: 20,
      excludePid: process.pid,
    }, 25000);

    if (res.ok) {
      this.saveDirect({
        targetHwnd: res.hwnd,
        title: res.title || '',
        dx: res.dx,
        dy: res.dy,
      });
    }

    return res;
  }

  preferKorean(hwnd) {
    if (process.platform !== 'win32') return Promise.resolve({ ok: true, skipped: true });
    return this._call({ cmd: 'prefer-korean', hwnd: String(hwnd) }, 5000);
  }
}

module.exports = { ChatSender };
