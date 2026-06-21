import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

const indexHtml = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const appJs = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../manifest.webmanifest', import.meta.url), 'utf8'));
const serviceWorker = await readFile(new URL('../service-worker.js', import.meta.url), 'utf8');

assert.match(indexHtml, /<link rel="manifest" href="\.\/manifest\.webmanifest">/);
assert.match(indexHtml, /<meta name="theme-color" content="#050609">/);
assert.match(indexHtml, /<meta name="apple-mobile-web-app-capable" content="yes">/);
assert.match(indexHtml, /viewport-fit=cover/);
assert.match(indexHtml, /<title>双手 AR 滤镜<\/title>/);
assert.match(indexHtml, />启动摄像头<\/button>/);
assert.match(indexHtml, />演示模式<\/button>/);
assert.match(indexHtml, />重置<\/button>/);
assert.match(indexHtml, /<link rel="apple-touch-icon" href="\.\/apple-touch-icon\.png">/);
assert.match(indexHtml, /<script type="module" src="\.\/src\/app\.js\?v=20260621-visual6"><\/script>/);

assert.equal(manifest.name, '双手 AR 滤镜');
assert.equal(manifest.display, 'fullscreen');
assert.equal(manifest.start_url, './index.html');
assert.equal(manifest.scope, './');
assert.ok(manifest.icons.some((icon) => icon.src === './icon.svg' && icon.purpose.includes('maskable')));
assert.ok(manifest.icons.some((icon) => icon.src === './icon-192.png' && icon.sizes === '192x192'));
assert.ok(manifest.icons.some((icon) => icon.src === './icon-512.png' && icon.sizes === '512x512'));

assert.match(appJs, /navigator\.serviceWorker\.register\('\.\/service-worker\.js'\)/);
assert.match(appJs, /isSecureCameraContext\(\)/);
assert.match(appJs, /function getMobileBrowserHint\(baseMessage\)/);
assert.match(appJs, /setError\(getMobileBrowserHint\(/);

for (const asset of [
  './',
  './index.html',
  './src/styles.css',
  './src/app.js',
  './src/geometry.js',
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
]) {
  assert.match(serviceWorker, new RegExp(asset.replace(/[./]/g, '\\$&')));
}

assert.match(serviceWorker, /self\.addEventListener\('install'/);
assert.match(serviceWorker, /self\.addEventListener\('fetch'/);
assert.match(serviceWorker, /dual-hand-ar-v6/);
assert.match(serviceWorker, /\.\/src\/app\.js\?v=20260621-visual6/);

await access(new URL('../icon-192.png', import.meta.url));
await access(new URL('../icon-512.png', import.meta.url));
await access(new URL('../apple-touch-icon.png', import.meta.url));

console.log('pwa tests passed');
