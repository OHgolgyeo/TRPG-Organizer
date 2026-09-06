const { execFile } = require('child_process');

let cachedAutoTarget = null;

function runJxa(script, timeoutMs = 25000) {
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], {
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const output = String(stdout || '').trim();
      const detail = String(stderr || error?.message || '').trim();
      if (error) {
        const denied = /not authorized|not permitted|assistive|accessibility|(-1743)/i.test(detail);
        resolve({ ok: false, error: denied ? 'mac-accessibility-denied' : 'mac-bridge-failed', detail });
        return;
      }
      if (!output) {
        resolve({ ok: false, error: 'mac-bridge-empty' });
        return;
      }
      try {
        resolve(JSON.parse(output));
      } catch {
        resolve({ ok: false, error: 'mac-bridge-invalid-response', detail: output });
      }
    });
  });
}

function js(value) {
  return JSON.stringify(value ?? '');
}

function scanHelpers() {
  return String.raw`
const currentApp = Application.currentApplication();
currentApp.includeStandardAdditions = true;
function safe(fn, fallback) { try { const v = fn(); return v == null ? fallback : v; } catch (_) { return fallback; } }
function text(v) { return String(v == null ? '' : v); }
function lower(v) { return text(v).toLowerCase(); }
function getAttr(el, name) {
  try { return el.attributes.byName(name).value(); } catch (_) { return null; }
}
function getProp(el, name, fallback) {
  try { const p = el[name]; return typeof p === 'function' ? p() : p; } catch (_) { return fallback; }
}
function signature(el) {
  return {
    role: text(getProp(el, 'role', '')),
    subrole: text(getProp(el, 'subrole', '')),
    name: text(getProp(el, 'name', '')),
    description: text(getProp(el, 'description', '')),
    help: text(getProp(el, 'help', '')),
  };
}
function editableScore(el, win) {
  const s = signature(el);
  const role = s.role;
  if (role !== 'AXTextArea' && role !== 'AXTextField' && role !== 'AXComboBox') return { score: -9999, sig: s };

  const enabled = safe(() => !!getProp(el, 'enabled', true), true);
  if (!enabled) return { score: -9999, sig: s };

  const hay = lower([s.name, s.description, s.help].join(' '));
  let score = role === 'AXTextArea' ? 85 : role === 'AXTextField' ? 65 : 45;

  if (/text chat input|메시지를 입력|메시지 입력|채팅 입력|chat input|message input|send a message/.test(hay)) score += 190;
  else if (/message|메시지|chat|채팅|comment|코멘트/.test(hay)) score += 95;

  if (/address|주소|omnibox|search or enter|검색 또는 주소|검색창|location field|url/.test(hay)) score -= 330;
  if (/search|검색/.test(hay) && !/message|메시지|chat|채팅/.test(hay)) score -= 120;

  const pos = safe(() => getProp(el, 'position', null), null);
  const size = safe(() => getProp(el, 'size', null), null);
  const wpos = safe(() => getProp(win, 'position', null), null);
  const wsize = safe(() => getProp(win, 'size', null), null);
  if (Array.isArray(size)) {
    if (size[0] >= 120) score += 15;
    if (size[1] >= 18 && size[1] <= 220) score += 10;
  }
  if (Array.isArray(pos) && Array.isArray(size) && Array.isArray(wpos) && Array.isArray(wsize) && wsize[1] > 0) {
    const bottom = pos[1] + size[1];
    const rel = (bottom - wpos[1]) / wsize[1];
    if (rel >= 0.55) score += 15;
    if (rel >= 0.72) score += 20;
  }
  return { score, sig: s };
}
function windowTitle(win) { return text(safe(() => getProp(win, 'name', ''), '')); }
function sameSig(a, b) {
  if (!a || !b) return false;
  if (a.role && b.role && a.role !== b.role) return false;
  if (a.name && b.name && a.name === b.name) return true;
  if (a.description && b.description && a.description === b.description) return true;
  if (a.help && b.help && a.help === b.help) return true;
  return false;
}
function tryFocus(el) {
  try { el.click(); } catch (_) {}
  try { el.focused = true; } catch (_) {}
  try { el.attributes.byName('AXFocused').value = true; } catch (_) {}
  try { el.actions.byName('AXPress').perform(); } catch (_) {}
  return safe(() => !!getAttr(el, 'AXFocused'), false) || safe(() => !!getProp(el, 'focused', false), false);
}
function processCandidates(se) {
  const all = safe(() => se.applicationProcesses.whose({ backgroundOnly: false })(), []);
  const preferred = /chrome|chromium|whale|웨일|safari|firefox|edge|brave|arc|opera|vivaldi/i;
  return all.filter(p => {
    const n = text(safe(() => p.name(), ''));
    if (!n || /TRPG Organizer|Electron|Finder|Dock|SystemUIServer|System Settings|설정/.test(n)) return false;
    return safe(() => !!p.visible(), false) && safe(() => p.windows().length > 0, false);
  }).sort((a, b) => {
    const an = text(safe(() => a.name(), ''));
    const bn = text(safe(() => b.name(), ''));
    return (preferred.test(bn) ? 1 : 0) - (preferred.test(an) ? 1 : 0);
  });
}
function findBestInProcess(proc, wantedWindow, wantedSig) {
  const wins = safe(() => proc.windows(), []);
  let best = null;
  for (let wi = 0; wi < wins.length; wi++) {
    const win = wins[wi];
    const wt = windowTitle(win);
    if (wantedWindow && wt && wt !== wantedWindow) continue;
    const els = safe(() => win.entireContents(), []);
    const limit = Math.min(els.length, 6000);
    for (let i = 0; i < limit; i++) {
      const el = els[i];
      const result = editableScore(el, win);
      if (result.score < 70) continue;
      if (wantedSig && sameSig(result.sig, wantedSig)) result.score += 260;
      if (!best || result.score > best.score) best = { el, score: result.score, sig: result.sig, win, windowTitle: wt };
    }
  }
  return best;
}
`;
}

async function pickTarget(timeoutSec = 20) {
  const loops = Math.max(1, Math.floor(Number(timeoutSec || 20) * 5));
  const script = `${scanHelpers()}
const se = Application('System Events');
for (let i = 0; i < ${loops}; i++) {
  const front = safe(() => se.applicationProcesses.whose({ frontmost: true })(), []);
  if (front.length) {
    const p = front[0];
    const appName = text(safe(() => p.name(), ''));
    if (appName && appName !== 'TRPG Organizer' && appName !== 'Electron') {
      const wins = safe(() => p.windows(), []);
      const win = wins.length ? wins[0] : null;
      let focused = null;
      try { focused = p.attributes.byName('AXFocusedUIElement').value(); } catch (_) {}
      let sig = focused ? signature(focused) : null;
      if (!sig || !/^AX(TextArea|TextField|ComboBox)$/.test(sig.role)) {
        const best = findBestInProcess(p, win ? windowTitle(win) : '', null);
        if (best) sig = best.sig;
      }
      console.log(JSON.stringify({ ok:true, appName, windowTitle: win ? windowTitle(win) : '', signature: sig || null, title: win ? windowTitle(win) : appName }));
      $.exit(0);
    }
  }
  delay(0.2);
}
console.log(JSON.stringify({ ok:false, error:'timeout' }));`;
  return runJxa(script, (Number(timeoutSec || 20) + 4) * 1000);
}

async function sendToTarget(target, pressEnter) {
  const script = `${scanHelpers()}
const se = Application('System Events');
const appName = ${js(target?.appName)};
const wantedWindow = ${js(target?.windowTitle)};
const wantedSig = ${JSON.stringify(target?.signature || null)};
const matches = safe(() => se.applicationProcesses.whose({ name: appName })(), []);
if (!matches.length) {
  console.log(JSON.stringify({ok:false,error:'window-not-found'}));
} else {
  const p = matches[0];
  p.frontmost = true;
  delay(0.18);
  const best = findBestInProcess(p, wantedWindow, wantedSig);
  if (best) tryFocus(best.el);
  delay(0.08);
  se.keystroke('v', { using: 'command down' });
  ${pressEnter ? "delay(0.05); se.keyCode(36);" : ''}
  console.log(JSON.stringify({ok:true,title:best ? best.windowTitle : wantedWindow || appName, score:best ? best.score : null}));
}`;
  return runJxa(script, 12000);
}

async function autoSend(pressEnter) {
  const cache = cachedAutoTarget;
  const script = `${scanHelpers()}
const se = Application('System Events');
const cached = ${JSON.stringify(cache)};
let chosen = null;
let chosenProc = null;

if (cached && cached.appName) {
  const ms = safe(() => se.applicationProcesses.whose({ name: cached.appName })(), []);
  if (ms.length) {
    const b = findBestInProcess(ms[0], cached.windowTitle || '', cached.signature || null);
    if (b && b.score >= 120) { chosen = b; chosenProc = ms[0]; }
  }
}

if (!chosen) {
  const procs = processCandidates(se);
  for (let pi = 0; pi < procs.length; pi++) {
    const b = findBestInProcess(procs[pi], '', null);
    if (b && (!chosen || b.score > chosen.score)) { chosen = b; chosenProc = procs[pi]; }
  }
}

if (!chosen || chosen.score < 120 || !chosenProc) {
  console.log(JSON.stringify({ok:false,error:'uia-input-not-found'}));
} else {
  const appName = text(safe(() => chosenProc.name(), ''));
  chosenProc.frontmost = true;
  delay(0.18);
  tryFocus(chosen.el);
  delay(0.08);
  se.keystroke('v', { using: 'command down' });
  ${pressEnter ? "delay(0.05); se.keyCode(36);" : ''}
  console.log(JSON.stringify({ok:true,title:chosen.windowTitle || appName,score:chosen.score,target:{appName,windowTitle:chosen.windowTitle || '',signature:chosen.sig}}));
}`;
  const res = await runJxa(script, cache ? 14000 : 25000);
  if (res.ok && res.target) cachedAutoTarget = res.target;
  else if (!res.ok) cachedAutoTarget = null;
  return res;
}

function clearAutoCache() {
  cachedAutoTarget = null;
}

module.exports = { pickTarget, sendToTarget, autoSend, clearAutoCache };
