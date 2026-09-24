// JSON documents through the extension host (shared core, so the app renders identically).
// Usage: node test/json-test.mjs <base-url> <outdir>   -- base-url serves the repo root (test/fixtures/*.json)
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
setTimeout(() => { console.error('FAIL: global timeout'); killChrome(); process.exit(2); }, 60000);
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

// ---- a minified object file
report.mounted = await mount(base + '/test/fixtures/data.json');
report.kind = await ev(`document.querySelector('#app').dataset.kind`);
report.h1 = await ev(`document.querySelector('#app .doc h1')?.textContent`);
report.meta = await ev(`document.querySelector('#app .doc .head .jmeta')?.textContent`);
report.sections = await ev(`[...document.querySelectorAll('#app .sec h2 .t')].map(e=>e.textContent)`);
report.outline = await ev(`[...document.querySelectorAll('#app .toc a')].map(a=>a.textContent)`);
report.props = await ev(`[...document.querySelectorAll('#app .sec:nth-child(1) table.jprops tbody tr')].map(tr=>[...tr.children].map(td=>td.textContent).join('='))`);
report.menuCols = await ev(`[...document.querySelectorAll('#app .sec[data-i="2"] table thead th')].map(th=>th.firstChild.textContent.trim()+(th.classList.contains('num')?'#':''))`);
report.menuRows = await ev(`document.querySelectorAll('#app .sec[data-i="2"] table tbody tr').length`);
report.tree = await ev(`(()=>{const s=document.querySelector('#app .sec[data-i="1"]'); return {open:[...s.querySelectorAll('details.jn')].map(d=>d.querySelector('.jk').textContent+':'+d.open), leaves:s.querySelectorAll('.jl').length, url:!!document.querySelector('#app .jprops a[href^="https://"]')}})()`);
report.empties = await ev(`[...document.querySelectorAll('#app .sec')].filter(s=>/^(empty|nothing)$/.test(s.querySelector('h2 .t').textContent)).map(s=>s.querySelector('.jempty')?.textContent)`);
report.tools = await ev(`(()=>{const s=document.querySelector('#app .sec[data-i="2"] .tools'); return {edit:s.querySelector('[data-act=edit]')?'present':'none', copy:s.querySelector('[data-act=copy]').textContent}})()`);
// per-column filter on the numeric "price" column of the menu table -> 3 of 4
report.filter = await ev(`(async()=>{const w=document.querySelector('#app .sec[data-i="2"] .table-wrap'); const ths=[...w.querySelectorAll('thead th')]; const c=ths.findIndex(t=>t.textContent.trim().startsWith('price')); ths[c].querySelector('.tf-btn').click(); const inp=w.querySelectorAll('input.tf')[c]; inp.value='>100'; inp.dispatchEvent(new Event('input',{bubbles:true})); await new Promise(r=>setTimeout(r,50)); const shown=[...w.querySelectorAll('tbody tr')].filter(tr=>!tr.classList.contains('f-hide')).map(tr=>tr.children[1].textContent); return {shown, cap:w.querySelector('.tf-count').textContent}})()`);
await ev(`document.querySelector('#app .sec[data-i="2"] .tf-clear').click()`);
await shot('json-mono.png');
// Format: the top button is visible only for JSON; it pretty-prints the source and marks the tab dirty. ⌥ minifies back.
report.fmtVisible = await ev(`getComputedStyle(document.querySelector('#app .top button.fmt')).display`);
report.linesBefore = await ev(`document.querySelector('#app textarea.src').value.split('\\n').length`);
await ev(`document.querySelector('#app .top button.fmt').click()`); await sleep(150);
report.linesAfter = await ev(`document.querySelector('#app textarea.src').value.split('\\n').length`);
report.dirtyAfterFormat = await ev(`document.querySelector('#app').classList.contains('dirty')`);
report.metaAfter = await ev(`document.querySelector('#app .doc .head .jmeta')?.textContent`);
report.h1After = await ev(`document.querySelector('#app .doc h1')?.textContent`);
await ev(`document.querySelector('#app .top button.fmt').dispatchEvent(new MouseEvent('click',{altKey:true,bubbles:true}))`); await sleep(150);
report.linesMinified = await ev(`document.querySelector('#app textarea.src').value.split('\\n').length`);
report.dirtyAfterMinify = await ev(`document.querySelector('#app').classList.contains('dirty')`);
// Editor gutter label and outline meta reflect the kind.
report.gutter = await ev(`document.querySelector('#app .editor .gutter span').textContent`);
// ---- an untitled tab with pasted JSON is recognised as JSON (Format appears, tree renders); markdown is not.
await ev(`dispatchEvent(new KeyboardEvent('keydown',{key:'t',metaKey:true,bubbles:true}))`); await sleep(200);
await ev(`(()=>{const ta=document.querySelector('#app textarea.src'); ta.value='{"a":1,"b":[1,2,3],"c":{"d":"x"}}'; ta.dispatchEvent(new Event('input',{bubbles:true}));})()`); await sleep(100);
await ev(`document.querySelector('#app .top [data-mode=read]').click()`); await sleep(150);
report.untitled = await ev(`({kind:document.querySelector('#app').dataset.kind, tab:document.querySelector('#app .tabs .tab.on .name').textContent, h1:document.querySelector('#app .doc h1')?.textContent, fmt:getComputedStyle(document.querySelector('#app .top button.fmt')).display, secs:[...document.querySelectorAll('#app .sec h2 .t')].map(e=>e.textContent)})`);
await ev(`document.querySelector('#app .top [data-mode=edit]').click()`); await sleep(100);
await ev(`(()=>{const ta=document.querySelector('#app textarea.src'); ta.value='# Not json\\n\\ntext'; ta.dispatchEvent(new Event('input',{bubbles:true}));})()`); await sleep(100);
await ev(`document.querySelector('#app .top [data-mode=read]').click()`); await sleep(150);
report.untitledMd = await ev(`({kind:document.querySelector('#app').dataset.kind, fmt:getComputedStyle(document.querySelector('#app .top button.fmt')).display})`);
// ---- a broken file: error banner with line/column, source shown, Format refuses politely
report.brokenMounted = await mount(base + '/test/fixtures/broken.json');
report.broken = await ev(`({kind:document.querySelector('#app').dataset.kind, err:document.querySelector('#app .jerr')?.textContent, excerpt:document.querySelector('#app .jexcerpt')?.textContent, secs:[...document.querySelectorAll('#app .sec h2 .t')].map(e=>e.textContent)})`);
await ev(`document.querySelector('#app .top button.fmt').click()`); await sleep(100);
report.brokenToast = await ev(`document.querySelector('#app .toast')?.textContent`);
await shot('json-broken.png');

report.jsonOk = report.mounted && report.kind === 'json' && report.h1 === 'data.json' && /Object · 12 keys/.test(report.meta) && /minified/.test(report.meta)
  && report.sections.join() === 'Properties,address,menu,hours,empty,nothing' && report.outline.join() === 'data.json,Properties,address,menu,hours,empty,nothing'
  && report.props.length === 7 && report.props.includes('manager=null=null') && report.props.includes('seats=24=number')
  && report.menuCols.join() === '##,item,price#,sold#,tags' && report.menuRows === 4
  && report.tree.open.join() === '"geo":true' && report.tree.leaves === 4 && report.tree.url
  && report.empties.join() === '{ },[ ]' && report.tools.edit === 'none' && report.tools.copy === 'Copy JSON'
  && report.filter.shown.join() === 'Espresso,Latte,Cold brew' && report.filter.cap === '3 of 4 rows'
  && report.fmtVisible !== 'none' && report.linesBefore === 2 && report.linesAfter > 20 && report.dirtyAfterFormat && !/minified/.test(report.metaAfter) && report.h1After === 'data.json'
  && report.linesMinified === 1 && report.dirtyAfterMinify && report.gutter === 'json'
  && report.untitled.kind === 'json' && report.untitled.tab === 'Untitled 1' && report.untitled.fmt !== 'none' && report.untitled.secs.join() === 'Properties,b,c'
  && report.untitledMd.kind === 'md' && report.untitledMd.fmt === 'none'
  && report.brokenMounted && report.broken.kind === 'json' && /Invalid JSON at line 3, column \d+/.test(report.broken.err) && /^3: /.test(report.broken.excerpt) && report.broken.secs.join() === 'Source'
  && /Cannot format/.test(report.brokenToast) && !logs.some((l) => l.startsWith('EXC'));
console.log(JSON.stringify(report, null, 2));
killChrome();
process.exit(report.jsonOk ? 0 : 1);
