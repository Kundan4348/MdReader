// Write mode: table rows / columns menu, multi-row and multi-block delete, structural undo (extension host, same core as the app).
// Usage: node test/table-test.mjs <base-url> <outdir>   -- base-url serves the repo root
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
const SRC = () => ev(`document.querySelector('#app textarea.src').value`);
const ORIG = readFileSync(path.join(root, 'test/fixtures/table.md'), 'utf8');
const shotF = async (n) => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(path.join(outdir, n), Buffer.from(r.result.data, 'base64')); };
// put the caret right after `needle` inside the element matched by `sel` (text nodes concatenated, so highlighted code works)
const caretAfter = (sel, needle, selectIt = false) => ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)}); const host=el.closest('[contenteditable=true],[contenteditable=plaintext-only]')||el; host.focus();
  const w=document.createTreeWalker(el,NodeFilter.SHOW_TEXT); const ns=[];let all='';while(w.nextNode()){ns.push([w.currentNode,all.length]);all+=w.currentNode.nodeValue;}
  const i=all.lastIndexOf(${JSON.stringify(needle)}); if(i<0) return 'nf:'+all; const at=(p)=>{for(let k=ns.length-1;k>=0;k--) if(ns[k][1]<=p) return [ns[k][0],p-ns[k][1]];};
  const e=at(i+${needle.length}); const r=document.createRange(); if(${selectIt}){const s=at(i); r.setStart(s[0],s[1]);} else r.setStart(e[0],e[1]); r.setEnd(e[0],e[1]);
  const s=getSelection(); s.removeAllRanges(); s.addRange(r); return 'ok'})()`);
const typeText = (t) => send('Input.insertText', { text: t });
const key = (k, code, vk, mods = 0) => send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods }).then(() => send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods }));
const enter = () => key('Enter', 'Enter', 13);
const blur = () => ev(`document.activeElement && document.activeElement.blur()`);

report.mounted = await mount(base + '/test/fixtures/table.md'); await sleep(800); // the shell's init (prefs) finishes after first paint
// J. colour: status chips + numeric bars on a fresh Read of the full fixture (before any Write edits)
report.colour = await ev(`(()=>{const a=document.querySelector('#app');
  const chips=[...a.querySelectorAll('.doc td .stc')].length;
  const states=[...new Set([...a.querySelectorAll('.doc td[data-st]')].map(td=>td.dataset.st))].sort();
  const bars=[...a.querySelectorAll('.doc td.bar')].length;
  const maxBar=[...a.querySelectorAll('.doc td.bar')].map(td=>+td.style.getPropertyValue('--bar')).sort((x,y)=>y-x)[0];
  return {chips, states, bars, maxBar}})()`);
await ev(`document.querySelector('#app .top [data-mode=write]').click()`); await sleep(400);
const T = async () => { const l = (await SRC()).split('\n'); const i = l.findIndex((x) => x.startsWith('| Name')); return i < 0 ? [] : l.slice(i, l.findIndex((x, j) => j > i && !x.startsWith('|')) >>> 0 || undefined); };
const tdWith = (t) => `[...document.querySelectorAll('#app .table-wrap td')].find(x=>x.textContent.trim()===${JSON.stringify(t)})`;
const caretIn = (t) => ev(`(()=>{const c=${tdWith(t)}; document.querySelector('#app .doc').focus(); const r=document.createRange(); r.selectNodeContents(c); r.collapse(false); const s=getSelection(); s.removeAllRanges(); s.addRange(r); return !!c})()`);
const rclick = (t) => ev(`(()=>{const c=${tdWith(t)}; const b=c.getBoundingClientRect(); c.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:b.left+5,clientY:b.top+5})); return !document.querySelector('#app .wmenu').hidden})()`);
const menuClick = (label) => ev(`(()=>{const b=[...document.querySelectorAll('#app .wmenu button')].find(x=>(x.title||x.textContent).startsWith(${JSON.stringify(label)})); if(!b) return false; b.click(); return true})()`);
const bar = (act) => ev(`document.querySelector('#app .wbar [data-act=${act}]').click()`);
const caretRow = () => ev(`(()=>{const a=getSelection().anchorNode; const c=(a.nodeType===1?a:a.parentElement).closest('td,th'); if(!c) return null; const rows=[...c.closest('table').querySelectorAll('thead>tr:not(.filters),tbody>tr')]; return [rows.indexOf(c.parentElement),[...c.parentElement.children].indexOf(c)]})()`);
const S1 = {};
const TB = async () => { const l = (await SRC()).split('\n'); const i = l.findIndex((x) => x.startsWith('|')); if (i < 0) return []; const out = []; for (let j = i; j < l.length && l[j].startsWith('|'); j++) out.push(l[j]); return out; };
// A. right-click a cell -> Insert row below; type into it
S1.menuShown = await rclick('beta'); await shotF('table-menu.png');
S1.ins = await menuClick('Insert row below'); await sleep(400);
S1.insCaret = await caretRow();
await typeText('eps'); await sleep(700);
S1.afterIns = await TB();
// B. delete a row twice in a row (the reported bug)
await caretIn('alpha'); await bar('delRows'); await sleep(400);
await caretIn('gamma'); await bar('delRows'); await sleep(400);
S1.afterDel2 = await TB();
// C. select from the start of "beta" to the end of the "eps" row, Backspace: both rows go
S1.selC = await ev(`(()=>{const a=${tdWith('beta')}, tr=${tdWith('eps')}.parentElement, z=tr.lastElementChild; document.querySelector('#app .doc').focus(); const r=document.createRange(); r.setStart(a.firstChild,0); r.setEnd(z,z.childNodes.length); const s=getSelection(); s.removeAllRanges(); s.addRange(r); return s.toString()})()`);
await key('Backspace', 'Backspace', 8); await sleep(400);
S1.afterMulti = await TB();
// D. undo / redo
await key('z', 'KeyZ', 90, 4); await sleep(400); S1.undone = await TB();
await key('z', 'KeyZ', 90, 4 | 8); await sleep(400); S1.redone = await TB();
// E. columns: insert right of Count, type, centre it, delete Note
await rclick('40'); await menuClick('Insert column right'); await sleep(400);
S1.colCaret = await caretRow(); await typeText('x1'); await sleep(700);
S1.afterCol = await TB();
await caretIn('x1'); await rclick('x1'); await menuClick('Align centre'); await sleep(400);
S1.afterAlign = await TB();
await rclick('d'); await menuClick('Delete column'); await sleep(400);
S1.afterDelCol = await TB();
// F. sort by Count, high first; move a row up; Tab in the last cell adds a row
await rclick('40'); await menuClick('Sort by this column, Z'); await sleep(400);
S1.afterSort = await TB();
await rclick('eta'); await menuClick('Move up'); await sleep(400);
S1.afterMove = await TB();
await caretIn('15'); await key('Tab', 'Tab', 9); await sleep(100);
S1.tabFirst = await caretRow(); // Tab moved one cell right (the last cell of the last row)
await key('Tab', 'Tab', 9); await sleep(400);
S1.tabCaret = await caretRow(); await typeText('omega'); await sleep(700);
S1.afterTab = await TB();
S1.logsMid = logs.length;
// F2. drag the "omega" row above "delta" by its grip
const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
const rect = (js) => ev(`(()=>{const r=(${js}).getBoundingClientRect(); return [r.left,r.top,r.width,r.height]})()`);
const om = await rect(tdWith('omega'));
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: om[0] + 10, y: om[1] + om[3] / 2 }); await sleep(150);
S1.gripShown = await ev(`!document.querySelector('#app .wdrag').hidden`);
const g = await rect(`document.querySelector('#app .wdrag')`);
const de = await rect(tdWith('delta'));
await mouse('mousePressed', g[0] + 9, g[1] + 11); await sleep(100);
await mouse('mouseMoved', g[0] + 9, de[1] + 6); await sleep(150);
S1.dropShown = await ev(`!document.querySelector('#app .wdrop').hidden`);
await shotF('table-drag.png');
await mouse('mouseReleased', g[0] + 9, de[1] + 6); await sleep(500);
S1.afterDrag = await TB();
// F3. header toggle: header -> normal row, then back
const thWith = (t) => `[...document.querySelectorAll('#app .table-wrap th')].find(x=>x.textContent.trim()===${JSON.stringify(t)})`;
await ev(`(()=>{const c=${thWith('Name')}; document.querySelector('#app .doc').focus(); const r=document.createRange(); r.selectNodeContents(c); r.collapse(false); const s=getSelection(); s.removeAllRanges(); s.addRange(r)})()`); await sleep(100);
S1.hdrOn = await ev(`document.querySelector('#app .wbar [data-act=hdr]').classList.contains('on')`);
await bar('hdr'); await sleep(400);
S1.afterUnhead = await TB();
await caretIn('Name'); await bar('hdr'); await sleep(400);
S1.afterRehead = await TB();
await rclick('eta'); await menuClick('Make this the header row'); await sleep(400);
S1.afterEtaHead = await TB();
await key('z', 'KeyZ', 90, 4); await sleep(400);
S1.afterEtaUndo = await TB();
// F4. drag the "Count" column left of "Name" by its grip
const colGrip = async (headerText) => {
  const hr = await rect(thWith(headerText));
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hr[0] + hr[2] / 2, y: hr[1] + hr[3] / 2 }); await sleep(150);
  return ev(`!document.querySelector('#app .wdrag.col').hidden`);
};
S1.cgripShown = await colGrip('Count');
const cg = await rect(`document.querySelector('#app .wdrag.col')`);
const nameH = await rect(thWith('Name'));
await mouse('mousePressed', cg[0] + 11, cg[1] + 8); await sleep(100);
await mouse('mouseMoved', nameH[0] + 2, cg[1] + 8); await sleep(150);
S1.cdropShown = await ev(`!document.querySelector('#app .wdrop.v').hidden`);
await mouse('mouseReleased', nameH[0] + 2, cg[1] + 8); await sleep(500);
S1.afterColDrag = await TB();

// G. Backspace at the start of a paragraph joins it to the one above
await caretAfter('#app .sec:last-of-type .body > p:last-of-type', 'T', true); await ev(`(()=>{const s=getSelection(); s.collapseToStart()})()`);
await key('Backspace', 'Backspace', 8); await sleep(400);
S1.joined = (await SRC()).split('\n').find((l) => l.startsWith('Second'));
S1.joinCaret = await ev(`(()=>{const s=getSelection(); const t=s.anchorNode.nodeValue||''; return t.slice(0,s.anchorOffset).slice(-5)+'|'+t.slice(s.anchorOffset,s.anchorOffset+5)})()`);
// H. a selection across sections, typed over: everything between goes, the two halves join
S1.selH = await ev(`(()=>{const tn=(sel,needle)=>{const el=document.querySelector(sel); const w=document.createTreeWalker(el,NodeFilter.SHOW_TEXT); while(w.nextNode()){const i=w.currentNode.nodeValue.indexOf(needle); if(i>=0) return [w.currentNode,i+needle.length];}};
  const a=tn('#app .head > p, #app .sec .body > p','Intro '), z=tn('#app .sec:last-of-type .body > p','Second '); document.querySelector('#app .doc').focus(); const r=document.createRange(); r.setStart(a[0],a[1]); r.setEnd(z[0],z[1]); const s=getSelection(); s.removeAllRanges(); s.addRange(r); return s.toString().length})()`);
await typeText('X'); await sleep(500);
S1.crossSrc = await SRC();
S1.crossCaret = await ev(`(()=>{const s=getSelection(); const t=s.anchorNode.nodeValue||''; return t.slice(0,s.anchorOffset).slice(-7)+'|'+t.slice(s.anchorOffset,s.anchorOffset+4)})()`);
// I. insert a new table after the paragraph, type over its first header
await bar('table'); await sleep(400);
S1.newSel = await ev(`getSelection().toString()`);
await typeText('Key'); await sleep(700); await blur(); await sleep(300);
S1.final = await SRC();
await shotF('table-final.png');
const J = (a) => a.join('\n');
const E = {
  afterIns: J(['| Name | Count | Note |', '|:-----|------:|------|', '| alpha | 10 | a |', '| beta | 20 | b |', '| eps |   |   |', '| gamma | 3 | c |', '| delta | 40 | d |', '| eta | 7 | e |', '| theta | 15 | f |']),
  afterDel2: J(['| Name | Count | Note |', '|:-----|------:|------|', '| beta | 20 | b |', '| eps |   |   |', '| delta | 40 | d |', '| eta | 7 | e |', '| theta | 15 | f |']),
  afterMulti: J(['| Name | Count | Note |', '|:-----|------:|------|', '| delta | 40 | d |', '| eta | 7 | e |', '| theta | 15 | f |']),
  afterCol: J(['| Name | Count |  | Note |', '| :--- | ---: | --- | --- |', '| delta | 40 | x1 | d |', '| eta | 7 |  | e |', '| theta | 15 |  | f |']),
  afterAlign: J(['| Name | Count |  | Note |', '| :--- | ---: | :---: | --- |', '| delta | 40 | x1 | d |', '| eta | 7 |  | e |', '| theta | 15 |  | f |']),
  afterDelCol: J(['| Name | Count |  |', '| :--- | ---: | :---: |', '| delta | 40 | x1 |', '| eta | 7 |  |', '| theta | 15 |  |']),
  afterSort: J(['| Name | Count |  |', '| :--- | ---: | :---: |', '| delta | 40 | x1 |', '| theta | 15 |  |', '| eta | 7 |  |']),
  afterMove: J(['| Name | Count |  |', '| :--- | ---: | :---: |', '| delta | 40 | x1 |', '| eta | 7 |  |', '| theta | 15 |  |']),
  afterTab: J(['| Name | Count |  |', '| :--- | ---: | :---: |', '| delta | 40 | x1 |', '| eta | 7 |  |', '| theta | 15 |  |', '| omega |   |   |']),
  afterDrag: J(['| Name | Count |  |', '| :--- | ---: | :---: |', '| omega |   |   |', '| delta | 40 | x1 |', '| eta | 7 |  |', '| theta | 15 |  |']),
  afterUnhead: J(['|  |  |  |', '| :--- | ---: | :---: |', '| Name | Count |  |', '| omega |   |   |', '| delta | 40 | x1 |', '| eta | 7 |  |', '| theta | 15 |  |']),
  afterRehead: J(['| Name | Count |  |', '| :--- | ---: | :---: |', '| omega |   |   |', '| delta | 40 | x1 |', '| eta | 7 |  |', '| theta | 15 |  |']),
  afterEtaHead: J(['| eta | 7 |  |', '| :--- | ---: | :---: |', '| Name | Count |  |', '| omega |   |   |', '| delta | 40 | x1 |', '| theta | 15 |  |']),
  afterEtaUndo: J(['| Name | Count |  |', '| :--- | ---: | :---: |', '| omega |   |   |', '| delta | 40 | x1 |', '| eta | 7 |  |', '| theta | 15 |  |']),
  afterColDrag: J(['| Count | Name |  |', '| ---: | :--- | :---: |', '|  | omega |  |', '| 40 | delta | x1 |', '| 7 | eta |  |', '| 15 | theta |  |']),
};
report.got = {}; report.bad = [];
for (const [k, v] of Object.entries(E)) { report.got[k] = J(S1[k]); if (report.got[k] !== v) report.bad.push(k); }
const FINAL = '# Table fixture\n\nIntro Xsection para.Third para here.\n\n| Key | Column 2 | Column 3 |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |';
report.s = S1;
report.checks = {
  menu: S1.menuShown && S1.ins, drag: S1.gripShown && S1.dropShown, hdrOn: S1.hdrOn, coldrag: S1.cgripShown && S1.cdropShown, insCaret: JSON.stringify(S1.insCaret) === '[3,0]', multiSel: /beta/.test(S1.selC || ''),
  undo: J(S1.undone) === E.afterDel2, redo: J(S1.redone) === E.afterMulti, colCaret: JSON.stringify(S1.colCaret) === '[1,2]',
  tab: JSON.stringify(S1.tabFirst) === '[3,2]' && JSON.stringify(S1.tabCaret) === '[4,0]',
  joined: S1.joined === 'Second section para.Third para here.' && S1.joinCaret === 'para.|Third',
  cross: S1.crossSrc.replace(/\n+$/, '') === '# Table fixture\n\nIntro Xsection para.Third para here.' && S1.crossCaret === 'Intro X|sect' && !S1.crossSrc.includes('\u2063'),
  newTable: /^column 1$/i.test(S1.newSel) && S1.final.replace(/\n+$/, '') === FINAL,
};

report.tableOk = report.mounted && !report.bad.length && Object.values(report.checks).every(Boolean) && report.colour.chips>=4 && JSON.stringify(report.colour.states)==='["bad","muted","ok","warn"]' && report.colour.bars>=3 && report.colour.maxBar===1 && !logs.length;
console.log(JSON.stringify(report, null, 2));
killChrome(); process.exit(report.tableOk ? 0 : 1);
