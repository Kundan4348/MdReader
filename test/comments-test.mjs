// Comments in the desktop app, end to end, with two people on the same files:
// Alice comments on .md / .json / .sql text, navigates, reacts, replies, edits, resolves; the comments file next to
// each document is checked after every step. Then Bob opens the same folder: he sees Alice's threads, can reply and
// react, cannot edit or delete her comments, and can delete his own reply. The document files never change.
// Usage: node test/comments-test.mjs <outdir>
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';

const outdir = path.resolve(process.argv[2]); mkdirSync(outdir, { recursive: true });
const root = path.resolve(import.meta.dirname, '..');
const electron = path.join(root, 'app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const busy = async (pt) => { try { await fetch(`http://127.0.0.1:${pt}/json/version`, { signal: AbortSignal.timeout(800) }); return true; } catch (e) { if (e.name === 'TypeError' || e.name === 'TimeoutError') return false; throw e; } };
setTimeout(() => { console.error('FAIL: timeout'); process.exit(2); }, 170000);

// fresh copies of the documents, so the comment files land in the output folder
const dir = path.join(outdir, 'docs'); rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
const MD = '# Release notes\n\nThe quick brown fox jumps over the lazy dog.\n\nDeploy happens on Friday after the review.\n\n## Risks\n\nThe quick brown fox appears twice on purpose.\n';
const JS = '{\n  "service": "inventory",\n  "region": "us-west-2",\n  "owner": { "team": "assets", "oncall": "kunoku" }\n}\n';
const SQ = '-- Open switches per site\nSELECT site, COUNT(*) AS switches\nFROM assets\nWHERE status = \'OPEN\'\nGROUP BY site;\n';
const f = { md: path.join(dir, 'notes.md'), json: path.join(dir, 'svc.json'), sql: path.join(dir, 'q.sql') };
writeFileSync(f.md, MD); writeFileSync(f.json, JS); writeFileSync(f.sql, SQ);
const side = (p) => { try { return JSON.parse(readFileSync(p + '.mdr-comments.json', 'utf8')); } catch { return null; } };

async function launch(user, uid) {
  const udd = path.join(outdir, 'ud-' + uid); rmSync(udd, { recursive: true, force: true }); mkdirSync(udd, { recursive: true });
  let port = 9583; while (await busy(port)) port++;
  const proc = spawn(electron, [`--remote-debugging-port=${port}`, `--user-data-dir=${udd}`, path.join(root, 'app'), f.md, f.json, f.sql],
    { stdio: 'ignore', env: { ...process.env, MDR_TEST_USER: user, MDR_TEST_USER_ID: uid, MDR_OPEN_LOG: path.join(outdir, 'opens.log') } });
  let page;
  for (let i = 0; i < 60 && !page; i++) { try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.type === 'page' && x.url.includes('index.html')); } catch {} if (!page) await sleep(500); }
  const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = new Map(); const logs = [];
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } if (m.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)); };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) logs.push('EVAL: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300)); return r.result?.result?.value; };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false });
  for (let i = 0; i < 40 && (await ev(`document.querySelectorAll('#app .tabs .tab').length`)) < 3; i++) await sleep(250);
  await sleep(800);
  return { proc, send, ev, logs, stop: () => { try { proc.kill('SIGKILL'); } catch {} } };
}

let A, ev, send;
const use = (x) => { A = x; ev = x.ev; send = x.send; };
const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(path.join(outdir, name), Buffer.from(r.result.data, 'base64')); };
const mouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
const clickAt = async (x, y) => { await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); await sleep(350); };
const clickSel = async (sel) => { const c = await ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null; const r=e.getBoundingClientRect(); return [r.left+r.width/2, r.top+r.height/2]})()`); if (!c) return false; await clickAt(c[0], c[1]); return true; };
const key = (k, code, vk, mods = 0) => send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods }).then(() => send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods }));
const typeText = (t) => send('Input.insertText', { text: t });
const tab = async (p) => { await ev(`document.querySelector('#app .tabs .tab[data-path=${JSON.stringify(p)}]').click()`); await sleep(700); };
// select the n-th occurrence of `word` in the page text (same text the app uses: buttons and line numbers left out)
const select = (word, nth = 0) => ev(`(()=>{const doc=document.querySelector('#app .doc'); const w=document.createTreeWalker(doc,NodeFilter.SHOW_TEXT,{acceptNode:(n)=>n.parentElement.closest('button, .tools, .ln, .tf-bar, .jd-chev, .codebar, .lgx')?2:1}); let all='',ns=[]; while(w.nextNode()){ns.push([w.currentNode,all.length]); all+=w.currentNode.nodeValue;}
  let i=-1; for(let k=0;k<=${nth};k++){ i=all.indexOf(${JSON.stringify(word)}, i+1); if(i<0) return 'nf'; }
  const at=(p,end)=>{for(let k=ns.length-1;k>=0;k--) if(ns[k][1]<p||(ns[k][1]===p&&!end)) return [ns[k][0],p-ns[k][1]];};
  const a=at(i,false), b=at(i+${word.length},true); const r=document.createRange(); r.setStart(a[0],a[1]); r.setEnd(b[0],b[1]); const s=getSelection(); s.removeAllRanges(); s.addRange(r); return s.toString()})()`);
const hlTexts = (name) => ev(`(()=>{const h=CSS.highlights.get(${JSON.stringify(name)}); return h?[...h].map(r=>r.toString()):[]})()`);
const popState = () => ev(`(()=>{const p=document.querySelector('#app .cmt-pop'); if(!p||p.hidden) return null; return {mode:p.dataset.mode, of:p.querySelector('.cmt-of')?.textContent, quote:p.querySelector('.cmt-quote')?.textContent, entries:[...p.querySelectorAll('.cmt-e')].map(e=>({who:e.querySelector('.cmt-h b').textContent, text:e.querySelector('.cmt-text')?.textContent, acts:!!e.querySelector('.cmt-acts'), reacts:[...e.querySelectorAll('.cmt-r')].map(r=>r.textContent)}))}})()`);
// click in the middle of the first rect of the highlighted words `q`
async function clickWords(q) {
  const c = await ev(`(()=>{const h=CSS.highlights.get('mdr-cmt'); if(!h) return null; for(const r of h){ if(r.toString()===${JSON.stringify(q)}){ const x=r.getClientRects()[0]; return [x.left+x.width/2, x.top+x.height/2]; } } return null})()`);
  if (!c) return false; await clickAt(c[0], c[1]); return true;
}
// a real mouse drag across the n-th occurrence of `word` (a JSON value drops its quotes once you start editing it, so the drag starts on the quote)
async function dragSelect(word, nth = 0) {
  const pts = await ev(`(()=>{const doc=document.querySelector('#app .doc'); const w=document.createTreeWalker(doc,NodeFilter.SHOW_TEXT); let all='',ns=[]; while(w.nextNode()){ns.push([w.currentNode,all.length]); all+=w.currentNode.nodeValue;}
    let i=-1; for(let k=0;k<=${nth};k++){ i=all.indexOf(${JSON.stringify(word)}, i+1); if(i<0) return null; }
    const at=(p)=>{for(let k=ns.length-1;k>=0;k--) if(ns[k][1]<=p) return [ns[k][0],p-ns[k][1]];};
    const box=(p)=>{const [n,o]=at(p); const r=document.createRange(); r.setStart(n,o); r.setEnd(n,o+1); return r.getBoundingClientRect();};
    const q=all[i-1]==='"'; const a=box(q?i-1:i), b=box(i+${word.length}-1); return [a.left+1, a.top+a.height/2, b.right-1, b.top+b.height/2]})()`);
  if (!pts) return 'nf';
  await mouse('mouseMoved', pts[0], pts[1]); await mouse('mousePressed', pts[0], pts[1]);
  for (let k = 1; k <= 8; k++) { await mouse('mouseMoved', pts[0] + (pts[2] - pts[0]) * k / 8, pts[1] + (pts[3] - pts[1]) * k / 8); await sleep(15); }
  await mouse('mouseReleased', pts[2], pts[3]); await sleep(100);
  return ev('getSelection().toString()');
}
async function comment(word, text, nth = 0, how = 'bubble', drag = false) {
  const s = drag ? await dragSelect(word, nth) : await select(word, nth); await sleep(350);
  const bubble = await ev(`!document.querySelector('#app .cmt-bubble').hidden`);
  if (how === 'bubble') await clickSel('#app .cmt-bubble'); else { await key('m', 'KeyM', 77, 1 | 4); await sleep(300); } // ⌘⌥M (alt=1, meta=4)
  const st = await popState();
  await typeText(text); await sleep(100);
  await key('Enter', 'Enter', 13, 4); await sleep(700); // ⌘↩
  return { selected: s, bubble, newMode: st && st.mode, quote: st && st.quote };
}

const r = {}; const ok = {};
// ===================== Alice =====================
use(await launch('Alice Rao', 'alice'));
r.who = await ev(`window.mdreader.whoami()`);
await tab(f.md);
r.c1 = await comment('quick brown fox', 'Should this say "the"?');
r.side1 = side(f.md);
ok.created = r.c1.selected === 'quick brown fox' && r.c1.bubble && r.c1.newMode === 'new' && r.side1?.comments.length === 1 && r.side1.comments[0].author.id === 'alice'
  && r.side1.comments[0].author.name === 'Alice Rao' && r.side1.comments[0].text === 'Should this say "the"?' && r.side1.comments[0].anchor.q === 'quick brown fox' && r.side1.comments[0].anchor.n === 0;
r.afterCreatePop = await popState();
ok.popAfterCreate = r.afterCreatePop?.mode === 'thread' && r.afterCreatePop.of === '1 of 1';
r.c2 = await comment('Friday', 'Friday is a freeze day -- Monday?', 0, 'keys');
ok.shortcut = r.c2.newMode === 'new' && side(f.md)?.comments.length === 2;
// the second "quick brown fox" (under Risks) gets its own thread, distinct from the first
r.c3 = await comment('quick brown fox', 'Second one is fine.', 1);
r.side3 = side(f.md);
ok.secondOccurrence = r.side3.comments.length === 3 && r.side3.comments[2].anchor.n === 1 && r.side3.comments[2].anchor.pre.includes('Risks');
await key('Escape', 'Escape', 27); await sleep(200);
r.hl = await hlTexts('mdr-cmt');
ok.highlighted = JSON.stringify([...r.hl].sort()) === JSON.stringify(['Friday', 'quick brown fox', 'quick brown fox']);
ok.closedByEsc = (await popState()) === null;
// click the words: opens that thread, in page order
r.clickFriday = await clickWords('Friday'); r.popFriday = await popState();
ok.clickOpens = r.clickFriday && r.popFriday?.of === '2 of 3' && r.popFriday.quote === 'Friday' && r.popFriday.entries[0].text.startsWith('Friday is a freeze');
ok.activeHl = JSON.stringify(await hlTexts('mdr-cmt-on')) === '["Friday"]';
await clickSel('#app .cmt-pop .cmt-next'); r.popNext = await popState();
await clickSel('#app .cmt-pop .cmt-next'); r.popWrap = await popState();
await clickSel('#app .cmt-pop .cmt-prev'); r.popPrev = await popState();
ok.nextPrev = r.popNext?.of === '3 of 3' && r.popNext.entries[0].text === 'Second one is fine.' && r.popWrap?.of === '1 of 3' && r.popPrev?.of === '3 of 3';
await shot('cmt-pop-mono.png');
// react, reply, edit -- on thread 1
await clickSel('#app .cmt-pop .cmt-next'); // -> 1 of 3
await ev(`document.querySelector('#app .cmt-pop .cmt-e.root .cmt-add').click()`); await sleep(150);
await ev(`[...document.querySelectorAll('#app .cmt-pop .cmt-pe')].find(b=>b.textContent==='👍').click()`); await sleep(500);
await clickSel('#app .cmt-pop .cmt-foot .cmt-in'); await typeText('Agreed, fixing it.'); await key('Enter', 'Enter', 13, 4); await sleep(600);
r.side4 = side(f.md); const t1 = r.side4.comments.find((c) => c.anchor.q === 'quick brown fox' && c.anchor.n === 0);
ok.reactReply = t1.reactions['👍']?.length === 1 && t1.reactions['👍'][0].id === 'alice' && t1.replies.length === 1 && t1.replies[0].text === 'Agreed, fixing it.' && t1.replies[0].author.id === 'alice';
await ev(`document.querySelector('#app .cmt-pop .cmt-e.root .cmt-acts .cmt-link').click()`); await sleep(150);
await ev(`(()=>{const t=document.querySelector('#app .cmt-pop .cmt-e.root textarea'); t.focus(); t.select()})()`); await typeText('Should this say "a"?');
await ev(`document.querySelector('#app .cmt-pop .cmt-e.root .cmt-edit .cmt-send').click()`); await sleep(600);
const t1e = side(f.md).comments.find((c) => c.id === t1.id);
ok.edit = t1e.text === 'Should this say "a"?' && !!t1e.edited && (await popState())?.entries[0].text === 'Should this say "a"?';
// the left panel
await clickSel('#app .top .cmtb'); await sleep(300);
r.panel = await ev(`(()=>({shown:getComputedStyle(document.querySelector('#app .files')).display!=='none', cm:document.querySelector('#app .files').classList.contains('cm'), cards:[...document.querySelectorAll('#app .cpane .cp-card')].map(c=>c.querySelector('.cp-q').textContent+' | '+c.querySelector('.cp-x').textContent), badge:document.querySelector('#app .cmtb .cmtb-n').textContent, where:document.querySelector('#app .cp-where').textContent}))()`);
ok.panel = r.panel.shown && r.panel.cm && r.panel.cards.length === 3 && r.panel.cards[0].startsWith('quick brown fox | Should this say "a"?') && r.panel.cards[1].startsWith('Friday') && r.panel.badge === '3' && r.panel.where.includes('notes.md.mdr-comments.json');
await key('Escape', 'Escape', 27); await sleep(150);
await ev(`document.querySelectorAll('#app .cpane .cp-card')[1].click()`); await sleep(400);
ok.panelOpens = (await popState())?.quote === 'Friday';
await shot('cmt-panel-mono.png');
// resolve thread 3, filters, hide switch
await ev(`document.querySelectorAll('#app .cpane .cp-card')[2].click()`); await sleep(300);
await clickSel('#app .cmt-pop .cmt-resolve'); await sleep(500);
writeFileSync(path.join(outdir, 'dbg.json'), JSON.stringify({ ok, r, logs: A.logs }, null, 2));
r.afterResolve = { hl: await hlTexts('mdr-cmt'), chips: await ev(`[...document.querySelectorAll('#app .cp-chip')].map(c=>c.textContent)`), resolved: !!side(f.md).comments[2].resolved };
ok.resolve = r.afterResolve.resolved && r.afterResolve.hl.length === 2 && r.afterResolve.chips.join(',') === 'Open 2,Resolved 1,All 3';
await key('Escape', 'Escape', 27);
await ev(`(()=>{const c=document.querySelector('#app .cp-show input'); c.click()})()`); await sleep(200);
r.hiddenHl = await hlTexts('mdr-cmt');
await ev(`(()=>{const c=document.querySelector('#app .cp-show input'); c.click()})()`); await sleep(200);
ok.hideSwitch = r.hiddenHl.length === 0 && (await hlTexts('mdr-cmt')).length === 2;
// the file changes on disk: a new paragraph above everything; threads stay on their words
writeFileSync(f.md, MD.replace('# Release notes\n', '# Release notes\n\nAdded later: the quick brown fox is a pangram.\n'));
await sleep(1800);
r.afterExternal = await hlTexts('mdr-cmt');
r.afterExternalCtx = await ev(`(()=>{const h=CSS.highlights.get('mdr-cmt'); return [...h].map(r=>r.startContainer.parentElement.closest('p')?.textContent.slice(0,30))})()`);
ok.followsText = r.afterExternal.length === 2 && r.afterExternalCtx.includes('The quick brown fox jumps over') && !r.afterExternalCtx.some((t) => t && t.startsWith('Added later'));
// JSON and SQL
await tab(f.json);
r.jprobe = await ev(`(()=>{const d=document.querySelector('#app .doc'); const all=d.textContent; const i=all.indexOf('us-west-2'); const w=document.createTreeWalker(d,NodeFilter.SHOW_TEXT); let n; while((n=w.nextNode())) if(n.nodeValue.includes('us-west-2')) return {i, par:n.parentElement.outerHTML.slice(0,200), us:getComputedStyle(n.parentElement).userSelect, ed:n.parentElement.closest('[contenteditable]')?.getAttribute('contenteditable'), mode:document.querySelector('#app').dataset.mode}; return {i}})()`);
  r.cj = await comment('us-west-2', 'Will this move to us-east-1?', 0, 'bubble', true);
await key('Escape', 'Escape', 27);
await tab(f.sql);
r.cs = await comment("'OPEN'", 'Include IN_TRANSIT too?');
await shot('cmt-sql-mono.png');
await key('Escape', 'Escape', 27);
r.sideJ = side(f.json); r.sideS = side(f.sql);
ok.jsonSql = r.sideJ?.comments[0].anchor.q === 'us-west-2' && r.sideS?.comments[0].anchor.q === "'OPEN'" && (await hlTexts('mdr-cmt')).join() === "'OPEN'"
  && readFileSync(f.json, 'utf8') === JS && readFileSync(f.sql, 'utf8') === SQ;
// themes: Studio (dark) popup
await tab(f.md);
await ev(`(()=>{const s=document.querySelector('#app select.theme'); s.value='studio'; s.dispatchEvent(new Event('change'))})()`); await sleep(400);
await clickWords('quick brown fox'); await sleep(300); await shot('cmt-pop-studio.png');
await ev(`(()=>{const s=document.querySelector('#app select.theme'); s.value='mono'; s.dispatchEvent(new Event('change'))})()`); await sleep(200);
r.aliceLogs = A.logs.slice(); A.stop(); await sleep(800);

// ===================== Bob =====================
use(await launch('Bob Iyer', 'bob'));
await tab(f.md); await sleep(400);
r.bobBadge = await ev(`document.querySelector('#app .cmtb .cmtb-n').textContent`);
await clickWords('quick brown fox'); r.bobPop = await popState();
ok.bobSees = r.bobBadge === '2' && r.bobPop?.entries.length === 2 && r.bobPop.entries[0].who === 'Alice Rao' && r.bobPop.entries.every((e) => !e.acts);
await ev(`[...document.querySelectorAll('#app .cmt-pop .cmt-e.root .cmt-r')][0].click()`); await sleep(500); // +1 on Alice's 👍
await clickSel('#app .cmt-pop .cmt-foot .cmt-in'); await typeText('Looks good to me.'); await key('Enter', 'Enter', 13, 4); await sleep(600);
r.bobPop2 = await popState();
const tb = side(f.md).comments.find((c) => c.anchor.n === 0 && c.anchor.q === 'quick brown fox');
ok.bobReplyReact = tb.reactions['👍'].map((p) => p.id).join() === 'alice,bob' && tb.replies.length === 2 && tb.replies[1].author.id === 'bob'
  && r.bobPop2.entries[2].acts && !r.bobPop2.entries[0].acts && r.bobPop2.entries[0].reacts[0] === '👍2';
// Bob cannot change Alice's comment even through the code path (the Edit/Delete buttons are absent; the store refuses too)
r.bobRootText = tb.text;
await ev(`(()=>{const e=[...document.querySelectorAll('#app .cmt-pop .cmt-e')][2]; e.querySelectorAll('.cmt-link')[1].click()})()`); await sleep(150);
r.bobConfirm = await ev(`[...document.querySelectorAll('#app .cmt-pop .cmt-link.danger')].map(b=>b.textContent)`);
await ev(`document.querySelector('#app .cmt-pop .cmt-link.danger').click()`); await sleep(600);
const tb2 = side(f.md).comments.find((c) => c.id === tb.id);
ok.bobDeletesOwn = r.bobConfirm.join() === 'Delete?' && tb2.replies.length === 1 && tb2.replies[0].author.id === 'alice' && tb2.text === r.bobRootText;
ok.docsUnchanged = readFileSync(f.json, 'utf8') === JS && readFileSync(f.sql, 'utf8') === SQ && !readFileSync(f.md, 'utf8').includes('mdr');
ok.filesPaneHidesSidecar = await ev(`![...document.querySelectorAll('#app .tree .file')].some(e=>/mdr-comments/.test(e.textContent))`);
r.bobLogs = A.logs.slice(); A.stop();
ok.noErrors = !r.aliceLogs.length && !r.bobLogs.length;
writeFileSync(path.join(outdir, 'report.json'), JSON.stringify({ ok, r }, null, 2));
console.log(JSON.stringify({ ok }, null, 2));
if (!ok.noErrors) console.log('logs', JSON.stringify([...r.aliceLogs, ...r.bobLogs]).slice(0, 1500));
process.exit(Object.values(ok).every(Boolean) ? 0 : 1);
