// Files pane follows the disk: files and folders created, deleted or renamed in a shown folder appear without
// clicking anything. The window stays minimised (no focus events), so this proves the folder watcher, not the focus refresh.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, renameSync, unlinkSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';

const outdir = path.resolve(process.argv[2]); mkdirSync(outdir, { recursive: true });
const root = path.resolve(import.meta.dirname, '..');
const dir = path.join(outdir, 'tree');
rmSync(dir, { recursive: true, force: true }); mkdirSync(path.join(dir, 'sub'), { recursive: true });
writeFileSync(path.join(dir, 'a.md'), '# A\n\nhello\n');
writeFileSync(path.join(dir, 'sub', 'x.md'), '# X\n');
const electron = path.join(root, 'app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const busy = async (pt) => { try { await fetch(`http://127.0.0.1:${pt}/json/version`, { signal: AbortSignal.timeout(800) }); return true; } catch (e) { if (e.name === 'TypeError' || e.name === 'TimeoutError') return false; throw e; } };
const udd = path.join(outdir, 'user-data'); rmSync(udd, { recursive: true, force: true }); mkdirSync(udd, { recursive: true });
setTimeout(() => { console.error('FAIL: timeout'); process.exit(2); }, 120000);

let port = 9633; while (await busy(port)) port++;
const proc = spawn(electron, [`--remote-debugging-port=${port}`, `--user-data-dir=${udd}`, path.join(root, 'app'), path.join(dir, 'a.md')], { stdio: 'ignore' });
let page;
for (let i = 0; i < 60 && !page; i++) { try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.type === 'page' && x.url.includes('index.html')); } catch {} if (!page) await sleep(500); }
const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map(); const logs = [];
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } if (m.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)); };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
await send('Runtime.enable');

// Names directly under a folder in the tree: folders as 'name/', files as 'name'.
const list = (d) => ev(`(()=>{const n=document.querySelector('#app .tree .folder[data-path="${d}"]');if(!n)return null;return [...n.querySelector(':scope > .kids').children].map(c=>c.classList.contains('folder')?c.dataset.path.split('/').pop()+'/':c.classList.contains('file')?c.dataset.path.split('/').pop():'('+c.textContent+')')})()`);
const isOpen = (d) => ev(`!!document.querySelector('#app .tree .folder.open[data-path="${d}"]')`);
// Waits until the folder's list matches, up to 4 s; returns the last list and how long it took.
async function until(d, want) {
  const t0 = Date.now(); let got;
  while (Date.now() - t0 < 4000) { got = await list(d); if (JSON.stringify(got) === JSON.stringify(want)) return { ok: true, ms: Date.now() - t0, got }; await sleep(100); }
  return { ok: false, ms: Date.now() - t0, got };
}

const r = {};
const sub = path.join(dir, 'sub');
for (let i = 0; i < 40 && !(await list(dir)); i++) await sleep(250);
r.start = await list(dir);
r.focused = await ev('document.hasFocus()');
writeFileSync(path.join(dir, 'b.md'), '# B\n'); r.created = await until(dir, ['sub/', 'a.md', 'b.md']);
writeFileSync(path.join(dir, 'tool.py'), 'print(1)\n'); await sleep(800); r.pyIgnored = await until(dir, ['sub/', 'a.md', 'b.md']);
await ev(`document.querySelector('#app .tree .folder[data-path="${sub}"] > .label').click()`); await sleep(300);
r.subOpened = await list(sub);
writeFileSync(path.join(sub, 'y.json'), '{}\n'); r.inSub = await until(sub, ['x.md', 'y.json']);
writeFileSync(path.join(dir, 'c.sql'), 'select 1;\n'); r.createdRoot2 = await until(dir, ['sub/', 'a.md', 'b.md', 'c.sql']);
r.subStillOpen = await isOpen(sub); r.subStillListed = await list(sub);
mkdirSync(path.join(dir, 'newdir')); r.newFolder = await until(dir, ['newdir/', 'sub/', 'a.md', 'b.md', 'c.sql']);
renameSync(path.join(dir, 'b.md'), path.join(dir, 'b2.md')); r.renamed = await until(dir, ['newdir/', 'sub/', 'a.md', 'b2.md', 'c.sql']);
unlinkSync(path.join(dir, 'c.sql')); r.deleted = await until(dir, ['newdir/', 'sub/', 'a.md', 'b2.md']);
writeFileSync(path.join(dir, 'd.mmd'), 'flowchart LR\n a-->b\n'); r.mmd = await until(dir, ['newdir/', 'sub/', 'a.md', 'b2.md', 'd.mmd']);
r.activeHighlighted = await ev(`document.querySelector('#app .tree .file.on')?.dataset.path.split('/').pop()`);
// Closed folder: changes while closed show when it is opened again.
await ev(`document.querySelector('#app .tree .folder[data-path="${sub}"] > .label').click()`); await sleep(300);
writeFileSync(path.join(sub, 'z.md'), '# Z\n'); await sleep(600);
await ev(`document.querySelector('#app .tree .folder[data-path="${sub}"] > .label').click()`);
r.reopened = await until(sub, ['x.md', 'y.json', 'z.md']);
r.clickNew = await ev(`(async()=>{document.querySelector('#app .tree .file[data-path$="/b2.md"]').click();await new Promise(r=>setTimeout(r,600));return document.querySelector('#app .tabs .tab.on')?.dataset.path.split('/').pop()})()`);
r.logs = logs;
try { proc.kill('SIGKILL'); } catch {}

const j = (x) => JSON.stringify(x);
r.ok = {
  start: j(r.start) === j(['sub/', 'a.md']),
  noFocusNeeded: r.focused === false,
  created: r.created.ok, pyIgnored: r.pyIgnored.ok,
  subOpened: j(r.subOpened) === j(['x.md']), inSub: r.inSub.ok,
  rootRefreshKeepsSubOpen: r.createdRoot2.ok && r.subStillOpen && j(r.subStillListed) === j(['x.md', 'y.json']),
  newFolder: r.newFolder.ok, renamed: r.renamed.ok, deleted: r.deleted.ok, mmd: r.mmd.ok,
  activeHighlighted: r.activeHighlighted === 'a.md',
  reopened: r.reopened.ok,
  clickNew: r.clickNew === 'b2.md',
  noErrors: !logs.length,
};
console.log(JSON.stringify(r, null, 2));
writeFileSync(path.join(outdir, 'report.json'), JSON.stringify(r, null, 2));
rmSync(dir, { recursive: true, force: true });
process.exit(Object.values(r.ok).every(Boolean) ? 0 : 1);
