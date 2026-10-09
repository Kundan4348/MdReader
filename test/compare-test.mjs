// Compare two JSONs: defaults, summary, tree / list, next-previous, options, multi-document files, paste (extension host).
// Usage: node test/compare-test.mjs <base-url> <outdir>   -- base-url serves the repo root
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
const read = (f) => readFileSync(path.join(root, 'test/fixtures', f), 'utf8');
const key = (k, code, vk, mods = 0) => send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods }).then(() => send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods }));
const state = () => ev(`(()=>{const c=document.querySelector('#app .cmp'); return {open:!c.hidden, left:c.querySelector('.cmp-src').selectedOptions[0]?.textContent, right:c.querySelectorAll('.cmp-src')[1].selectedOptions[0]?.textContent,
  sum:c.querySelector('.jd-sum')?.textContent.replace(/\\s+/g,' ').trim(), big:c.querySelector('.jd-big')?.textContent, sub:c.querySelector('.jd-sub')?.textContent,
  tiles:Object.fromEntries([...c.querySelectorAll('.jd-tile')].map(t=>[t.dataset.k,+t.querySelector('.jd-tn').textContent])), note:[...c.querySelectorAll('.jd-note')].map(n=>n.textContent).join(' | '),
  fills:c.querySelectorAll('.jd-fill').length, sbsRows:c.querySelectorAll('.jd-sbs tbody tr.jd-r').length, marks:[...c.querySelectorAll('.jd-c')].filter(x=>x.getClientRects().length).map(x=>x.dataset.path),
  gaps:c.querySelectorAll('.jd-gap').length, pos:c.querySelector('.cmp-pos').textContent, cur:c.querySelector('.jd-cur')?.dataset.path||null, msg:c.querySelector('.cmp-msg')?.textContent||null,
  docHidden:getComputedStyle(document.querySelector('#app .doc')).display==='none', rows:c.querySelectorAll('.jd-table tbody tr').length, opts:[...c.querySelector('.cmp-src').options].map(o=>o.textContent)}})()`);
const cmpKey = () => key('D', 'KeyD', 68, 4 | 8);
const checks = {};

report.mounted = await mount(base + '/test/fixtures/cmp-before.json'); await sleep(700);
report.btn = await ev(`getComputedStyle(document.querySelector('#app .top .cmpb')).display`);
// a second JSON in a new tab
await ev(`dispatchEvent(new KeyboardEvent('keydown',{key:'t',metaKey:true,bubbles:true}))`); await sleep(300);
await ev(`(()=>{const ta=document.querySelector('#app textarea.src'); ta.value=${JSON.stringify(read('cmp-after.json'))}; ta.dispatchEvent(new Event('input',{bubbles:true}));})()`); await sleep(200);
await ev(`document.querySelector('#app .top [data-mode=read]').click()`); await sleep(300);
await ev(`document.querySelector('#app .tabs .tab').click()`); await sleep(500); // back to the before file
await ev(`document.body.focus()`); await cmpKey(); await sleep(500);
report.s1 = await state();
const want = ['$.status', '$.carrier.tracking', '$.weightKg', '$.notes', '$.items[sku="CBL-QSFP"]', '$.items[sku="PSU-1100"].qty', '$.items[sku="RACK-42U"]', '$.history[2]', '$.deliveredTo'];
checks.defaults = report.s1.open && /cmp-before\.json \(this tab\)/.test(report.s1.left) && /Untitled/.test(report.s1.right) && report.s1.docHidden;
checks.summary = report.s1.big === '9' && /^from cmp-before\.json to Untitled 1/.test(report.s1.sub) && JSON.stringify(report.s1.tiles) === '{"chg":4,"add":3,"del":2,"mv":0}' && /paired by "sku"/.test(report.s1.note);
checks.marks = JSON.stringify(report.s1.marks) === JSON.stringify(want);
checks.folded = report.s1.gaps > 0;
report.detail = await ev(`(()=>{const c=document.querySelector('#app .cmp'); const l=(p)=>[...c.querySelectorAll('.jd-c')].find(x=>x.dataset.path===p);
  return {status:l('$.status').textContent.replace(/\\s+/g,' '), mark:l('$.carrier.tracking').querySelector('ins mark').textContent, kind:l('$.weightKg').querySelector('.jd-kind').textContent, id:!!c.querySelector('.jd-id')}})()`);
checks.detail = /"IN_TRANSIT"\s*→\s*"DELIVERED"/.test(report.detail.status) && report.detail.mark === '5' && report.detail.kind === 'number → text';
await shot('compare-tree.png');
await ev(`document.querySelector('#app .cmp-optsb').click()`); await sleep(150); await shot('compare-options.png'); await ev(`document.querySelector('#app .cmp-optsb').click()`);
// next / previous
await key('n', 'KeyN', 78); await key('n', 'KeyN', 78); report.n2 = await state();
await key('p', 'KeyP', 80); report.p1 = await state();
checks.nav = report.n2.cur === want[1] && report.n2.pos === '2 of 9' && report.p1.cur === want[0];
// side by side: one marked row per difference, hatched space opposite added / removed parts
await ev(`document.querySelector('#app .cmp-seg [data-v=side]').click()`); await sleep(250); report.side = await state(); await shot('compare-side.png');
checks.side = report.side.marks.length === 9 && report.side.fills > 0 && report.side.sbsRows > 9;
await ev(`document.querySelector('#app .cmp-seg [data-v=tree]').click()`); await sleep(150);
// a tile hides that kind: hiding "added" leaves 6
await ev(`document.querySelector('#app .jd-tile[data-k=add]').click()`); await sleep(150); report.hideAdd = await state();
await ev(`document.querySelector('#app .jd-tile[data-k=add]').click()`); await sleep(150);
checks.tiles = report.hideAdd.marks.length === 6 && !report.hideAdd.marks.some((p) => p === '$.deliveredTo');
// the path box narrows to matching differences
await ev(`(()=>{const q=document.querySelector('#app .cmp-q'); q.value='items'; q.dispatchEvent(new Event('input'))})()`); await sleep(150); report.q = await state();
await ev(`(()=>{const q=document.querySelector('#app .cmp-q'); q.value=''; q.dispatchEvent(new Event('input'))})()`); await sleep(150);
checks.pathFilter = JSON.stringify(report.q.marks) === JSON.stringify(want.filter((p) => p.includes('items')));
// keys left out everywhere
await ev(`(()=>{const i=document.querySelector('#app .cmp-ign'); i.value='status, tracking'; i.dispatchEvent(new Event('input'))})()`); await sleep(500); report.ign = await state();
await ev(`(()=>{const i=document.querySelector('#app .cmp-ign'); i.value=''; i.dispatchEvent(new Event('input'))})()`); await sleep(500);
checks.ignoreKeys = report.ign.marks.length === 7 && /Leaving out "status", "tracking"/.test(report.ign.note);
// list view
await ev(`document.querySelector('#app .cmp-seg [data-v=list]').click()`); await sleep(200); report.list = await state(); await shot('compare-list.png');
checks.list = report.list.rows === 9;
await ev(`document.querySelector('#app .cmp-seg [data-v=tree]').click()`); await sleep(150);
// show everything: no folded runs
await ev(`(()=>{const i=[...document.querySelectorAll('#app .cmp-opt input')][0]; i.click()})()`); await sleep(150); report.all = await state();
checks.allShown = report.all.gaps === 0 && report.all.marks.length === 9;
await ev(`(()=>{const i=[...document.querySelectorAll('#app .cmp-opt input')][0]; i.click()})()`); await sleep(150);
// by position: the inserted item now looks like every later one changed
await ev(`document.querySelector('#app .cmp-pop [data-m=position]').click()`); await sleep(200); report.pos = await state();
checks.position = report.pos.marks.length > 9;
await ev(`document.querySelector('#app .cmp-pop [data-m=auto]').click()`); await sleep(150);
// swap
await ev(`document.querySelector('#app .cmp-swap').click()`); await sleep(200); report.swap = await state();
checks.swap = /^Untitled/.test(report.swap.left) && report.swap.tiles.del === 3 && report.swap.tiles.add === 2;
// copy report text (the same text Copy puts on the clipboard)
{ const vm = await import('node:vm'); const g = {}; vm.runInNewContext(readFileSync(path.join(root, 'core/jdiff.js'), 'utf8'), { window: g }); // the page's script world is the extension's, not reachable from here
  report.reportText = g.JD.report(g.JD.diff(JSON.parse(read('cmp-before.json')), JSON.parse(read('cmp-after.json'))), ['before', 'after']); }
checks.report = report.reportText.split('\n')[0] === 'before → after: 9 differences (4 changed, 3 added, 2 removed)';
// paste: right side = Paste JSON…; broken text explains itself; good text compares
await ev(`(()=>{const s=document.querySelectorAll('#app .cmp-src')[1]; s.value='paste'; s.dispatchEvent(new Event('change'))})()`); await sleep(200);
report.pasteWait = await state();
await ev(`(()=>{const t=[...document.querySelectorAll('#app .cmp-paste')].find(x=>!x.hidden); t.value='{"shipmentId": "SHP-20391", }'; t.dispatchEvent(new Event('input'))})()`); await sleep(500);
report.pasteBad = await state();
await ev(`(()=>{const t=[...document.querySelectorAll('#app .cmp-paste')].find(x=>!x.hidden); t.value=${JSON.stringify(JSON.stringify({ ...JSON.parse(read('cmp-after.json')), status: 'IN_TRANSIT' }))}; t.dispatchEvent(new Event('input'))})()`); await sleep(500);
report.pasteOk = await state();
checks.paste = /Paste the right JSON/.test(report.pasteWait.msg || '') && /The right side is not valid JSON \(line 1, column \d+\): trailing comma/.test(report.pasteBad.msg || '') && report.pasteOk.big === '1' && /^from Untitled 1 to pasted right/.test(report.pasteOk.sub || '');
// Esc closes, the page is back
await ev(`document.body.focus()`); await key('Escape', 'Escape', 27); await sleep(200);
report.closed = await ev(`({open:!document.querySelector('#app .cmp').hidden, doc:getComputedStyle(document.querySelector('#app .doc')).display})`);
checks.close = !report.closed.open && report.closed.doc !== 'none';
// a file with "before" and "after" documents compares them straight away
report.multiMounted = await mount(base + '/test/fixtures/multi.json'); await sleep(700);
await ev(`document.querySelector('#app .top .cmpb').click()`); await sleep(400);
report.multi = await state();
checks.multi = /multi\.json · before/.test(report.multi.left) && /multi\.json · after|the response once/.test(report.multi.right) && report.multi.tiles.add === 3;
// two differently shaped JSONs: the panel suggests the parts that match, and compares them on one click
await ev(`document.querySelector('#app .cmp-x').click()`); await sleep(200);
report.evMounted = await mount(base + '/test/fixtures/cmp-event.json'); await sleep(700);
await ev(`dispatchEvent(new KeyboardEvent('keydown',{key:'t',metaKey:true,bubbles:true}))`); await sleep(300);
await ev(`(()=>{const ta=document.querySelector('#app textarea.src'); ta.value=${JSON.stringify(read('cmp-entity.json'))}; ta.dispatchEvent(new Event('input',{bubbles:true}));})()`); await sleep(200);
await ev(`document.querySelector('#app .top [data-mode=read]').click()`); await sleep(300);
await ev(`document.querySelector('#app .tabs .tab').click()`); await sleep(500);
await ev(`document.querySelector('#app .top .cmpb').click()`); await sleep(400);
report.shape = await state(); report.shapeHint = await ev(`document.querySelector('#app .cmp-hint')?.textContent`);
await ev(`scrollTo(0,0); document.querySelector('#app .content').scrollTop=0`); await sleep(100); await shot('compare-hint.png');
await ev(`document.querySelector('#app .cmp-hint button').click()`); await sleep(300);
report.inner = await state(); report.innerHint = await ev(`document.querySelector('#app .cmp-hint')?.textContent`); await ev(`scrollTo(0,0); document.querySelector('#app .content').scrollTop=0`); await sleep(100); await shot('compare-inner.png');
await ev(`document.querySelector('#app .cmp-hint button').click()`); await sleep(300); report.back = await state();
checks.shapeHint = report.shape.big === '8' && /parts that match best are \$\.event and \$\.entity/.test(report.shapeHint || '')
  && report.inner.big === '3' && JSON.stringify(report.inner.marks) === JSON.stringify(['$.serializationToken', '$.serializedObject.ownerSupplyChain', '$.serializedObject.currentOwnerArn'])
  && /Comparing \$\.event with \$\.entity/.test(report.innerHint || '') && /› event/.test(report.inner.sub) && report.back.big === '8';
// the same pair in Lumen, every view (screenshots), and a folded value opens
await ev(`document.documentElement.dataset.theme='lumen'`); await sleep(200);
for (const v of ['tree', 'list', 'side']) { await ev(`document.querySelector('#app .cmp-seg [data-v=${v}]').click()`); await sleep(250); await ev(`scrollTo(0,0); document.querySelector('#app .content').scrollTop=0`); await shot(`lumen-${v}.png`); }
await ev(`document.querySelector('#app .cmp-seg [data-v=list]').click()`); await sleep(200);
report.listCols = await ev(`[...document.querySelectorAll('#app .jd-table tbody tr:first-child td')].map(td=>Math.round(td.getBoundingClientRect().width))`);
await ev(`document.querySelector('#app .cmp-seg [data-v=tree]').click()`); await sleep(200);
report.fold = await ev(`(()=>{const d=document.querySelector('#app .jd-val'); const s=d.querySelector('summary'); const before=d.open; s.click(); return {before, after:d.open, cnt:s.querySelector('.jd-cnt').textContent, marker:getComputedStyle(s).listStyleType}})()`);
await shot('lumen-tree-open.png');
checks.lumen = report.listCols.length === 4 && report.listCols.every((w) => w > 90) && report.fold.before === false && report.fold.after === true && report.fold.marker === 'none';
await ev(`document.documentElement.dataset.theme='studio'`); await sleep(200); await shot('compare-studio.png');

report.checks = checks;
report.compareOk = !!(report.mounted && report.btn !== 'none' && Object.values(checks).every(Boolean) && !logs.length);
writeFileSync(path.join(outdir, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ compareOk: report.compareOk, checks, logs }));
killChrome(); process.exit(report.compareOk ? 0 : 1);
