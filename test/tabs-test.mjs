// Reordering tabs in the desktop app: real mouse drag, Esc cancel, right-click menu, ⌃⇧PageUp/PageDown, order kept on relaunch.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';

const outdir = process.argv[2]; mkdirSync(outdir, { recursive: true });
const root = path.resolve(import.meta.dirname, '..');
const fx = path.join(root, 'test/fixtures/links');
const files = ['links.md', 'other.md', 'cfg.json', 'q.sql'].map((f) => path.join(fx, f));
const electron = path.join(root, 'app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const busy = async (pt) => { try { await fetch(`http://127.0.0.1:${pt}/json/version`, { signal: AbortSignal.timeout(800) }); return true; } catch (e) { if (e.name === 'TypeError' || e.name === 'TimeoutError') return false; throw e; } };
const udd = path.join(outdir, 'user-data'); rmSync(udd, { recursive: true, force: true }); mkdirSync(udd, { recursive: true });
setTimeout(() => { console.error('FAIL: timeout'); process.exit(2); }, 120000);

async function launch(args) {
  let port = 9533; while (await busy(port)) port++;
  const proc = spawn(electron, [`--remote-debugging-port=${port}`, `--user-data-dir=${udd}`, path.join(root, 'app'), ...args], { stdio: 'ignore' });
  let page;
  for (let i = 0; i < 60 && !page; i++) { try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.type === 'page' && x.url.includes('index.html')); } catch {} if (!page) await sleep(500); }
  const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = new Map(); const logs = [];
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } if (m.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)); };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
  await send('Runtime.enable');
  return { proc, send, ev, logs, stop: () => { try { proc.kill('SIGKILL'); } catch {} } };
}

const r = {};
let A = await launch([files[0]]);
const { ev, send } = A;
for (let i = 0; i < 40 && !(await ev(`!!document.querySelector('#app .doc h1')`)); i++) await sleep(250);
for (const f of files.slice(1)) { await ev(`shell.loadFile(${JSON.stringify(f)})`); await sleep(400); }
const order = () => ev(`[...document.querySelectorAll('#app .tabs .tab')].map(t=>t.dataset.path.split('/').pop())`);
const active = () => ev(`document.querySelector('#app .tabs .tab.on')?.dataset.path.split('/').pop()`);
const box = (name) => ev(`(()=>{const r=document.querySelector('#app .tabs .tab[data-path$="${name}"]').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width}})()`);
const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
r.start = await order();
await ev(`document.querySelector('#app .tabs .tab[data-path$="other.md"]').click()`); await sleep(400);

// 1. drag q.sql (last) to the left of other.md
{
  const a = await box('q.sql'), b = await box('other.md');
  await mouse('mousePressed', a.x, a.y);
  for (let s = 1; s <= 12; s++) { await mouse('mouseMoved', a.x + ((b.x - b.w / 4) - a.x) * s / 12, a.y); await sleep(25); }
  r.midDrag = await ev(`({dragging: document.querySelector('#app .tabs').classList.contains('tdragging'), shifted: [...document.querySelectorAll('#app .tabs .tab:not(.tdrag)')].filter(t=>t.style.transform).length})`);
  await mouse('mouseReleased', b.x - b.w / 4, a.y); await sleep(400);
  r.afterDrag = await order(); r.activeAfterDrag = await active();
}
// 2. Esc cancels a drag
{
  const a = await box('links.md'), b = await box('cfg.json');
  await mouse('mousePressed', a.x, a.y);
  for (let s = 1; s <= 8; s++) { await mouse('mouseMoved', a.x + (b.x + 10 - a.x) * s / 8, a.y); await sleep(25); }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await mouse('mouseReleased', b.x + 10, a.y); await sleep(300);
  r.afterEsc = await order(); r.activeAfterEsc = await active();
  r.noTransformsLeft = await ev(`[...document.querySelectorAll('#app .tabs .tab')].every(t=>!t.style.transform)`);
}
// 3. plain click still switches tabs (a short press is not a drag)
{ const a = await box('cfg.json'); await mouse('mousePressed', a.x, a.y); await mouse('mouseReleased', a.x + 2, a.y); await sleep(400); r.clickSwitched = await active(); }
// 4. right-click menu: move cfg.json to the start
{
  const a = await box('cfg.json');
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'right', buttons: 2, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: a.x, y: a.y, button: 'right', buttons: 0, clickCount: 1 }); await sleep(300);
  r.menu = await ev(`(()=>{const m=document.querySelector('#app .tmenu'); return m && !m.hidden ? [...m.querySelectorAll('button')].map(b=>b.querySelector('span').textContent+(b.disabled?' (off)':'')) : null})()`);
  await ev(`[...document.querySelectorAll('#app .tmenu button')].find(b=>b.textContent.startsWith('Move to the start')).click()`); await sleep(300);
  r.afterMenu = await order(); r.menuClosed = await ev(`document.querySelector('#app .tmenu').hidden`);
}
// 5. keyboard: ⌃⇧PageDown twice on the active tab (cfg.json)
for (let k = 0; k < 2; k++) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34, modifiers: 2 | 8 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34, modifiers: 2 | 8 }); await sleep(200);
}
r.afterKeys = await order(); r.activeAfterKeys = await active();
r.logs = A.logs;
await sleep(1200); // session save
A.stop(); await sleep(1500);
// 6. relaunch: same order comes back
A = await launch([]);
for (let i = 0; i < 40 && (await A.ev(`document.querySelectorAll('#app .tabs .tab').length`)) < 4; i++) await sleep(250);
r.afterRelaunch = await A.ev(`[...document.querySelectorAll('#app .tabs .tab')].map(t=>t.dataset.path.split('/').pop())`);
r.activeAfterRelaunch = await A.ev(`document.querySelector('#app .tabs .tab.on')?.dataset.path.split('/').pop()`);
A.stop();

const j = (x) => JSON.stringify(x);
r.ok = {
  start: j(r.start) === j(['links.md', 'other.md', 'cfg.json', 'q.sql']),
  drag: j(r.afterDrag) === j(['links.md', 'q.sql', 'other.md', 'cfg.json']) && r.activeAfterDrag === 'other.md' && r.midDrag.dragging && r.midDrag.shifted >= 2,
  esc: j(r.afterEsc) === j(r.afterDrag) && r.activeAfterEsc === 'other.md' && r.noTransformsLeft,
  click: r.clickSwitched === 'cfg.json',
  menu: !!r.menu && r.menu[0] === 'Move left' && r.menu[3] === 'Move to the end (off)' && j(r.afterMenu) === j(['cfg.json', 'links.md', 'q.sql', 'other.md']) && r.menuClosed,
  keys: j(r.afterKeys) === j(['links.md', 'q.sql', 'cfg.json', 'other.md']) && r.activeAfterKeys === 'cfg.json',
  relaunch: j(r.afterRelaunch) === j(r.afterKeys) && r.activeAfterRelaunch === 'cfg.json',
  noErrors: !r.logs.length,
};
console.log(JSON.stringify(r, null, 2));
writeFileSync(path.join(outdir, 'report.json'), JSON.stringify(r, null, 2));
process.exit(Object.values(r.ok).every(Boolean) ? 0 : 1);
