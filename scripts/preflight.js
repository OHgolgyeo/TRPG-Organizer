const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const required = [
  'main.js', 'preload.js', 'chat-sender.js', 'mac-chat-bridge.js', 'updater.js',
  'index.html', 'help.html', 'subview-notepad.html', 'subview-rule-index.html', 'win-bridge.ps1', 'package.json',
];

const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const assetRefs = [...new Set([...index.matchAll(/assets\/([^"')]+)/g)].map(m => `assets/${m[1]}`))];
const explicitAssets = ['assets/cherries.ico'];
const missing = [...required, ...explicitAssets, ...assetRefs]
  .filter(rel => !fs.existsSync(path.join(root, rel)));

if (missing.length) {
  console.error('빌드에 필요한 파일이 없습니다:');
  missing.forEach(f => console.error(`- ${f}`));
  process.exit(1);
}

const jsFiles = ['main.js', 'preload.js', 'chat-sender.js', 'mac-chat-bridge.js', 'updater.js', 'scripts/preflight.js'];
const syntaxErrors = [];
for (const rel of jsFiles) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, rel)], { encoding:'utf8' });
  if (result.status !== 0) syntaxErrors.push(`${rel}: ${(result.stderr || result.stdout).trim()}`);
}

const htmlFiles = ['index.html', 'help.html', 'subview-notepad.html', 'subview-rule-index.html'];
for (const rel of htmlFiles) {
  const html = fs.readFileSync(path.join(root, rel), 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
  scripts.forEach((source, index) => {
    try { new Function(source); }
    catch (error) { syntaxErrors.push(`${rel} inline script ${index + 1}: ${error.message}`); }
  });
}

if (syntaxErrors.length) {
  console.error('JavaScript 문법 검사에 실패했습니다:');
  syntaxErrors.forEach(error => console.error(`- ${error}`));
  process.exit(1);
}

const criticalIds = [
  'mock-editor', 'mock-status', 'choose-save-location', 'choose-import-file', 'import-file',
  'settings-backup', 'settings-restore', 'settings-restore-file', 'menu-settings',
];
const missingIds = criticalIds.filter(id => !new RegExp(`id=["']${id}["']`).test(index));
if (missingIds.length) {
  console.error(`필수 UI 요소가 없습니다: ${missingIds.join(', ')}`);
  process.exit(1);
}

const documentSaveListeners = (index.match(/getElementById\(['"]choose-save-location['"]\)\.addEventListener\(['"]click['"]/g) || []).length;
if (documentSaveListeners !== 1) {
  console.error(`문서 저장 버튼 이벤트는 하나여야 합니다. 현재 ${documentSaveListeners}개입니다.`);
  process.exit(1);
}

if (!/frame:\s*false[\s\S]*?resizable:\s*true/.test(main)) {
  console.error('프레임 없는 메인 창은 Windows 가장자리에서 크기를 조절할 수 있어야 합니다.');
  process.exit(1);
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const packageLock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
if (packageJson.version !== packageLock.version || packageJson.version !== packageLock.packages?.['']?.version) {
  console.error('package.json과 package-lock.json의 버전이 일치하지 않습니다.');
  process.exit(1);
}

console.log(`빌드 사전 검사 통과 (${required.length}개 기본 파일, ${assetRefs.length}개 UI 에셋, ${jsFiles.length}개 JS, ${htmlFiles.length}개 HTML)`);
