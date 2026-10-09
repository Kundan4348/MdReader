// Draw on the page: pencil, highlighter, arrow, the fading pointer, eraser, undo, hide; strokes stay with their block.
// Usage: node test/draw-test.mjs <base-url> <outdir>   -- base-url serves the repo root
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';

const [base, outdir] = process.argv.slice(2);
const root = path.resolve(import.meta.dirname, '..');
const ud = path.join(outdir, 'ud');
rmSync(ud, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const CH = process.env.MDR_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const chrome = spawn(CH, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${ud}`,
  `--load-extension=${path.join(root, 'extension')}`, '--remote-debugging-port=0', '--window-size=1280,1600', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const killChrome = () => { try { chrome.kill('SIGKILL'); } catch {} };
process.on('exit', killChrome);
setTimeout(() => { console.error('FAIL: global timeout'); killChrome(); process.exit(2); }, 150000);
const port = await new Promise((res, rej) => { let buf = ''; chrome.stderr.on('data', (d) => { buf += d; const m = buf.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/); if (m) res(+m[1]); }); chrome.on('exit', () => rej(new Error('chrome exited early'))); });
let page;
for (let i = 0; i < 20 && !page; i++) { const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); page = targets.find((t) => t.type === 'page'); if (!page) await sleep(250); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map(); const logs = [];
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } if (m.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)); };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result?.result?.value; };
const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(path.join(outdir, name), Buffer.from(r.result.data, 'base64')); };
await send('Page.enable'); await send('Runtime.enable');
const mount = async (url) => { await send('Page.navigate', { url }); for (let i = 0; i < 40; i++) { await sleep(250); if (await ev(`!!document.querySelector('#app .doc h1')`)) return true; } return false; };

const report = { logs };
{ const on = ws.onmessage; ws.onmessage = (e) => { on(e); const m = JSON.parse(e.data); if (m.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true }); }; }
const key = (k, code, vk, mods = 0) => send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods }).then(() => send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods }));
const mouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse' });
const stroke = async (pts) => { await mouse('mousePressed', pts[0][0], pts[0][1]); for (const p of pts.slice(1)) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p[0], y: p[1], button: 'left', buttons: 1 }); } await mouse('mouseReleased', pts[pts.length - 1][0], pts[pts.length - 1][1]); await sleep(150); };
const rectOf = (js) => ev(`(()=>{const e=${js}; const r=e.getBoundingClientRect(); return [r.left,r.top,r.width,r.height]})()`);
const line = (x0, y0, x1, y1, n = 12) => [...Array(n + 1).keys()].map((i) => [x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n]);
const tool = (t) => ev(`document.querySelector('#app .inkbar [data-t=${t}]').click()`);
const paths = () => ev(`[...document.querySelectorAll('#app svg.ink path')].map(p=>({cls:p.getAttribute('class'), id:p.dataset.id, box:(()=>{const b=p.getBoundingClientRect(); return [Math.round(b.left),Math.round(b.top),Math.round(b.width)]})()}))`);
const store = () => ev(`(()=>{const a=JSON.parse(localStorage.getItem('mdr-ink')||'{}'); const k=Object.keys(a).find(k=>k.endsWith('tc.md')); return k?a[k]:[]})()`);
const P = `[...document.querySelectorAll('#app .doc p')].find(x=>x.textContent.startsWith('The quick'))`;
const checks = {};

report.mounted = await mount(base + '/test/fixtures/tc.md'); await sleep(700);
await ev(`localStorage.removeItem('mdr-ink')`);
await ev(`document.querySelector('#app .top [data-mode=read]').click()`); await sleep(200);
await ev(`document.body.focus()`); await key('E', 'KeyE', 69, 4 | 8); await sleep(300);
report.bar = await ev(`({shown:!document.querySelector('#app .inkbar').hidden, inking:document.querySelector('#app').classList.contains('inking'), btn:document.querySelector('#app .top .drawb').classList.contains('on')})`);
checks.opens = report.bar.shown && report.bar.inking && report.bar.btn;
const pr = await rectOf(P);
// pencil under "quick brown", highlighter over the second paragraph, an arrow between them
await tool('pencil'); await stroke(line(pr[0] + 30, pr[1] + pr[3] + 2, pr[0] + 160, pr[1] + pr[3] + 4));
const p2 = await rectOf(`[...document.querySelectorAll('#app .doc p')].find(x=>x.textContent.startsWith('Second'))`);
await tool('highlighter'); await stroke(line(p2[0], p2[1] + p2[3] / 2, p2[0] + 150, p2[1] + p2[3] / 2));
await tool('arrow'); await stroke(line(pr[0] + 260, pr[1] - 20, pr[0] + 170, pr[1] + 6, 6));
report.after3 = await paths(); report.store3 = await store();
checks.saved = report.after3.length === 3 && report.store3.length === 3 && report.store3.map((s) => s.t).join() === 'pencil,highlighter,arrow' && report.store3.every((s) => s.a && s.a.l0 !== undefined);
await shot('draw-strokes.png');
// the pointer: drawn, then gone by itself, never saved
await tool('pointer'); await stroke(line(pr[0], pr[1] + 60, pr[0] + 300, pr[1] + 90, 16));
report.ptrNow = (await paths()).filter((p) => /pointer/.test(p.cls)).length;
await shot('draw-pointer.png');
await sleep(2400);
report.ptrLater = (await paths()).filter((p) => /pointer/.test(p.cls)).length;
checks.pointer = report.ptrNow === 1 && report.ptrLater === 0 && (await store()).length === 3;
// the eraser removes the pencil line; undo brings it back
const pencil = report.after3.find((p) => /pencil/.test(p.cls)).box;
await tool('eraser'); await stroke(line(pencil[0] + 40, pencil[1] - 12, pencil[0] + 44, pencil[1] + 14, 8));
report.afterErase = (await store()).map((s) => s.t);
await key('z', 'KeyZ', 90, 4); await sleep(200);
report.afterUndo = (await store()).map((s) => s.t);
checks.eraseUndo = report.afterErase.join() === 'highlighter,arrow' && report.afterUndo.join() === 'pencil,highlighter,arrow';
// strokes follow their paragraph when the reading width changes
const before = { p: await rectOf(P), s: (await paths()).find((p) => /pencil/.test(p.cls)).box };
await ev(`document.querySelector('#app .top .width').click()`); await sleep(500);
const after = { p: await rectOf(P), s: (await paths()).find((p) => /pencil/.test(p.cls)).box };
report.follow = { before, after };
const rel = (o) => [(o.s[0] - o.p[0]) / o.p[2], o.s[2] / o.p[2]];
checks.follows = before.p[2] !== after.p[2] && Math.abs(rel(before)[0] - rel(after)[0]) < 0.02 && Math.abs(rel(before)[1] - rel(after)[1]) < 0.02;
await ev(`document.querySelector('#app .top .width').click()`); await sleep(200);
// Esc stops drawing, the drawing stays; reload: still there
await key('Escape', 'Escape', 27); await sleep(150);
report.stopped = await ev(`({inking:document.querySelector('#app').classList.contains('inking'), n:document.querySelectorAll('#app svg.ink path').length, pe:getComputedStyle(document.querySelector('#app svg.ink')).pointerEvents})`);
checks.stop = !report.stopped.inking && report.stopped.n === 3 && report.stopped.pe === 'none';
report.mounted2 = await mount(base + '/test/fixtures/tc.md'); await sleep(900);
report.reload = (await paths()).length;
checks.persist = report.reload === 3;
// Hide keeps them, Show brings them back
await ev(`document.querySelector('#app .top .drawb').click()`); await sleep(200);
await ev(`[...document.querySelectorAll('#app .inkbar .ink-a')].find(b=>b.textContent==='Hide').click()`); await sleep(150);
report.hidden = await ev(`[...document.querySelectorAll('#app svg.ink path')].filter(p=>getComputedStyle(p).display!=='none').length`);
await ev(`[...document.querySelectorAll('#app .inkbar .ink-a')].find(b=>b.textContent==='Show').click()`); await sleep(150);
report.shownAgain = await ev(`[...document.querySelectorAll('#app svg.ink path')].filter(p=>getComputedStyle(p).display!=='none').length`);
checks.hide = report.hidden === 0 && report.shownAgain === 3 && (await store()).length === 3;
await shot('draw-bar.png');
await ev(`document.documentElement.dataset.theme='studio'`); await sleep(200); await shot('draw-studio.png');

report.checks = checks;
report.drawOk = !!(report.mounted && Object.values(checks).every(Boolean) && !logs.length);
writeFileSync(path.join(outdir, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ drawOk: report.drawOk, checks, logs }));
killChrome(); process.exit(report.drawOk ? 0 : 1);
