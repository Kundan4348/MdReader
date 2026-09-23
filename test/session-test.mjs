// Session restore: quitting the app must NOT lose the open tabs -- only the tab's ✕ removes one.
// node test/session-test.mjs <outdir>
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';

const outdir = process.argv[2]; mkdirSync(outdir, { recursive: true });
const root = path.resolve(import.meta.dirname, '..');
const electron = path.join(root, 'app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const port = 9335;
const udd = path.join(outdir, 'user-data'); rmSync(udd, { recursive: true, force: true }); mkdirSync(udd, { recursive: true });
const A = path.join(root, 'test/fixtures/second.md');
const B = path.join(root, 'test/fixtures/third.md');
const C = path.join(root, 'sample.md');

let live = null;
const stop = () => { if (live) { try { live.kill('SIGKILL'); } catch {} live = null; } };
process.on('exit', stop);
setTimeout(() => { console.error('FAIL: timeout'); stop(); process.exit(2); }, 90000);

// Launch the app (optionally with files), return a driver bound to its window.
async function launch(...files) {
  live = spawn(electron, [`--remote-debugging-port=${port}`, `--user-data-dir=${udd}`, path.join(root, 'app'), ...files], { stdio: 'ignore' });
  let page;
  for (let i = 0; i < 50 && !page; i++) {
    await sleep(400);
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.type === 'page' && x.url.includes('index.html')); } catch {}
  }
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (pend.has(m.id)) { pend.get(m.id)(m.result?.result?.value); pend.delete(m.id); } };
  const ev = (expression) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); });
  const tabs = () => ev(`[...document.querySelectorAll('#app .tabs .tab')].map(t=>t.querySelector('.name').textContent+(t.classList.contains('on')?'*':''))`);
  // wait for the expected number of tabs to settle (restore is async: prefs read -> IPC -> renderer)
  const settle = async (n) => { for (let i = 0; i < 40; i++) { await sleep(250); const t = await tabs(); if (t.length >= n) { await sleep(400); return await tabs(); } } return await tabs(); };
  return { ev, tabs, settle, quit: async () => { stop(); await sleep(900); } };
}

const report = {};
// 1. open three files, close one with its ✕ (that one must NOT come back), then quit.
let d = await launch(C, A, B);
report.opened = await d.settle(3);
await d.ev(`document.querySelector('#app .tabs .tab[data-path$="third.md"] .x').click()`); await sleep(600);
report.afterCloseButton = await d.tabs();
await d.quit();

// 2. relaunch with NO file: the two surviving tabs come back, the ✕-closed one does not.
d = await launch();
report.restored = await d.settle(2);
await d.quit();

// 3. relaunch WITH a file: the restored tabs are still there and the requested file is added and focused.
d = await launch(B);
report.restoredPlusArg = await d.settle(3);
await d.quit();

report.sessionOk = report.opened.length === 3
  && report.afterCloseButton.join() === 'sample.md,second.md*'
  && report.restored.join() === 'sample.md,second.md*'
  && report.restoredPlusArg.join() === 'sample.md,second.md,third.md*';
console.log(JSON.stringify(report, null, 2));
process.exit(report.sessionOk ? 0 : 1);
