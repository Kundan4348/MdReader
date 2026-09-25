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
report.sections = await ev(`document.querySelectorAll('#app .sec').length`);
report.outline = await ev(`[...document.querySelectorAll('#app .toc a')].map(a=>a.textContent)`);
report.scalars = await ev(`[...document.querySelectorAll('#app .jroot > .jt > .jl')].map(l=>l.querySelector('.jk').textContent+'='+l.querySelector('.jv').textContent+'='+[...l.querySelector('.jv').classList].filter(c=>c!=='jv')[0])`);
report.menuCols = await ev(`[...document.querySelectorAll('#app #menu table thead th')].map(th=>th.firstChild.textContent.trim()+(th.classList.contains('num')?'#':''))`);
report.menuRows = await ev(`document.querySelectorAll('#app #menu table tbody tr').length`);
report.tree = await ev(`(()=>{const s=document.querySelector('#app #address'); return {open:s.open, inner:[...s.querySelectorAll('details.jn')].map(d=>d.querySelector('.jk').textContent+':'+d.open), leaves:s.querySelectorAll('.jl').length, url:!!document.querySelector('#app .jroot a[href^="https://"]')}})()`);
report.empties = await ev(`['empty','nothing'].map(k=>document.querySelector('#app #'+k+' .jempty')?.textContent)`);
report.tools = await ev(`[...document.querySelectorAll('#app .head button.jx')].map(b=>b.dataset.act)`);
// per-column filter on the numeric "price" column of the menu table -> 3 of 4
report.filter = await ev(`(async()=>{const w=document.querySelector('#app #menu .table-wrap'); const ths=[...w.querySelectorAll('thead th')]; const c=ths.findIndex(t=>t.textContent.trim().startsWith('price')); ths[c].querySelector('.tf-btn').click(); const inp=w.querySelectorAll('input.tf')[c]; inp.value='>100'; inp.dispatchEvent(new Event('input',{bubbles:true})); await new Promise(r=>setTimeout(r,50)); const shown=[...w.querySelectorAll('tbody tr')].filter(tr=>!tr.classList.contains('f-hide')).map(tr=>tr.children[1].textContent); return {shown, cap:w.querySelector('.tf-count').textContent}})()`);
await ev(`document.querySelector('#app #menu .tf-clear').click()`);
// Collapse all / Expand all act on every node (the "as tree" folds excluded).
await ev(`document.querySelector('#app .head button.jx[data-act=collapse]').click()`);
report.afterCollapse = await ev(`[...document.querySelectorAll('#app details.jn:not(.jraw)')].filter(d=>d.open).length`);
await ev(`document.querySelector('#app .head button.jx[data-act=expand]').click()`);
report.afterExpand = await ev(`(()=>{const ds=[...document.querySelectorAll('#app details.jn:not(.jraw)')]; return ds.length+':'+ds.filter(d=>d.open).length})()`);
await shot('json-mono.png');
await ev(`(()=>{const s=document.querySelector('#app select.theme'); s.value='sections'; s.dispatchEvent(new Event('change',{bubbles:true}));})()`); await sleep(300);
report.sectionsThemeCards = await ev(`document.querySelectorAll('#app .sec').length + ':' + getComputedStyle(document.querySelector('#app .head .chips')).display`);
await shot('json-sections.png');
await ev(`(()=>{const s=document.querySelector('#app select.theme'); s.value='mono'; s.dispatchEvent(new Event('change',{bubbles:true}));})()`); await sleep(200);
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
report.untitled = await ev(`({kind:document.querySelector('#app').dataset.kind, tab:document.querySelector('#app .tabs .tab.on .name').textContent, h1:document.querySelector('#app .doc h1')?.textContent, fmt:getComputedStyle(document.querySelector('#app .top button.fmt')).display, keys:[...document.querySelectorAll('#app .toc a.l2')].map(e=>e.textContent), secs:document.querySelectorAll('#app .sec').length})`);
await ev(`document.querySelector('#app .top [data-mode=edit]').click()`); await sleep(100);
await ev(`(()=>{const ta=document.querySelector('#app textarea.src'); ta.value='# Not json\\n\\ntext'; ta.dispatchEvent(new Event('input',{bubbles:true}));})()`); await sleep(100);
await ev(`document.querySelector('#app .top [data-mode=read]').click()`); await sleep(150);
report.untitledMd = await ev(`({kind:document.querySelector('#app').dataset.kind, fmt:getComputedStyle(document.querySelector('#app .top button.fmt')).display})`);
// ---- many tabs: each keeps a readable width, the strip scrolls (and follows the active tab), neighbours are divided.
await ev(`document.querySelector('#app .top [data-mode=edit]').click()`); await sleep(100);
await ev(`(()=>{const ta=document.querySelector('#app textarea.src'); ta.value=''; ta.dispatchEvent(new Event('input',{bubbles:true}));})()`); await sleep(100); // empty, so it closes without a prompt later
await ev(`document.querySelector('#app .top [data-mode=read]').click()`); await sleep(100);
for (let i = 0; i < 14; i++) await ev(`dispatchEvent(new KeyboardEvent('keydown',{key:'t',metaKey:true,bubbles:true}))`);
await sleep(300);
report.manyTabs = {};
for (const th of ['paper', 'sections', 'studio', 'mono']) {
  await ev(`(()=>{const s=document.querySelector('#app select.theme'); s.value='${th}'; s.dispatchEvent(new Event('change',{bubbles:true}));})()`); await sleep(200);
  report.manyTabs[th] = await ev(`(()=>{const strip=document.querySelector('#app .tabs'); const tabs=[...strip.querySelectorAll('.tab')]; const on=strip.querySelector('.tab.on').getBoundingClientRect(); const sr=strip.getBoundingClientRect();
    return {n:tabs.length, minW:Math.round(Math.min(...tabs.map(t=>t.getBoundingClientRect().width))), scrolls:strip.scrollWidth>strip.clientWidth+20, activeVisible:on.left>=sr.left-1&&on.right<=sr.right+1, divider:(()=>{const cs=getComputedStyle(tabs[2],'::before'); return cs.display==='none'?'none':cs.borderLeftStyle})(), names:tabs.slice(0,3).map(t=>t.querySelector('.name').textContent)}})()`);
  if (th === 'paper') await shot('json-many-tabs.png');
}
// wheel over the strip pans it sideways
report.wheelPan = await ev(`(()=>{const strip=document.querySelector('#app .tabs'); strip.scrollLeft=0; strip.dispatchEvent(new WheelEvent('wheel',{deltaY:120,bubbles:true,cancelable:true})); return strip.scrollLeft})()`);
for (let i = 0; i < 15; i++) { await ev(`document.querySelector('#app .tabs .tab.on .x')?.click()`); await sleep(60); }
report.tabsAfterClose = await ev(`document.querySelectorAll('#app .tabs .tab').length`);
report.manyTabsOk = Object.entries(report.manyTabs).every(([th, m]) => m.n === 16 && m.minW >= 100 && m.scrolls && m.activeVisible && (th === 'mono' ? m.divider === 'none' : m.divider === 'solid')) && report.wheelPan > 0 && report.tabsAfterClose === 1;
await ev(`(()=>{const s=document.querySelector('#app select.theme'); s.value='mono'; s.dispatchEvent(new Event('change',{bubbles:true}));})()`); await sleep(150);
// ---- tables nested deep in the tree must stay inside their node's indentation in every theme (paper centres wide
// tables past the column; that must not apply here), and never wider than the pane.
report.nestedMounted = await mount(base + '/test/fixtures/nested.json');
await ev(`document.querySelector('#app .head button.jx[data-act=expand]').click()`);
report.nested = {};
for (const th of ['paper', 'sections', 'studio', 'mono']) {
  await ev(`(()=>{const s=document.querySelector('#app select.theme'); s.value='${th}'; s.dispatchEvent(new Event('change',{bubbles:true}));})()`); await sleep(250);
  report.nested[th] = await ev(`(()=>{const ws=[...document.querySelectorAll('#app .jroot details.jn>.table-wrap')]; const pane=document.querySelector('#app .doc').getBoundingClientRect(); return ws.map(w=>{const r=w.getBoundingClientRect(); const sm=w.parentElement.querySelector('summary').getBoundingClientRect(); return {inside:r.left>=sm.left-1 && r.right<=pane.right+1, indented:r.left>sm.left+8, narrow:r.width<pane.width*0.8, rowH:Math.round(w.querySelector("tbody tr").getBoundingClientRect().height), rows:w.querySelectorAll('tbody tr').length}})})()`);
  if (th === 'paper') await shot('json-nested-paper.png');
}
await ev(`(()=>{const s=document.querySelector('#app select.theme'); s.value='mono'; s.dispatchEvent(new Event('change',{bubbles:true}));})()`); await sleep(200);
report.nestedOk = report.nestedMounted && Object.values(report.nested).every((ws) => ws.length === 2 && ws.every((w) => w.inside && w.indented && w.narrow && w.rowH < 32) && ws[0].rows === 2 && ws[1].rows === 3);
// ---- several top-level values with comments and same-line notes: one section per document, comments kept in place
report.multiMounted = await mount(base + '/test/fixtures/multi.json');
report.multi = await ev(`(()=>{const secs=[...document.querySelectorAll('#app .sec')]; const s1=secs[1];
  return {kind:document.querySelector('#app').dataset.kind, meta:document.querySelector('#app .doc .head .jmeta').textContent, secs:secs.length,
    titles:secs.map(s=>s.querySelector('h2 .t').textContent), nums:secs.map(s=>s.querySelector('h2 .n')?.textContent),
    lead:s1.querySelector('.jlead')?.textContent, headTrees:document.querySelectorAll('#app .head .jroot').length, stray:[...secs[0].querySelector('.body').childNodes].filter(n=>n.nodeType===3&&n.textContent.trim()).length,
    notes:[...s1.querySelectorAll('.jroot > .jt > .jl:not(.jcm), .jroot > .jt > details.jn > summary')].map(l=>l.querySelector('.jk')?.textContent+'='+(l.querySelector('.jnote')?.textContent||'')),
    comments:[...s1.querySelectorAll('.jl.jcm')].map(l=>l.textContent), table:s1.querySelectorAll('table tbody tr').length,
    outline:[...document.querySelectorAll('#app .toc a')].map(a=>[...a.classList].filter(c=>c!=='active').join()+':'+a.textContent), side:document.querySelector('#app .meta')?.textContent||document.querySelector('#app .outline .meta')?.textContent}})()`);
report.multiSource = await ev(`document.querySelector('#app textarea.src').value`);
await ev(`document.querySelector('#app .top button.fmt').click()`); await sleep(150);
report.multiFormatted = await ev(`document.querySelector('#app textarea.src').value`);
report.multiAfterFormat = await ev(`({secs:document.querySelectorAll('#app .sec').length, notes:document.querySelectorAll('#app .jnote').length, comments:document.querySelectorAll('#app .jl.jcm').length, dirty:document.querySelector('#app').classList.contains('dirty')})`);
await ev(`document.querySelector('#app .top button.fmt').dispatchEvent(new MouseEvent('click',{altKey:true,bubbles:true}))`); await sleep(150);
report.multiMinifyToast = await ev(`document.querySelector('#app .toast')?.textContent`);
await shot('json-multi.png');
await ev(`(()=>{const s=document.querySelector('#app select.theme'); s.value='paper'; s.dispatchEvent(new Event('change',{bubbles:true}));})()`); await sleep(250);
await shot('json-multi-paper.png');
await ev(`(()=>{const s=document.querySelector('#app select.theme'); s.value='mono'; s.dispatchEvent(new Event('change',{bubbles:true}));})()`); await sleep(150);
// pasted into an untitled tab, the same text (comments first) is still recognised as JSON
await ev(`dispatchEvent(new KeyboardEvent('keydown',{key:'t',metaKey:true,bubbles:true}))`); await sleep(200);
await ev(`(()=>{const ta=document.querySelector('#app textarea.src'); ta.value=${JSON.stringify('// before\n{"a": 1}\n// after\n{"a": 2,  ← changed\n"b": true}')}; ta.dispatchEvent(new Event('input',{bubbles:true}));})()`); await sleep(100);
await ev(`document.querySelector('#app .top [data-mode=read]').click()`); await sleep(150);
report.multiUntitled = await ev(`({kind:document.querySelector('#app').dataset.kind, secs:[...document.querySelectorAll('#app .sec h2 .t')].map(e=>e.textContent), note:document.querySelector('#app .jnote')?.textContent})`);
await ev(`document.querySelector('#app .top [data-mode=edit]').click()`); await sleep(100);
await ev(`(()=>{const ta=document.querySelector('#app textarea.src'); ta.value=''; ta.dispatchEvent(new Event('input',{bubbles:true}));})()`); await sleep(100);
await ev(`document.querySelector('#app .tabs .tab.on .x')?.click()`); await sleep(150);
report.multiOk = report.multiMounted && report.multi.kind === 'json' && /^2 documents · .* · \d+ lines · 10 comments/.test(report.multi.meta) && report.multi.secs === 2
  && report.multi.titles.join('|') === 'before|after' && report.multi.nums.join() === '01,02' && report.multi.lead === 'the response once the flag ships' && report.multi.headTrees === 0 && report.multi.stray === 0
  && report.multi.notes.join('|') === '"primaryIds"=← same|"nextToken"=← same|"primaryIdResolution"=← new, optional|"unfilteredPrimaryIds"=← new, optional|"rows"='
  && report.multi.comments.join('|') === '// only present on a collision|// end of after|// tail note' && report.multi.table === 2
  && report.multi.outline.join() === 'l1:multi.json,l2:before,l3:primaryIds,l3:nextToken,l2:after,l3:primaryIds,l3:nextToken,l3:primaryIdResolution,l3:unfilteredPrimaryIds,l3:rows'
  && /^\/\/ before\n\{\n  "primaryIds": \[\n/.test(report.multiFormatted) && /\n\n\/\/ after\n\/\/ the response once the flag ships\n\{\n  "primaryIds": \[ \/\/ ← same\n/.test(report.multiFormatted)
  && /  "nextToken": null, \/\/ ← same\n  \/\/ only present on a collision\n  "primaryIdResolution": "AMBIGUOUS", \/\/ ← new, optional\n/.test(report.multiFormatted) && /  \/\/ end of after\n\}\n\/\/ tail note\n$/.test(report.multiFormatted)
  && report.multiAfterFormat.secs === 2 && report.multiAfterFormat.notes === 4 && report.multiAfterFormat.comments === 3 && report.multiAfterFormat.dirty
  && /inline comments would be lost/.test(report.multiMinifyToast)
  && report.multiUntitled.kind === 'json' && report.multiUntitled.secs.join('|') === 'before|after' && report.multiUntitled.note === '← changed';
// ---- a broken file: error banner with line/column, source shown, Format refuses politely
report.brokenMounted = await mount(base + '/test/fixtures/broken.json');
report.broken = await ev(`({kind:document.querySelector('#app').dataset.kind, err:document.querySelector('#app .jerr')?.textContent, excerpt:document.querySelector('#app .jexcerpt')?.textContent, source:!!document.querySelector('#app .head .jsource'), secs:document.querySelectorAll('#app .sec').length})`);
await ev(`document.querySelector('#app .top button.fmt').click()`); await sleep(100);
report.brokenToast = await ev(`document.querySelector('#app .toast')?.textContent`);
await shot('json-broken.png');

report.jsonOk = report.mounted && report.kind === 'json' && report.h1 === 'data.json' && /Object · 12 keys/.test(report.meta) && /minified/.test(report.meta)
  && report.sections === 0 && report.outline.join() === 'data.json,name,version,open,seats,rating,manager,homepage,address,menu,hours,empty,nothing'
  && report.scalars.length === 9 && report.scalars.includes('"manager"=null=jnull') && report.scalars.includes('"seats"=24=jnum') && report.scalars.includes('"open"=true=jbool')
  && report.menuCols.join() === '##,item,price#,sold#,tags' && report.menuRows === 4
  && report.tree.open === true && report.tree.inner.join() === '"geo":true' && report.tree.leaves === 4 && report.tree.url
  && report.empties.join() === '{ },[ ]' && report.tools.join() === 'expand,collapse' && report.sectionsThemeCards === '0:none'
  && report.filter.shown.join() === 'Espresso,Latte,Cold brew' && report.filter.cap === '3 of 4 rows'
  && report.afterCollapse === 0 && /^(\d+):\1$/.test(report.afterExpand)
  && report.fmtVisible !== 'none' && report.linesBefore === 2 && report.linesAfter > 20 && report.dirtyAfterFormat && !/minified/.test(report.metaAfter) && report.h1After === 'data.json'
  && report.linesMinified === 1 && report.dirtyAfterMinify && report.gutter === 'json'
  && report.untitled.kind === 'json' && report.untitled.tab === 'Untitled 1' && report.untitled.fmt !== 'none' && report.untitled.keys.join() === 'a,b,c' && report.untitled.secs === 0
  && report.untitledMd.kind === 'md' && report.untitledMd.fmt === 'none' && report.nestedOk && report.manyTabsOk && report.multiOk
  && report.brokenMounted && report.broken.kind === 'json' && /Invalid JSON at line 3, column \d+/.test(report.broken.err) && /^3: /.test(report.broken.excerpt) && report.broken.source && report.broken.secs === 0
  && /Cannot format/.test(report.brokenToast) && !logs.some((l) => l.startsWith('EXC'));
console.log(JSON.stringify(report, null, 2));
killChrome();
process.exit(report.jsonOk ? 0 : 1);
