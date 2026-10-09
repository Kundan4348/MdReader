// Write mode on JSON and SQL pages: edit values, keys, table cells / rows / columns, drag, colours, SQL queries (extension host).
// Usage: node test/write-data-test.mjs <base-url> <outdir>   -- base-url serves the repo root
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
{ const on = ws.onmessage; ws.onmessage = (e) => { on(e); const m = JSON.parse(e.data); if (m.method === 'Page.javascriptDialogOpening') console.error('dialog', m.params.type), send('Page.handleJavaScriptDialog', { accept: true }); }; } // the unsaved-changes prompt when moving on
const SRC = () => ev(`document.querySelector('#app textarea.src').value`);
const read = (f) => readFileSync(path.join(root, 'test/fixtures', f), 'utf8');
const typeText = (t) => send('Input.insertText', { text: t });
const key = (k, code, vk, mods = 0) => send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods }).then(() => send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods }));
const enter = () => key('Enter', 'Enter', 13), tab = () => key('Tab', 'Tab', 9), del = () => key('Delete', 'Delete', 46), esc = () => key('Escape', 'Escape', 27);
const undo = () => key('z', 'KeyZ', 90, 4);
const mouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
const box = (js) => ev(`(()=>{const el=${js}; if(!el) return null; el.scrollIntoView({block:'center'}); const b=el.getBoundingClientRect(); return [b.left+Math.min(b.width/2, 30),b.top+b.height/2]})()`);
const click = async (js) => { const p = await box(js); if (!p) return false; await mouse('mousePressed', p[0], p[1]); await mouse('mouseReleased', p[0], p[1]); await sleep(200); return true; };
const drag = async (fromJs, toJs, dy = 0, dx = 0) => {
  const a = await box(fromJs); if (!a) return 'no-from';
  await mouse('mousePressed', a[0], a[1]);
  const b = await ev(`(()=>{const el=${toJs}; const r=el.getBoundingClientRect(); return [r.left+Math.min(r.width/2,30), r.top+r.height/2]})()`);
  for (let k = 1; k <= 6; k++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a[0] + (b[0] + dx - a[0]) * k / 6, y: a[1] + (b[1] + dy - a[1]) * k / 6, button: 'left', buttons: 1 });
  await sleep(80); const shown = await ev(`!!document.querySelector('#app .wdrop:not([hidden])')`);
  await mouse('mouseReleased', b[0] + dx, b[1] + dy); await sleep(450); return shown;
};
const selAll = () => ev(`(()=>{const el=document.activeElement; const r=document.createRange(); r.selectNodeContents(el); const s=getSelection(); s.removeAllRanges(); s.addRange(r); return el.textContent})()`);
const active = () => ev(`(()=>{const a=document.activeElement; return a && a!==document.body ? {wk:a.dataset.wk||null, p:a.dataset.p||null, col:a.dataset.col||null, i:a.parentElement&&a.parentElement.dataset.i||null, text:a.textContent} : null})()`);
const P = (p) => `"'+CSS.escape(${JSON.stringify(JSON.stringify(p))})+'"`; // a [data-p=...] value, escaped in the page
const V = (p) => `document.querySelector('#app [data-wk=v][data-p=${P(p)}]')`;
const K = (p) => `document.querySelector('#app [data-wk=k][data-p=${P(p)}]')`;
const cell = (i, col) => `document.querySelector('#app .table-wrap[data-jp] tbody tr[data-i="${i}"] td[data-col="${col}"]')`;
const th = (col) => `document.querySelector('#app .table-wrap[data-jp] thead th[data-col="${col}"]')`;
const rclick = (js) => ev(`(()=>{const c=${js}; if(!c) return 'nf'; const b=c.getBoundingClientRect(); c.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:b.left+5,clientY:b.top+5})); return !document.querySelector('#app .wdmenu').hidden})()`);
const menuClick = (label) => ev(`(()=>{const b=[...document.querySelectorAll('#app .wdmenu button')].find(x=>(x.textContent||'').trim().startsWith(${JSON.stringify(label)})); if(!b||b.disabled) return false; b.click(); return true})()`);
const checks = {}; let exp;
const step = async (name, want) => { const got = await SRC(); const ok = got === want; console.error('step', name, ok); checks[name] = ok; if (!ok && !report.firstDiff) report.firstDiff = { name, got, want }; return ok; };

// ================= JSON =================
report.mounted = await mount(base + '/test/fixtures/write.json'); await sleep(800);
report.jsonState = await ev(`({mode:document.querySelector('#app').dataset.mode, on:document.querySelector('#app').classList.contains('writing-data'), eds:document.querySelectorAll('#app .wed').length, bar:getComputedStyle(document.querySelector('#app .wdbar')).display, chips:[...document.querySelectorAll('#app td[data-st]')].map(t=>t.dataset.st)})`);
exp = read('write.json');
// 1. a string value: shown without quotes while editing, Enter writes only that value
await click(V(['doc#0', 'name'])); report.nameShown = (await active())?.text;
await selAll(); await typeText('release-report'); await enter(); await sleep(300);
exp = exp.replace('"deploy-report"', '"release-report"'); await step('stringValue', exp);
// 2. a number, then Tab moves to the next field (the price key)
await click(V(['doc#0', 'count'])); await selAll(); await typeText('13'); await tab(); await sleep(300);
exp = exp.replace('"count": 12', '"count": 13'); await step('numberValue', exp);
report.afterTab = await active();
// 3. 1.50 is shown as written, and leaving it untouched changes nothing
await esc(); await click(V(['doc#0', 'price'])); report.priceShown = (await active())?.text; await esc(); await sleep(200);
await step('priceUntouched', exp);
// 4. rename a key; Enter moves to its value
await click(K(['doc#0', 'homepage'])); await selAll(); await typeText('site'); await enter(); await sleep(300);
exp = exp.replace('"homepage"', '"site"'); await step('renameKey', exp);
report.afterKeyEnter = await active(); await esc();
// 5. table cell, Enter goes down a row
await click(cell(1, 'minutes')); await selAll(); await typeText('21'); await enter(); await sleep(300);
exp = exp.replace('"minutes": 19', '"minutes": 21'); await step('cell', exp);
report.afterCellEnter = await active(); await esc();
// 6. a missing cell gets its key inserted in column order
await click(cell(3, 'minutes')); await typeText('5'); await enter(); await sleep(300);
exp = exp.replace('{ "step": "Verify", "state": "pending" }', '{ "step": "Verify", "state": "pending", "minutes": 5 }'); await step('missingCell', exp);
await esc();
// 7. right-click > Insert row below: a blank row in the same layout, cursor in it
report.menu1 = await rclick(cell(2, 'step')); await shot('json-menu.png');
report.ins = await menuClick('Insert row below'); await sleep(400);
report.insFocus = await active(); await typeText('Rollback'); await enter(); await sleep(300);
exp = exp.replace('{ "step": "Deploy", "state": "pending", "minutes": 0 },\n', '{ "step": "Deploy", "state": "pending", "minutes": 0 },\n    { "step": "Rollback", "state": "", "minutes": null },\n'); await step('insertRow', exp);
await esc();
// 8. rename a column from its header: every row
await click(th('state'));
await ev(`(()=>{const el=document.activeElement; const t=[...el.childNodes].find(n=>n.nodeType===3&&n.nodeValue.trim()); const r=document.createRange(); r.selectNodeContents(t); const s=getSelection(); s.removeAllRanges(); s.addRange(r)})()`);
await typeText('status'); await enter(); await sleep(300);
exp = exp.replace(/"state"/g, '"status"'); await step('renameColumn', exp);
await esc();
// 9. drag the Verify row (#4) above Build (#0)
const rowsOf = (t) => t.match(/\{ "(step|minutes)"[^\n]*\}/g);
report.rowDropLine = await drag(`document.querySelector('#app tbody tr[data-i="4"] td.jrowh')`, `document.querySelector('#app tbody tr[data-i="0"] td.jrowh')`, -8);
{ const r0 = rowsOf(exp); exp = exp.replace(r0.join(',\n    '), [r0[4], r0[0], r0[1], r0[2], r0[3]].join(',\n    ')); } await step('dragRow', exp);
// 10. drag the minutes column before step
report.colDropLine = await drag(`document.querySelector('#app th[data-col="minutes"] .jcg')`, `document.querySelector('#app th[data-col="step"]')`, 0, -25);
exp = exp.replace(/\{ "step": ("[^"]*"), "status": ("[^"]*"), "minutes": ([^ ]+) \}/g, '{ "minutes": $3, "step": $1, "status": $2 }'); await step('dragColumn', exp);
// 11. sort by minutes, Z -> A (empty last)
await rclick(cell(0, 'minutes')); report.sortMenu = await menuClick('Sort by this column, Z'); await sleep(400);
{ const objs = rowsOf(exp), num = (o) => { const m = /"minutes": (null|\d+)/.exec(o); return m[1] === 'null' ? null : +m[1]; };
  const sorted = objs.slice().sort((a, b) => { const x = num(a), y = num(b); if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1; return y - x; });
  exp = exp.replace(objs.join(',\n    '), sorted.join(',\n    ')); } await step('sortDesc', exp);
// 12. click the status grip to select the column, Delete removes it everywhere
await click(`document.querySelector('#app th[data-col="status"] .jcg')`); report.colSel = await ev(`document.querySelectorAll('#app .wsel').length`);
await del(); await sleep(400);
exp = exp.replace(/, "status": "[^"]*"/g, ''); await step('deleteColumn', exp);
// 13. tree: right-click owner > Add inside; type a key, Enter, type its value
report.ownerMenu = await rclick(`document.querySelector('#app summary[data-p=${P(['doc#0', 'owner'])}]')`);
report.addInside = await menuClick('Add inside'); await sleep(400); report.newKeyFocus = await active();
await typeText('lead'); await enter(); await sleep(300); await typeText('kunoku'); await enter(); await sleep(300);
exp = exp.replace('    "oncall": null\n', '    "oncall": null,\n    "lead": "kunoku"\n'); await step('addInside', exp);
// 14. type: count to text
report.countMenu = await rclick(`document.querySelector('#app .jl[data-p=${P(['doc#0', 'count'])}]')`);
report.typeMenu = await ev(`(()=>{const b=[...document.querySelectorAll('#app .wdmenu .wtype button')].find(x=>x.textContent==='Text'); if(!b) return false; b.click(); return true})()`); await sleep(300);
exp = exp.replace('"count": 13', '"count": "13"'); await step('changeType', exp);
// 15. undo, redo
const beforeType = exp.replace('"count": "13"', '"count": 13');
await ev(`document.activeElement && document.activeElement.blur()`); await undo(); await sleep(300); await step('undo', beforeType);
await key('z', 'KeyZ', 90, 4 | 8); await sleep(300); await step('redo', exp);
// 16. colours: a cell colour is kept on this machine, the file is untouched
await rclick(cell(1, 'step')); await ev(`[...document.querySelectorAll('#app .wdmenu .wscope button')].find(b=>b.dataset.k==='cell').click()`); await ev(`document.querySelector('#app .wdmenu .sw[data-cc=teal]').click()`); await sleep(300);
report.colour = await ev(`({cc:(${cell(1, 'step')}||{dataset:{}}).dataset.cc||null, store:localStorage.getItem('mdr-jcolours')})`);
await step('colourNoFileChange', exp);
report.validJson = await ev(`(()=>{try{JSON.parse(document.querySelector('#app textarea.src').value.replace('   // per unit','')); return true}catch(e){return e.message}})()`);
console.error('validJson', report.validJson); await shot('json-write.png'); console.error('shot done');

// ================= SQL =================
console.error('mounting sql'); // the extension opens .sql only from a file, so: ⌘T, paste the query, Write
await ev(`dispatchEvent(new KeyboardEvent('keydown',{key:'t',metaKey:true,bubbles:true}))`); await sleep(300);
await ev(`(()=>{const ta=document.querySelector('#app textarea.src'); ta.value=${JSON.stringify(read('write.sql'))}; ta.dispatchEvent(new Event('input',{bubbles:true}));})()`); await sleep(200);
await ev(`document.querySelector('#app .top [data-mode=write]').click()`); await sleep(500);
report.sqlMounted = await ev(`document.querySelector('#app').dataset.kind`);
report.sqlState = await ev(`({on:document.querySelector('#app').classList.contains('writing-data'), codes:document.querySelectorAll('#app code.wed[data-wk=sql]').length, titles:document.querySelectorAll('#app [data-wk=title]').length})`);
let sx = read('write.sql');
// 1. type in a query; after a pause it is written and re-coloured, the cursor stays where it was
await click(`document.querySelector('#app .sqlb[data-st="0"] pre > code')`);
await ev(`(()=>{const el=document.activeElement; const w=document.createTreeWalker(el,NodeFilter.SHOW_TEXT); let all='',ns=[]; while(w.nextNode()){ns.push([w.currentNode,all.length]); all+=w.currentNode.nodeValue;} const i=all.indexOf('o.total')+7; const n=ns.filter(x=>x[1]<=i).pop(); const r=document.createRange(); r.setStart(n[0], i-n[1]); r.collapse(true); const s=getSelection(); s.removeAllRanges(); s.addRange(r)})()`);
await typeText(', o.placed_at'); await sleep(1800);
sx = sx.replace('select o.id, o.total', 'select o.id, o.total, o.placed_at'); await step('sqlType', sx);
report.sqlAfterPause = await ev(`(()=>{const a=document.activeElement; const s=getSelection(); if(!s.rangeCount||!a.dataset) return null; const r=document.createRange(); r.setStart(a,0); r.setEnd(s.anchorNode,s.anchorOffset); return {wk:a.dataset.wk, before:r.toString().slice(-12), coloured:[...a.querySelectorAll('span')].some(x=>x.textContent==='placed_at')}})()`);
await typeText(' as placed'); await esc(); await sleep(400);
sx = sx.replace('o.placed_at', 'o.placed_at as placed'); await step('sqlEsc', sx);
// 2. a title
await click(`document.querySelector('#app [data-wk=title]')`); await selAll(); await typeText('Open orders today'); await enter(); await sleep(400);
sx = sx.replace('-- Open orders', '-- Open orders today'); await step('sqlTitle', sx);
// 3. menu: duplicate query 2, delete the copy, undo, move query 2 up
const q2 = sx.slice(sx.indexOf('-- Big customers'), sx.lastIndexOf(';') + 1);
report.sqlMenu = await rclick(`document.querySelector('#app .sqlb[data-st="1"]')`); await menuClick('Duplicate'); await sleep(400);
const withDup = sx.replace(q2, q2 + '\n\n' + q2); await step('sqlDup', withDup);
report.sqlCount = await ev(`document.querySelectorAll('#app .sqlb[data-st]').length`);
await rclick(`document.querySelector('#app .sqlb[data-st="2"]')`); await menuClick('Delete query'); await sleep(400);
await step('sqlDel', sx);
await ev(`document.activeElement && document.activeElement.blur()`); await undo(); await sleep(300); await step('sqlUndo', withDup);
await undo(); await sleep(300); await step('sqlUndo2', sx);
await rclick(`document.querySelector('#app .sqlb[data-st="1"]')`); await menuClick('Move up'); await sleep(400);
const q1 = sx.slice(0, sx.indexOf('\n\n-- Big'));
await step('sqlMove', q2 + '\n\n' + q1 + '\n');
// 4. toolbar + Query
await click(`document.querySelector('#app .sqlb[data-st="1"] pre > code')`); await esc(); await sleep(200);
await click(`document.querySelector('#app .sqlb[data-st="1"] .sqlsum, #app .sqlb[data-st="1"]')`); await esc();
await ev(`document.querySelector('#app .wdbar [data-act=add]').click()`); await sleep(400);
report.sqlAdd = await ev(`({n:document.querySelectorAll('#app .sqlb[data-st]').length, sel:getSelection().toString(), wk:document.activeElement.dataset.wk})`);
await shot('sql-write.png');

report.checks = checks;
report.writeDataOk = !!(report.mounted && report.jsonState.on && report.jsonState.mode === 'write' && report.nameShown === 'deploy-report' && report.priceShown === '1.50'
  && report.afterTab && report.afterTab.wk === 'k' && report.afterKeyEnter && report.afterKeyEnter.wk === 'v' && report.afterCellEnter && report.afterCellEnter.i === '2'
  && report.rowDropLine === true && report.colDropLine === true && report.colSel > 0 && report.colour.cc === 'teal' && report.validJson === true
  && report.sqlState.on && report.sqlState.codes === 2 && report.sqlAfterPause && report.sqlAfterPause.wk === 'sql' && report.sqlAfterPause.coloured && /placed_at$/.test(report.sqlAfterPause.before)
  && report.sqlAdd.n === 3 && report.sqlAdd.wk === 'sql' && Object.values(checks).every(Boolean) && !logs.length);
writeFileSync(path.join(outdir, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ writeDataOk: report.writeDataOk, checks, logs }));
killChrome(); process.exit(report.writeDataOk ? 0 : 1);
