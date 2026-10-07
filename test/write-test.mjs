// Write mode (edit the rendered page in place) through the extension host -- same core as the app.
// Usage: node test/write-test.mjs <base-url> <outdir>   -- base-url serves the repo root
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
const ORIG = readFileSync(path.join(root, 'test/fixtures/write.md'), 'utf8');
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

report.mounted = await mount(base + '/test/fixtures/write.md'); await sleep(800); // the shell's init (prefs) finishes after first paint
await ev(`document.querySelector('#app .top [data-mode=write]').click()`); await sleep(400);
report.setup = await ev(`(()=>{const a=document.querySelector('#app'); return {writing:a.classList.contains('writing'), bar:getComputedStyle(a.querySelector('.wbar')).display, blocks:a.querySelectorAll('.wblock').length,
  locked:[...a.querySelectorAll('.w-locked')].map(x=>x.className), diagramEditable:!!a.querySelector('.diagram [contenteditable=true]'), editorShown:getComputedStyle(a.querySelector('.editor')).display, srcSame:a.querySelector('textarea.src').value===${JSON.stringify(ORIG)}}})()`);

// 1. type into a paragraph: only its line changes
report.c1 = await caretAfter('#app .sec .body > p', 'First plan paragraph.'); await typeText(' More.'); await sleep(700);
let s = await SRC(); const o = ORIG.split('\n');
report.para = { line: s.split('\n')[6], others: s.split('\n').filter((l, i) => i !== 6).join('\n') === o.filter((l, i) => i !== 6).join('\n'), dirty: await ev(`document.querySelector('#app').classList.contains('dirty')`) };
// 2. bold through the toolbar
await caretAfter('#app .sec .body > p', 'More', true);
await ev(`document.querySelector('#app .wbar [data-act=bold]').click()`); await sleep(700);
report.bold = (await SRC()).split('\n')[6];
// 3. Enter at the end of a heading opens a paragraph under it
await caretAfter('#app .sec h2', 'Plans'); await enter(); await typeText('New para'); await sleep(700);
// 4. "- " at the start of a new paragraph makes a list
await enter(); await typeText('-'); await typeText(' '); await typeText('item x'); await sleep(200);
report.shortcutTag = await ev(`(()=>{const b=getSelection().anchorNode; const el=(b.nodeType===1?b:b.parentElement).closest('.wblock'); return el&&el.tagName})()`);
await blur(); await sleep(300);
// 5. a table cell: only that row changes, the padded rows and alignment row stay as written
await caretAfter('#app .table-wrap tbody tr:nth-child(2) td', 'beta'); await typeText('2'); await sleep(700);
// 6. code block
await caretAfter('#app .codeblock code', 'from t'); await typeText(' where x'); await sleep(700);
// 7. checkbox
await ev(`[...document.querySelectorAll('#app li.task')].find(l=>l.textContent.includes('open task')).querySelector('input').click()`); await sleep(300);
// 8. a star bullet keeps its star
await caretAfter('#app .sec .body > ul li:nth-child(2)', 'star bullet two'); await typeText('!'); await blur(); await sleep(400);
// 9. Backspace in an empty new paragraph removes it again
await caretAfter('#app .sec:last-of-type .body > p:last-of-type', 'Last paragraph.'); await enter(); await sleep(100);
report.emptyAt = await ev(`getSelection().anchorNode.nodeName`);
report.emptyAdded = await ev(`document.querySelectorAll('#app .wblock').length`);
await key('Backspace', 'Backspace', 8); await sleep(400);
report.emptyRemoved = await ev(`document.querySelectorAll('#app .wblock').length`);
await blur(); await sleep(500);
await shotF('write.png');
for (const th of ['paper', 'studio', 'sections', 'lumen']) { await ev(`(()=>{const s=document.querySelector('#app .top select.theme'); s.value='${th}'; s.dispatchEvent(new Event('change',{bubbles:true}))})()`); await sleep(250); await caretAfter('#app .sec .body > p', 'First plan'); await sleep(100); await shotF('write-' + th + '.png'); }
await ev(`(()=>{const s=document.querySelector('#app .top select.theme'); s.value='mono'; s.dispatchEvent(new Event('change',{bubbles:true}))})()`); await blur(); await sleep(300);
s = await SRC();
report.final = s;
const EXPECT = `# Write mode fixture

Intro paragraph with **bold**, *italic*, \`code\`, a [link](https://example.com) and snake_case_name.

## 1. Plans

New para

- item x

First plan paragraph. **More**.

* star bullet one
* star bullet two!

- [x] open task
- [x] done task

> A quoted line.

## 2. Numbers

| Name   | Count |
|:-------|------:|
| alpha  |    10 |
| beta2 | 20 |

\`\`\`sql
select 1
from t where x
\`\`\`

\`\`\`mermaid
flowchart LR
  A --> B
\`\`\`

Last paragraph.
`;
report.exact = s === EXPECT;
if (!report.exact) report.diff = s.split('\n').map((l, i) => (l !== EXPECT.split('\n')[i] ? `${i + 1}: got ${JSON.stringify(l)} want ${JSON.stringify(EXPECT.split('\n')[i])}` : null)).filter(Boolean);
// 10. back to Read: the page shows the edits
await ev(`document.querySelector('#app .top [data-mode=read]').click()`); await sleep(400);
report.read = await ev(`(()=>{const a=document.querySelector('#app'); return {writing:a.classList.contains('writing'), editable:a.querySelectorAll('[contenteditable=true]').length, bold:[...a.querySelectorAll('.doc strong')].some(x=>x.textContent==='More'), beta2:a.querySelector('.doc table').textContent.includes('beta2'), bar:getComputedStyle(a.querySelector('.wbar')).display}})()`);
report.writeOk = report.mounted && report.setup.writing && report.setup.bar === 'flex' && report.setup.editorShown === 'none' && report.setup.srcSame && !report.setup.diagramEditable && report.setup.locked.length >= 1
  && report.para.line === 'First plan paragraph. More.' && report.para.others && report.para.dirty && report.bold === 'First plan paragraph. **More**.'
  && report.shortcutTag === 'UL' && report.emptyRemoved === report.emptyAdded - 1 && report.exact
  && !report.read.writing && report.read.editable === 0 && report.read.bold && report.read.beta2 && report.read.bar === 'none' && !logs.length;
console.log(JSON.stringify(report, null, 2));
killChrome(); process.exit(report.writeOk ? 0 : 1);
