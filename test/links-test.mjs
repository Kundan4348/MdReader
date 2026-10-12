// Links of every file type open from the desktop app, in Read and in Write.
// .md/.json/.sql open as tabs; .py/.csv/.png/.txt/folders go to the OS (logged via MDR_OPEN_LOG instead of launching).
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';

const outdir = process.argv[2]; mkdirSync(outdir, { recursive: true });
const root = path.resolve(import.meta.dirname, '..');
const fx = path.join(root, 'test/fixtures/links');
const doc = path.join(fx, 'links.md');
const before = readFileSync(doc, 'utf8');
const electron = path.join(root, 'app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const busy = async (pt) => { try { await fetch(`http://127.0.0.1:${pt}/json/version`, { signal: AbortSignal.timeout(800) }); return true; } catch (e) { if (e.name === 'TypeError' || e.name === 'TimeoutError') return false; throw e; } };
let port = 9433; while (await busy(port)) port++;
const udd = path.join(outdir, 'user-data'); rmSync(udd, { recursive: true, force: true }); mkdirSync(udd, { recursive: true });
const log = path.join(outdir, 'opened.log'); rmSync(log, { force: true });
const proc = spawn(electron, [`--remote-debugging-port=${port}`, `--user-data-dir=${udd}`, path.join(root, 'app'), doc], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, MDR_OPEN_LOG: log } });
const stop = () => { try { proc.kill('SIGKILL'); } catch {} };
process.on('exit', stop);
setTimeout(() => { console.error('FAIL: timeout'); stop(); process.exit(2); }, 90000);

let page;
for (let i = 0; i < 60 && !page; i++) { try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.type === 'page' && x.url.includes('index.html')); } catch {} if (!page) await sleep(500); }
if (!page) { console.log('FAIL: no page'); stop(); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map(); const logs = [];
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } if (m.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)); };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); return r.result?.result?.value; };
await send('Runtime.enable');
for (let i = 0; i < 40 && !(await ev(`!!document.querySelector('#app .doc a[href="tool.py"]')`)); i++) await sleep(250);
await sleep(800); // link check is async (stat per target)

const opened = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);
const activeTab = () => ev(`document.querySelector('#app .tabs .tab.on')?.dataset.path`);
const backToDoc = async () => { await ev(`document.querySelector('#app .tabs .tab[data-path$="links.md"]').click()`); await sleep(500); };
const clickHref = async (sel, meta = false) => { await ev(`(()=>{const a=document.querySelector('#app .doc ${sel}'); a.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,metaKey:${meta}}));})()`); await sleep(500); };
const r = { logs };
const mode = await ev(`document.querySelector('#app').dataset.mode`);
r.mode = mode;

// state after the link check
r.lmissing = await ev(`[...document.querySelectorAll('#app .doc a.lmissing')].map(a=>a.getAttribute('href'))`);
r.chips = await ev(`[...document.querySelectorAll('#app .doc a.path.rel')].map(a=>a.textContent)`);
r.plainChip = await ev(`[...document.querySelectorAll('#app .doc code')].some(c=>c.textContent==='pn_counts_v2.json' && !c.closest('a'))`);
r.toolTitle = await ev(`document.querySelector('#app .doc a[href="tool.py"]').title`);
r.noSpell = await ev(`[...document.querySelectorAll('#app .doc a, #app .doc code')].every(e=>e.spellcheck===false)`);

// OS-handled types (in Write, the default mode)
for (const h of ['tool.py', './data.csv', 'sub%20dir/notes.txt', 'pic.png', 'sub%20dir/', '../img/blue.png']) await clickHref(`a[href="${h}"]`);
await clickHref(`a.path.rel`); // the `tool.py` chip
await clickHref(`a[href="tool.py"]`, true); // ⌘-click reveals
// file:// link
await ev(`(()=>{const a=document.createElement('a'); a.href='file://' + ${JSON.stringify(encodeURI(path.join(fx, 'data.csv')))}; a.id='fl'; a.textContent='x'; document.querySelector('#app .doc p').append(a);})()`);
await clickHref(`#fl`);
r.opened = opened().map((l) => l.replace(fx, '<fx>').replace(path.join(root, 'test/fixtures'), '<fixtures>'));
// missing target: nothing opened, a message instead
const n0 = opened().length; await clickHref(`a[href="nothere.py"]`);
r.missingOpenedNothing = opened().length === n0;
r.missingFlash = await ev(`document.querySelector('#app .toast')?.textContent || ''`);

// Tab-handled types
const tabs = {};
for (const h of ['cfg.json', 'q.sql', 'other.md#part-two']) { await clickHref(`a[href="${h}"]`); tabs[h] = (await activeTab() || '').replace(fx, '<fx>'); await backToDoc(); }
r.tabs = tabs;
// Same in Read mode
await ev(`document.querySelector('#app .top [data-mode=read]').click()`); await sleep(500);
const n1 = opened().length; await clickHref(`a[href="tool.py"]`);
r.readOpensPy = opened().length === n1 + 1;
r.fileUnchanged = readFileSync(doc, 'utf8') === before;
r.dirty = await ev(`document.querySelector('#app').classList.contains('dirty')`);

const want = ['<fx>/tool.py', '<fx>/data.csv', '<fx>/sub dir/notes.txt', '<fx>/pic.png', '<fx>/sub dir/', '<fixtures>/img/blue.png', '<fx>/tool.py', 'reveal <fx>/tool.py', '<fx>/data.csv'];
r.ok = {
  mode: mode === 'write',
  opened: JSON.stringify(r.opened) === JSON.stringify(want),
  tabs: tabs['cfg.json'] === '<fx>/cfg.json' && tabs['q.sql'] === '<fx>/q.sql' && tabs['other.md#part-two'] === '<fx>/other.md',
  missing: JSON.stringify(r.lmissing) === '["nothere.py"]' && r.missingOpenedNothing,
  chips: JSON.stringify(r.chips) === '["tool.py","data.csv"]' && r.plainChip,
  title: r.toolTitle.includes('default app') && r.toolTitle.includes('/tool.py'),
  spell: r.noSpell, read: r.readOpensPy, untouched: r.fileUnchanged && !r.dirty, noErrors: !logs.length,
};
console.log(JSON.stringify(r, null, 2));
writeFileSync(path.join(outdir, 'report.json'), JSON.stringify(r, null, 2));
stop(); process.exit(Object.values(r.ok).every(Boolean) ? 0 : 1);
