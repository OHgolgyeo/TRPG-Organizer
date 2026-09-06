const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const required = [
  'main.js', 'preload.js', 'chat-sender.js', 'mac-chat-bridge.js', 'updater.js',
  'index.html', 'help.html', 'subview-notepad.html', 'win-bridge.ps1', 'package.json',
];

const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const assetRefs = [...new Set([...index.matchAll(/assets\/([^"')]+)/g)].map(m => `assets/${m[1]}`))];
const explicitAssets = ['assets/cherries.ico'];
const missing = [...required, ...explicitAssets, ...assetRefs]
  .filter(rel => !fs.existsSync(path.join(root, rel)));

if (missing.length) {
  console.error('빌드에 필요한 파일이 없습니다:');
  missing.forEach(f => console.error(`- ${f}`));
  process.exit(1);
}

console.log(`빌드 사전 검사 통과 (${required.length}개 기본 파일, ${assetRefs.length}개 UI 에셋)`);
