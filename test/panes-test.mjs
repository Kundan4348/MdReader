// Resizable Files pane and Outline in the desktop app: real mouse drags, limits, keyboard, double-click reset,
// widths kept on relaunch, handle hidden with its panel.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';

const outdir = process.argv[2]; mkdirSync(outdir, { recursive: true });
const root = path.resolve(import.meta.dirname, '..');
const doc = path.join(root, 'test/fixtures/links/links.md');
const electron = path.join(root, 'app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const busy = async (pt) => { try { await fetch(`http://127.0.0.1:${pt}/json/version`, { signal: AbortSignal.timeout(800) }); return true; } catch (e) { if (e.name === 'TypeError' || e.name === 'TimeoutError') return false; throw e; } };
const udd = path.join(outdir, 'user-data'); rmSync(udd, { recursive: true, force: true }); mkdirSync(udd, { recursive: true });
setTimeout(() => { console.error('FAIL: timeout'); process.exit(2); }, 120000);

async function launch(args) {
  let port = 9563; while (await busy(port)) port++;
  const proc = spawn(electron, [`--remote-debugging-port=${port}`, `--user-data-dir=${udd}`, path.join(root, 'app'), ...args], { stdio: 'ignore' });
  let page;
  for (let i = 0; i < 60 && !page; i++) { try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.type === 'page' && x.url.includes('index.html')); } catch {} if (!page) await sleep(500); }
  const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = new Map(); const logs = [];
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } if (m.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)); };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false }); // wide enough for the Outline
  for (let i = 0; i < 40 && !(await ev(`!!document.querySelector('#app .doc h1')`)); i++) await sleep(250);
  await sleep(600);
  return { proc, send, ev, logs, stop: () => { try { proc.kill('SIGKILL'); } catch {} } };
}

const r = {};
let A = await launch([doc]);
let { ev, send } = A;
const rect = (sel) => ev(`(()=>{const e=document.querySelector('#app ${sel}'); if(!e) return null; const r=e.getBoundingClientRect(); return {l:Math.round(r.left),r:Math.round(r.right),w:Math.round(r.width),x:r.left+r.width/2,y:r.top+r.height/2, shown:getComputedStyle(e).display!=='none'}})()`);
const zoom = () => ev(`parseFloat(getComputedStyle(document.querySelector('#app')).getPropertyValue('--ui-zoom'))||1`);
const mouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
async function drag(sel, toX) {
  const g = await rect(sel); await mouse('mousePressed', g.x, g.y);
  for (let s = 1; s <= 10; s++) { await mouse('mouseMoved', g.x + (toX - g.x) * s / 10, g.y); await sleep(20); }
  await mouse('mouseReleased', toX, g.y); await sleep(500);
}
r.start = { files: await rect('.files'), outline: await rect('.outline'), rzF: await rect('.rz-files'), rzO: await rect('.rz-outline'), zoom: await zoom() };
r.cursor = await ev(`getComputedStyle(document.querySelector('#app .rz-files')).cursor`);

// 1. widen Files by dragging its handle 160px right: the pane's edge follows the pointer
const fTarget = r.start.files.r + 160; await drag('.rz-files', fTarget); r.filesWide = await rect('.files');
// 2. widen the Outline by dragging its handle 140px left
const oTarget = r.start.outline.l - 140; await drag('.rz-outline', oTarget); r.outlineWide = await rect('.outline');
r.contentAfter = await rect('.centre');
// 3. limits: dragging Files almost to the window edge stops at the minimum
await drag('.rz-files', 8); r.filesMin = await rect('.files'); r.zoomMin = await zoom();
// 4. keyboard: focus the handle, → three times = +48px
await ev(`document.querySelector('#app .rz-files').focus()`);
for (let k = 0; k < 3; k++) { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }); await sleep(120); }
await sleep(300); r.filesKeys = await rect('.files'); r.zoomKeys = await zoom();
// 5. double-click resets Files to the theme width
{ const g = await rect('.rz-files'); for (const c of [1, 2]) { await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: g.x, y: g.y, button: 'left', buttons: 1, clickCount: c }); await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: g.x, y: g.y, button: 'left', buttons: 0, clickCount: c }); } }
await sleep(500); r.filesReset = await rect('.files');
// 6. hiding a panel hides its handle and gives the column back
await ev(`document.querySelector('#app .outline-toggle').click()`); await sleep(300);
r.outlineOff = { rz: await rect('.rz-outline'), centreR: (await rect('.centre')).r };
await ev(`document.querySelector('#app .outline-toggle').click()`); await sleep(300);
r.outlineBack = await rect('.outline');
r.logs = A.logs;
await sleep(800);
A.stop(); await sleep(1500);
// 7. relaunch: Outline keeps its width, Files is back at the theme width
A = await launch([doc]);
r.relaunch = { files: await A.ev(`Math.round(document.querySelector('#app .files').getBoundingClientRect().width)`), outline: await A.ev(`Math.round(document.querySelector('#app .outline').getBoundingClientRect().width)`) };
r.logs.push(...A.logs);
A.stop();

const near = (a, b, t = 4) => Math.abs(a - b) <= t;
r.ok = {
  handlesShown: r.start.rzF.shown && r.start.rzO.shown && r.cursor === 'col-resize',
  handleOnEdges: near(r.start.rzF.x, r.start.files.r, 3) && near(r.start.rzO.x, r.start.outline.l, 3),
  filesDrag: near(r.filesWide.r, fTarget) && r.filesWide.w > r.start.files.w + 150,
  outlineDrag: near(r.outlineWide.l, oTarget) && r.outlineWide.w > r.start.outline.w + 130,
  pageNarrowed: r.contentAfter.l === r.filesWide.r && r.contentAfter.r === r.outlineWide.l,
  minimum: near(r.filesMin.w, 140 * r.zoomMin),
  keyboard: near(r.filesKeys.w, (140 + 48) * r.zoomKeys),
  reset: near(r.filesReset.w, r.start.files.w),
  hideOutline: !r.outlineOff.rz.shown && r.outlineOff.centreR >= 1495,
  outlineBack: near(r.outlineBack.w, r.outlineWide.w),
  relaunch: near(r.relaunch.files, r.start.files.w) && near(r.relaunch.outline, r.outlineWide.w),
  noErrors: !r.logs.length,
};
console.log(JSON.stringify(r, null, 2));
writeFileSync(path.join(outdir, 'report.json'), JSON.stringify(r, null, 2));
process.exit(Object.values(r.ok).every(Boolean) ? 0 : 1);
