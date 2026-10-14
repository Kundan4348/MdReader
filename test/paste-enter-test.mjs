// Pasting pictures and making new lines in the desktop app.
//  - Write: Enter in a table cell goes down a row, and from the last row out to a new line below the table
//  - Write: Enter / a click below the last block (a table at the very end) gives a new line there
//  - Write: a pasted picture is saved next to the file (<name>-images/pasted-*.png) and linked as its own paragraph
//  - Edit: a pasted picture's markdown goes in at the cursor
//  - an unsaved tab refuses with a message and writes nothing
// Usage: node test/paste-enter-test.mjs <outdir>
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, readdirSync, existsSync, statSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';

const outdir = path.resolve(process.argv[2]); mkdirSync(outdir, { recursive: true });
const root = path.resolve(import.meta.dirname, '..');
const electron = path.join(root, 'app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const work = path.join(outdir, 'docs'); rmSync(work, { recursive: true, force: true }); mkdirSync(work, { recursive: true });
const DOC = path.join(work, 'Create Asset Issue.md'); // a space in the name: the picture folder must not carry it
const ORIG = `| Group | Switches |
| --- | ---: |
| In both lists | 2,587 |
| Fail a rule | 3,231 |

Why the 3,231 fail:

| Rule | Switches |
| --- | ---: |
| Rack from the build sheet only | 1,638 |
| Serial on another record | 1,553 |
`;
writeFileSync(DOC, ORIG);
const udd = path.join(outdir, 'user-data'); rmSync(udd, { recursive: true, force: true }); mkdirSync(udd, { recursive: true });
const busyPort = async (pt) => { try { await fetch(`http://127.0.0.1:${pt}/json/version`, { signal: AbortSignal.timeout(800) }); return true; } catch { return false; } };
let proc;
const stop = () => { try { proc && proc.kill('SIGKILL'); } catch {} };
process.on('exit', stop);
setTimeout(() => { console.error('FAIL: timeout'); stop(); process.exit(2); }, 120000);

let port = 9561; while (await busyPort(port)) port++;
proc = spawn(electron, [`--remote-debugging-port=${port}`, `--user-data-dir=${udd}`, path.join(root, 'app'), DOC], { stdio: 'ignore' });
let page;
for (let i = 0; i < 60 && !page; i++) { try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.type === 'page' && x.url.includes('index.html')); } catch {} if (!page) await sleep(500); }
const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map(); const logs = [];
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } if (m.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)); };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
await send('Runtime.enable');
const shot = async (n) => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(path.join(outdir, n), Buffer.from(r.result.data, 'base64')); };

for (let i = 0; i < 40 && !(await ev(`!!document.querySelector('#app .doc [data-l0]')`)); i++) await sleep(250);
await sleep(600);
const SRC = () => ev(`document.querySelector('#app textarea.src').value`);
const key = async (k, code, vk, mods = 0) => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods, ...(k === 'Enter' ? { text: '\r' } : {}) }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods }); };
const enter = () => key('Enter', 'Enter', 13);
const type = (t) => send('Input.insertText', { text: t });
const caretEnd = (sel) => ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)}); document.querySelector('#app .doc').focus(); const w=document.createTreeWalker(el,NodeFilter.SHOW_TEXT); let l=null; while(w.nextNode()) l=w.currentNode; const r=document.createRange(); if(l) r.setStart(l,l.length); else r.setStart(el,0); r.collapse(true); const s=getSelection(); s.removeAllRanges(); s.addRange(r); return !!l})()`);
const caretCell = () => ev(`(()=>{const n=getSelection().anchorNode; const el=n&&(n.nodeType===1?n:n.parentElement); const td=el&&el.closest('td,th'); return td? td.textContent.trim() : (el&&el.closest('.wblock')||{}).tagName||null})()`);
// a synthetic paste carrying a real PNG (drawn on a canvas), like a screenshot on the clipboard
const pastePng = (targetExpr) => ev(`(async()=>{const c=document.createElement('canvas'); c.width=60; c.height=40; const g=c.getContext('2d'); g.fillStyle='#2a7'; g.fillRect(0,0,60,40);
  const blob=await new Promise(r=>c.toBlob(r,'image/png')); const dt=new DataTransfer(); dt.items.add(new File([blob],'image.png',{type:'image/png'}));
  const t=${targetExpr}; const e=new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}); t.dispatchEvent(e); return e.defaultPrevented})()`);
const toast = () => ev(`(document.querySelector('#app .toast.show')||{}).textContent||''`);
const pics = () => { const d = path.join(work, 'Create-Asset-Issue-images'); return existsSync(d) ? readdirSync(d) : []; };

const r = { logs };
await ev(`document.querySelector('#app .top [data-mode=write]').click()`); await sleep(500);
r.writing = await ev(`document.querySelector('#app').classList.contains('writing')`);

// 1. Enter in a data row moves down to the same column of the next row
await caretEnd('#app .table-wrap:first-of-type tbody tr:nth-child(1) td:nth-child(2)'); await enter(); await sleep(200);
r.downARow = await caretCell();
// 2. Enter in the last row of the last table: a new line below it, at the very end of the file
const lastCell = '#app .doc .table-wrap:last-of-type tbody tr:last-child td:first-child';
r.lastWrap = await ev(`!!document.querySelector(${JSON.stringify(lastCell)})`);
await caretEnd(lastCell); await enter(); await sleep(200); await type('After the table'); await sleep(900);
r.afterTableText = await SRC(); r.afterTableSrc = r.afterTableText.split('\n').slice(-3);
// 3. a click below the last block (now a paragraph with text) opens another new line
const below = await ev(`(()=>{const bs=[...document.querySelectorAll('#app .doc .wblock')]; const b=bs[bs.length-1].getBoundingClientRect(); const d=document.querySelector('#app .doc').getBoundingClientRect(); return {x:d.left+d.width/2, y:Math.min(b.bottom+60, innerHeight-20), last:bs[bs.length-1].textContent}})()`);
for (const t of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type: t, x: below.x, y: below.y, button: 'left', buttons: t === 'mousePressed' ? 1 : 0, clickCount: 1 });
await sleep(200); await type('Clicked below'); await sleep(900);
r.clickBelowText = await SRC(); r.clickBelowSrc = r.clickBelowText.split('\n').slice(-3);

// 4. paste a picture with the cursor on "Why the 3,231 fail:" -> saved next to the file, linked right after that line
await caretEnd('#app .doc p'); r.p = await ev(`getSelection().anchorNode.textContent`);
r.writePasteHandled = await pastePng(`document.querySelector('#app .doc')`); await sleep(1200);
r.writePics = pics();
const s4 = (await SRC()).split('\n'); const i4 = s4.indexOf('Why the 3,231 fail:');
r.writePasteSrc = s4.slice(i4, i4 + 5);
r.imgShown = await ev(`(()=>{const i=document.querySelector('#app .doc img'); return i? {w:i.naturalWidth, src:i.getAttribute('data-src-written')} : null})()`);
r.toast4 = await toast();
await shot('write-paste.png');
// 4b. Enter after the picture continues on a new line under it
await type(''); await enter(); await type('Under the picture'); await sleep(900);
const s4b = (await SRC()).split('\n'); r.underPicture = s4b.slice(i4 + 2, i4 + 5);

// 5. Edit mode: the markdown goes in at the cursor
await ev(`document.querySelector('#app .top [data-mode=edit]').click()`); await sleep(500);
await ev(`(()=>{const t=document.querySelector('#app textarea.src'); t.focus(); const i=t.value.indexOf('Why the'); t.setSelectionRange(i,i); return i})()`);
r.editPasteHandled = await pastePng(`document.querySelector('#app textarea.src')`); await sleep(1200);
r.editPics = pics();
const s5 = await SRC(); r.editLine = s5.split('\n').find((l) => l.includes('Why the'));
// ⌘Z takes it out again
await ev(`(()=>{document.querySelector('#app textarea.src').focus(); return document.execCommand('undo')})()`); await sleep(300); // the Edit menu's Undo does the same
r.editUndo = (await SRC()).split('\n').find((l) => l.includes('Why the'));

// 6. an unsaved tab: refused with a message, nothing written
await ev(`document.querySelector('#app .top [data-mode=write]').click()`); await sleep(300);
const before6 = pics().length;
await key('t', 'KeyT', 84, 4); await sleep(500);
await ev(`(()=>{const t=document.querySelector('#app textarea.src'); return !!t})()`);
r.untitled = await ev(`!!document.querySelector('#app .tabs .tab.on.untitled, #app .tabs .tab.on[data-untitled]') || /Untitled/.test(document.querySelector('#app .tabs .tab.on')?.textContent||'')`);
await ev(`document.querySelector('#app .top [data-mode=edit]').click()`); await sleep(300);
await ev(`document.querySelector('#app textarea.src').focus()`);
r.untitledHandled = await pastePng(`document.querySelector('#app textarea.src')`); await sleep(500);
r.untitledToast = await toast(); r.untitledPics = pics().length - before6;

r.fileOnDiskUnchanged = (await import('node:fs')).readFileSync(DOC, 'utf8') === ORIG; // nothing is saved until ⌘S
const one = (a) => a.length >= 1 && a.every((f) => /^pasted-\d{8}-\d{6}(-\d+)?\.png$/.test(f) && statSync(path.join(work, 'Create-Asset-Issue-images', f)).size > 50);
r.ok = {
  writing: r.writing,
  enterDownARow: r.downARow === '3,231',
  enterOutOfLastRow: r.afterTableSrc.join('|') === '|After the table|' && r.afterTableText.endsWith('| Serial on another record | 1,553 |\n\nAfter the table\n'),
  clickBelow: r.clickBelowText.endsWith('\n\nAfter the table\n\nClicked below\n'),
  writePaste: r.writePasteHandled === true && r.writePics.length === 1 && one(r.writePics),
  writeLinked: r.writePasteSrc[0] === 'Why the 3,231 fail:' && r.writePasteSrc[1] === '' && r.writePasteSrc[2] === `![image](Create-Asset-Issue-images/${r.writePics[0]})` && r.writePasteSrc[3] === '',
  imgShown: !!r.imgShown && r.imgShown.w === 60,
  underPicture: r.underPicture.includes('Under the picture'),
  editPaste: r.editPasteHandled === true && r.editPics.length === 2 && one(r.editPics),
  editAtCursor: /^!\[image\]\(Create-Asset-Issue-images\/pasted-[\d-]+\.png\)Why the 3,231 fail:$/.test(r.editLine || ''),
  editUndo: r.editUndo === 'Why the 3,231 fail:',
  untitledRefused: r.untitledHandled === true && /Save this file first/.test(r.untitledToast) && r.untitledPics === 0,
  fileOnDiskUnchanged: r.fileOnDiskUnchanged,
  noErrors: logs.length === 0,
};
console.log(JSON.stringify(r, null, 1));
stop();
process.exit(Object.values(r.ok).every(Boolean) ? 0 : 1);
