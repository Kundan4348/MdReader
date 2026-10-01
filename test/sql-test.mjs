// SQL documents through the extension host (shared core, so the app renders identically): an untitled paste of the
// switch-queries fixture is recognised as SQL, split into titled statements, summarised in plain words and coloured by
// role (clause colours, per-alias hues, legible comments), with source-line stamps for the split view.
// Usage: node test/sql-test.mjs <base-url> <outdir>   -- base-url serves the repo root
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
  `--load-extension=${path.join(root, 'extension')}`, '--remote-debugging-port=0', '--window-size=1280,1800', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
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
const theme = async (t) => { await ev(`(()=>{const s=document.querySelector('#app select.theme'); s.value='${t}'; s.dispatchEvent(new Event('change',{bubbles:true}));})()`); await sleep(250); };
const report = { logs };

report.mounted = await mount(base + '/sample.md');
const sql = readFileSync(path.join(root, 'test/fixtures/switch-queries.sql'), 'utf8');
// ⌘T, paste the SQL, switch to Read
await ev(`dispatchEvent(new KeyboardEvent('keydown',{key:'t',metaKey:true,bubbles:true}))`); await sleep(200);
await ev(`(()=>{const ta=document.querySelector('#app textarea.src'); ta.value=${JSON.stringify(sql)}; ta.dispatchEvent(new Event('input',{bubbles:true}));})()`); await sleep(100);
await ev(`document.querySelector('#app .top [data-mode=read]').click()`); await sleep(250);
report.kind = await ev(`document.querySelector('#app').dataset.kind`);
report.doc = await ev(`({tab:document.querySelector('#app .tabs .tab.on .name').textContent, meta:document.querySelector('#app .doc .head .jmeta')?.textContent, header:document.querySelector('#app .doc .shdr')?.innerText.split('\\n'), secs:document.querySelectorAll('#app .sec').length, titles:[...document.querySelectorAll('#app .sec h2 .t')].map(e=>e.textContent), toc:[...document.querySelectorAll('#app .toc a.l2')].map(e=>e.textContent), copyBtn:document.querySelector('#app .sec .tools [data-act=copy]')?.textContent, editBtn:!!document.querySelector('#app .sec .tools [data-act=edit]'), outlineMeta:document.querySelector('#app .outline .meta')?.innerText})`);
// Q0a: summary rows, alias hues, line roles, comment colour
report.q0a = await ev(`(()=>{const s=document.querySelector('#app .sec[data-i="0"]'); const rows=[...s.querySelectorAll('.sqlsum .sr')].map(r=>r.querySelector('.sl').textContent+' | '+r.querySelector('.sv').textContent.replace(/\\s+/g,' ').trim());
  const defs=[...s.querySelectorAll('.tk-al.tk-def')].map(e=>e.textContent+':'+[...e.classList].find(c=>/^tk-h\\d/.test(c)));
  const refs=[...s.querySelectorAll('code.hl .tk-al:not(.tk-def)')].map(e=>e.textContent+':'+[...e.classList].find(c=>/^tk-h\\d/.test(c)));
  const bg=[...s.querySelectorAll('.tk-al.tk-def')].map(e=>getComputedStyle(e).backgroundColor);
  const roles=[...s.querySelectorAll('code.hl .line')].map(l=>l.dataset.role||'-');
  const bar=[...s.querySelectorAll('code.hl .line[data-role]')].map(l=>getComputedStyle(l,'::after').backgroundColor);
  const kw=[...s.querySelectorAll('code.hl .tk-k')].map(k=>k.textContent.toLowerCase()+'='+getComputedStyle(k).color);
  const tbl=[...s.querySelectorAll('code.hl .tk-tbl')].map(e=>e.textContent);
  const out=[...s.querySelectorAll('code.hl .tk-out')].map(e=>e.textContent);
  const stamps=[...s.querySelectorAll('code.hl .line')].map(l=>l.dataset.l0);
  const cb=s.querySelector('.codeblock'); return {rows, defs, refs, bgDistinct:new Set(bg).size, roles, barColors:new Set(bar).size, kw, tbl, out, stamps, block:[cb.dataset.l0,cb.dataset.l1,cb.querySelector('code').getAttribute('style')], lc:cb.querySelector('.lc').textContent, text:cb.querySelector('pre>code').textContent};})()`);
// Q2: the trailing comment on the ';' line stays with Q2 and is legible (role colour, not the dim grey)
report.q2 = await ev(`(()=>{const s=document.querySelector('#app .sec[data-i="3"]'); const c=[...s.querySelectorAll('code.hl .tk-c')]; const col=c.map(e=>getComputedStyle(e).color); const body=getComputedStyle(s.querySelector('pre>code')).color; const kw=getComputedStyle(s.querySelector('.tk-k.tk-r-filter')).color;
  return {comments:c.map(e=>e.textContent), colors:[...new Set(col)], body, kwFilter:kw, marker:getComputedStyle(c[0].querySelector('.tk-cm')).opacity, keeps:s.querySelector('.sr-filter .sv')?.textContent.replace(/\\s+/g,' ').trim()};})()`);
// Q3: CTEs, left join, star, tooltips, the comment line inside the CTE body
report.q3 = await ev(`(()=>{const s=document.querySelector('#app .sec[data-i="4"]'); const rows=[...s.querySelectorAll('.sqlsum .sr')].map(r=>r.querySelector('.sl').textContent+' | '+r.querySelector('.sv').textContent.replace(/\\s+/g,' ').trim());
  const ctes=[...s.querySelectorAll('code.hl .tk-cte.tk-def')].map(e=>e.textContent+':'+[...e.classList].find(c=>/^tk-h\\d/.test(c)));
  const cteRefs=[...s.querySelectorAll('code.hl .tk-cte:not(.tk-def), code.hl .tk-al')].filter(e=>/^(sw|ev|last_ev)$/.test(e.textContent)).map(e=>e.textContent+':'+[...e.classList].find(c=>/^tk-h\\d/.test(c)));
  const hues=new Set([...s.querySelectorAll('code.hl .tk-def')].map(e=>[...e.classList].find(c=>/^tk-h\\d/.test(c))));
  const eRefs=[...s.querySelectorAll('code.hl .tk-al')].filter(e=>e.textContent==='e').map(e=>[...e.classList].find(c=>/^tk-h\\d/.test(c)));
  const tips=[...s.querySelectorAll('.sqlsum .sr-define code')].map(e=>e.title);
  const lines=[...s.querySelectorAll('code.hl .line')]; const roles=lines.map(l=>l.dataset.role||'-');
  const desc=s.querySelector('.slead')?.textContent; return {rows, ctes, cteRefs, hueCount:hues.size, defCount:hues.size && s.querySelectorAll('code.hl .tk-def').length, eRefs:[...new Set(eRefs)], tips, roles, desc, lc:s.querySelector('.lc').textContent, aliasTip:s.querySelector('code.hl .tk-al[title]')?.title};})()`);
await ev(`document.querySelector('#app .sec[data-i="0"]').scrollIntoView()`); await sleep(100);
await shot('sql-paper.png');
await theme('studio');
report.studio = await ev(`(()=>{const s=document.querySelector('#app .sec[data-i="0"]'); return {kw:getComputedStyle(s.querySelector('.tk-k.tk-r-output')).color, al:getComputedStyle(s.querySelector('.tk-al.tk-def')).color, cm:getComputedStyle(document.querySelector('#app .sec[data-i="3"] .tk-c')).color};})()`);
await ev(`document.querySelector('#app .sec[data-i="4"]').scrollIntoView()`); await sleep(100);
await shot('sql-studio-q3.png');
await theme('paper');
// Split: the lines carry source-line stamps, so the sync has something to lock to
await ev(`document.querySelector('#app .top [data-mode=split]').click()`); await sleep(200);
report.split = await ev(`(()=>{const ls=[...document.querySelectorAll('#app .doc code.hl .line[data-l0]')]; const n=document.querySelector('#app textarea.src').value.split('\\n').length; return {stamped:ls.length, firstLine:ls[0].dataset.l0, lastLine:ls[ls.length-1].dataset.l1, srcLines:n};})()`);
await ev(`document.querySelector('#app .top [data-mode=read]').click()`); await sleep(100);
// Legend above the first query: only roles the document uses, role colours match the keywords, one alias chip, sits before the first statement
report.legend = await ev(`(()=>{const lg=document.querySelector('#app .doc .head .sqllegend'); if(!lg) return null; const items=[...lg.querySelectorAll('.lg')].map(e=>({role:e.querySelector('b').textContent, words:e.querySelector('code').textContent, color:getComputedStyle(e,'::before').backgroundColor, title:e.title}));
  const kwCol=(r)=>getComputedStyle(document.querySelector('#app .sec code.hl .tk-k.tk-r-'+r)).color; const first=document.querySelector('#app .sec'); const ar=lg.getBoundingClientRect(), br=first.getBoundingClientRect();
  return {count:document.querySelectorAll('#app .doc .sqllegend').length, items, match:['define','output','source','filter','shape','combine'].every(r=>items.find(i=>i.role===r)&&items.find(i=>i.role===r).color===kwCol(r)), above:ar.bottom<=br.top, h:ar.height, w:ar.width, alias:lg.querySelector('.lg-alias code')?.className, title:lg.querySelector('.lgt').textContent};})()`);
await ev(`document.querySelector('#app .doc .sqllegend .lgx').click()`); await sleep(100);
report.legendOff = await ev(`(()=>{const lg=document.querySelector('#app .doc .sqllegend'); return {off:lg.classList.contains('off'), h:lg.getBoundingClientRect().height, w:lg.getBoundingClientRect().width, stored:localStorage.getItem('mdr-sql-legend'), dots:[...lg.querySelectorAll('.lg')].map(e=>getComputedStyle(e,'::before').borderRadius)};})()`);
// hidden state survives a re-render; a click brings it back
await ev(`document.querySelector('#app .top [data-mode=edit]').click()`); await sleep(100); await ev(`document.querySelector('#app .top [data-mode=read]').click()`); await sleep(150);
report.legendPersist = await ev(`document.querySelector('#app .doc .sqllegend').classList.contains('off')`);
await ev(`document.querySelector('#app .doc .sqllegend').click()`); await sleep(100);
report.legendBack = await ev(`({off:document.querySelector('#app .doc .sqllegend').classList.contains('off'), stored:localStorage.getItem('mdr-sql-legend')})`);
// Format: the toolbar button is shown for SQL; clicking re-indents without changing a single token; idempotent; the tab is dirty
report.fmtBefore = await ev(`({shown:getComputedStyle(document.querySelector('#app .top button.fmt')).display, title:document.querySelector('#app .top button.fmt').title, lines:document.querySelector('#app textarea.src').value.split('\\n').length})`);
await ev(`document.querySelector('#app .top button.fmt').click()`); await sleep(300);
report.fmt = await ev(`(()=>{const t=document.querySelector('#app textarea.src').value; const L=t.split('\\n');
  return {text:t, lines:L.length, dirty:document.querySelector('#app .tabs .tab.on').classList.contains('dirty')||/\\*$/.test(document.querySelector('#app .tabs .tab.on .name').textContent)||!!document.querySelector('#app .tabs .tab.on .dot'),
    l:[L[0], L[6], L[7], L[10], L[11], L[12]], and:L.filter(x=>/^\\s+and /.test(x)).length, cteOpen:L.filter(x=>/^\\w+ as \\($/.test(x)).length, cteClose:L.filter(x=>/^\\),?$/.test(x)).length, trailing:L.find(x=>/last_repair_role,  -- 'broken'/.test(x))||'', comments:L.filter(x=>/--/.test(x)).length, secs:document.querySelectorAll('#app .sec').length, kind:document.querySelector('#app').dataset.kind, flash:document.querySelector('#app .flash,#app .toast')?.textContent||''};})()`);
await ev(`document.querySelector('#app .top button.fmt').click()`); await sleep(200);
report.fmtAgain = await ev(`document.querySelector('#app textarea.src').value.split('\\n').length`);
// token invariant + idempotence, checked with the shared core loaded in node (the viewer's SQLV lives in the content-script world)
globalThis.window = globalThis; globalThis.document = { createElement: () => ({}), createTextNode: () => ({}) };
await import(path.join(root, 'core/sql.js'));
{ const toks = (s) => SQLV.parse(s).toks.filter((k) => k.t !== 'ws').map((k) => k.v); const a = toks(sql), b = toks(report.fmt.text);
  report.fmt.same = a.length === b.length && a.every((v, i) => v === b[i]); report.fmt.ntok = a.length; report.fmt.idem = SQLV.format(report.fmt.text) === report.fmt.text; delete report.fmt.text; }
await theme('mono'); await shot('sql-format-mono.png');
// a markdown paste with a leading "Select" sentence is NOT SQL
await ev(`dispatchEvent(new KeyboardEvent('keydown',{key:'t',metaKey:true,bubbles:true}))`); await sleep(200);
await ev(`(()=>{const ta=document.querySelector('#app textarea.src'); ta.value='Select the file from the list.\\n\\nThen set it as default.'; ta.dispatchEvent(new Event('input',{bubbles:true}));})()`); await sleep(100);
await ev(`document.querySelector('#app .top [data-mode=read]').click()`); await sleep(150);
report.mdKind = await ev(`document.querySelector('#app').dataset.kind`);
// a single statement renders in the head, no sections
await ev(`document.querySelector('#app .top [data-mode=edit]').click()`); await sleep(100);
await ev(`(()=>{const ta=document.querySelector('#app textarea.src'); ta.value='-- how many parts per state\\nselect s.state, count(*) as n\\nfrom parts p left join part_state s on p.state_id = s.id\\ngroup by 1 order by n desc limit 20;'; ta.dispatchEvent(new Event('input',{bubbles:true}));})()`); await sleep(100);
await ev(`document.querySelector('#app .top [data-mode=read]').click()`); await sleep(150);
report.single = await ev(`({kind:document.querySelector('#app').dataset.kind, secs:document.querySelectorAll('#app .sec').length, h2:document.querySelector('#app .doc .head h2 .t')?.textContent, rows:[...document.querySelectorAll('#app .doc .head .sqlsum .sr')].map(r=>r.querySelector('.sl').textContent+' | '+r.querySelector('.sv').textContent.replace(/\\s+/g,' ').trim()), nums:document.querySelector('#app .doc .head .codeblock').classList.contains('numbered')})`);

const r = report;
const row = (rows, label) => rows.find((x) => x.startsWith(label)) || '';
report.sqlOk = !!(r.mounted && r.kind === 'sql' && r.doc.tab === 'Untitled 1' && r.doc.secs === 5 && r.doc.titles.length === 5
  && r.doc.titles[0].startsWith('Q0a. Which part types are switches?') && r.doc.titles[4].startsWith('Q3. The extract') && r.doc.toc.length === 5
  && r.doc.header.length === 4 && r.doc.header[0].startsWith('Mobility (Caspian Redshift)') && /5 statements · 74 lines · 7 tables · 3 named sets/.test(r.doc.meta)
  && r.doc.copyBtn === 'Copy SQL' && !r.doc.editBtn && /5 statements · 7 tables · 3 named sets/.test(r.doc.outlineMeta)
  // Q0a
  && r.q0a.rows.length === 5 && row(r.q0a.rows, 'Looks at') === 'Looks at | infrabi_stg.o_infr_dly_part (p), infrabi_stg.o_infr_part_model (m) and infrabi_stg.o_infr_part_type (t), matched row by row'
  && row(r.q0a.rows, 'Only rows where') === 'Only rows where | p.snapshot_day = current_date - 2' && row(r.q0a.rows, 'One row per') === 'One row per | part_type_id and type_name combination'
  && row(r.q0a.rows, 'Gives back') === 'Gives back | part_type_id, type_name, parts(count) — 3 columns' && row(r.q0a.rows, 'Sorted by') === 'Sorted by | parts, highest first'
  && r.q0a.defs.join() === 'p:tk-h0,m:tk-h1,t:tk-h2' && r.q0a.refs.length === 7 && r.q0a.refs.every((x) => ({ p: 'tk-h0', m: 'tk-h1', t: 'tk-h2' })[x.split(':')[0]] === x.split(':')[1])
  && r.q0a.bgDistinct === 3 && r.q0a.roles.join() === 'output,source,source,source,filter,shape,shape' && r.q0a.barColors === 4
  && r.q0a.kw.length >= 7 && new Set(r.q0a.kw.map((k) => k.split('=')[1])).size === 4 && r.q0a.tbl.length === 6 && r.q0a.out.join() === 'parts'
  && r.q0a.stamps.join() === '6,7,8,9,10,11,12' && r.q0a.block.join('|') === '6|13|counter-reset:ln 6' && r.q0a.lc === 'lines 7–13'
  && r.q0a.text.startsWith('select t.part_type_id') && r.q0a.text.endsWith('order by parts desc;')
  // Q2
  && r.q2.comments.join() === '-- tighten to the exact names from Q0a' && r.q2.colors.length === 1 && r.q2.colors[0] !== r.q2.body && r.q2.colors[0] !== 'rgb(138, 143, 150)' && +r.q2.marker < 0.6
  && r.q2.keeps === "p.snapshot_day = current_date - 2 and upper(t.type_name) like '%SWITCH%'"
  // Q3
  && row(r.q3.rows, 'First builds') === 'First builds | sw, ev and last_ev — named sets the final query uses below' && row(r.q3.rows, 'Looks at') === 'Looks at | sw plus any matching last_ev (e)'
  && row(r.q3.rows, 'Gives back') === 'Gives back | all columns of sw, repair_count, last_repair_id, last_repair_role, last_repair_asset_id, last_repair_at — 6 columns'
  && !row(r.q3.rows, 'Only rows') && r.q3.ctes.join() === 'sw:tk-h0,ev:tk-h6,last_ev:tk-h7' && r.q3.cteRefs.join() === 'ev:tk-h6,sw:tk-h0,sw:tk-h0,sw:tk-h0,last_ev:tk-h7,sw:tk-h0'
  && r.q3.hueCount === 9 && r.q3.eRefs.length === 1 && r.q3.tips[0].startsWith('reads infrabi_stg.o_infr_dly_part (p)') && r.q3.tips[1].includes('union all of 2 queries') && r.q3.tips[2] === 'reads ev · 1 condition · 7 columns'
  && r.q3.roles[0] === 'define' && r.q3.roles[1] === 'note' && r.q3.roles[2] === 'output' && r.q3.roles[15] === 'combine' && r.q3.desc.includes('Export the result to CSV') && r.q3.aliasTip === 'p = infrabi_stg.o_infr_dly_part'
  && r.studio.kw !== r.studio.al && r.studio.cm !== 'rgb(111, 123, 138)'
  && r.split.stamped === 58 && r.split.firstLine === '6' && r.split.lastLine === '73' && r.split.srcLines === 74
  // legend: roles in use only, colours match the keywords, above the first statement, hide (remembered across a re-render) / restore
  && r.legend.count === 1 && r.legend.items.map((i) => i.role).join() === 'define,source,filter,shape,output,combine,note,alias,named set' && r.legend.match && r.legend.above && r.legend.h < 120
  && r.legend.items.find((i) => i.role === 'shape').words === 'GROUP · ORDER · PARTITION' && r.legend.alias === 'tk-al tk-h0'
  && r.legendOff.off && r.legendOff.h < 40 && r.legendOff.w < 260 && r.legendOff.stored === 'off' && r.legendOff.dots.every((d) => d === '50%') && r.legendPersist && !r.legendBack.off && r.legendBack.stored === null
  // Format: button shown for SQL, whitespace-only (same 486 tokens), idempotent, comments kept, one column per line, AND one level in, CTE bodies indented
  && r.fmtBefore.shown !== 'none' && /Re-indent SQL/.test(r.fmtBefore.title) && r.fmtBefore.lines === 74
  && r.fmt.same && r.fmt.ntok === 486 && r.fmt.idem && r.fmt.lines === 113 && r.fmtAgain === 113 && r.fmt.dirty && r.fmt.kind === 'sql' && r.fmt.secs === 5 && r.fmt.flash === 'Re-indented'
  && r.fmt.l.join('\n') === '-- Mobility (Caspian Redshift) switch queries for Switch Accuracy\nselect\n    t.part_type_id,\nfrom infrabi_stg.o_infr_dly_part p\njoin infrabi_stg.o_infr_part_model m on p.part_model_id = m.part_model_id\njoin infrabi_stg.o_infr_part_type t on m.part_type_id = t.part_type_id'
  && r.fmt.and === 3 && r.fmt.cteOpen === 2 && r.fmt.cteClose === 3 && r.fmt.trailing === "    e.role as last_repair_role,  -- 'broken' = this part was taken out" && r.fmt.comments === 15
  && r.mdKind === 'md'
  && r.single.kind === 'sql' && r.single.secs === 0 && r.single.h2 === 'how many parts per state' && r.single.rows.join(' / ') === 'Looks at | parts (p) plus any matching part_state (s) / One row per | state / Gives back | state, n(count) — 2 columns / Sorted by | n, highest first / Only the first | 20 rows' && r.single.nums);
console.log(JSON.stringify(report, null, 1));
killChrome();
process.exit(report.sqlOk ? 0 : 1);
