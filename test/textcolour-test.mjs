// Text colours and highlights: Markdown keeps them in the file, JSON keeps them on this machine; one show / hide switch.
// Usage: node test/textcolour-test.mjs <base-url> <outdir>   -- base-url serves the repo root
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
const SRC = () => ev(`document.querySelector('#app textarea.src').value`);
const key = (k, code, vk, mods = 0) => send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods }).then(() => send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods }));
const typeText = (t) => send('Input.insertText', { text: t });
// select `word` inside the first element matching sel (its n-th occurrence in that element's text)
const selectWord = (sel, word) => ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)}); const w=document.createTreeWalker(el,NodeFilter.SHOW_TEXT); let all='',ns=[]; while(w.nextNode()){ns.push([w.currentNode,all.length]); all+=w.currentNode.nodeValue;}
  const i=all.indexOf(${JSON.stringify(word)}); if(i<0) return 'nf:'+all; const at=(p,end)=>{for(let k=ns.length-1;k>=0;k--) if(ns[k][1]<p||(ns[k][1]===p&&!end)) return [ns[k][0],p-ns[k][1]];};
  const a=at(i,false), b=at(i+${word.length},true); (el.closest('[contenteditable=true],[contenteditable=plaintext-only]')||document.querySelector('#app .doc')).focus(); const r=document.createRange(); r.setStart(a[0],a[1]); r.setEnd(b[0],b[1]); const s=getSelection(); s.removeAllRanges(); s.addRange(r); return s.toString()})()`);
const pick = (barSel, kind, shade, colour) => ev(`(()=>{document.querySelector(${JSON.stringify(barSel)}).dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true})); document.querySelector(${JSON.stringify(barSel)}).click();
  const p=document.querySelector('#app .tcp'); if(p.hidden) return 'no picker'; p.querySelector('[data-k=${kind}]').click(); p.querySelector('[data-sh=${shade}]').click();
  const b=${colour === null ? `p.querySelector('.tcp-sw .none')` : `p.querySelector('.tcp-sw [data-c=${colour}]')`}; b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true})); b.click(); return p.hidden ? 'picked' : 'still open'})()`);
const colourOf = (sel) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); return e ? [getComputedStyle(e).color, getComputedStyle(e).backgroundColor] : null})()`);
const checks = {};

// ===== Markdown: in the file =====
report.mounted = await mount(base + '/test/fixtures/tc.md'); await sleep(700);
report.mode = await ev(`document.querySelector('#app').dataset.mode`);
report.sel1 = await selectWord('#app .doc .head p, #app .doc p', 'brown');
report.pick1 = await pick('#app .wbar [data-act=tcolour]', 't', 'strong', 'red'); await sleep(600);
report.src1 = await SRC();
checks.mdText = report.src1.includes('The quick <span data-c="red.strong">brown</span> fox jumps.');
await selectWord('#app .sec .body p', 'line'); await ev(`(()=>{const b=document.querySelector('#app .wbar [data-act=tcolour]'); b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true})); b.click()})()`); await sleep(200);
await shot('tc-picker-md.png'); await key('Escape', 'Escape', 27); await sleep(100);
report.pickerClosed = await ev(`document.querySelector('#app .tcp').hidden`);
report.sel2 = await selectWord('#app .sec .body p', 'Second');
report.pick2 = await pick('#app .wbar [data-act=tcolour]', 'h', 'soft', 'yellow'); await sleep(600);
report.src2 = await SRC();
checks.mdHighlight = report.src2.includes('<span data-hl="yellow">Second</span> line here.');
// typing elsewhere in the paragraph keeps the colour
await ev(`(()=>{const p=[...document.querySelectorAll('#app .doc p')].find(x=>x.textContent.startsWith('The quick')); const t=p.lastChild; p.closest('.doc').focus(); const r=document.createRange(); r.setStart(t,t.length); r.collapse(true); const s=getSelection(); s.removeAllRanges(); s.addRange(r)})()`);
await typeText(' Yes'); await sleep(700); await ev(`document.activeElement.blur()`); await sleep(300);
report.src3 = await SRC();
checks.mdKeeps = report.src3.includes('The quick <span data-c="red.strong">brown</span> fox jumps. Yes');
// shown in Read, with its colour
await ev(`document.querySelector('#app .top [data-mode=read]').click()`); await sleep(300);
report.body = await colourOf('#app .doc p'); report.red = await colourOf('#app .doc span[data-c]'); report.hl = await colourOf('#app .doc span[data-hl]');
checks.mdDrawn = report.red && report.red[0] !== report.body[0] && report.hl && report.hl[1] !== 'rgba(0, 0, 0, 0)';
await shot('tc-read-md.png');
// the switch hides every text colour (the file is untouched) and shows them again
await ev(`document.body.focus()`); await key('H', 'KeyH', 72, 4 | 8); await sleep(200);
report.off = { cls: await ev(`document.querySelector('#app').classList.contains('no-txtc')`), red: await colourOf('#app .doc span[data-c]'), src: (await SRC()) === report.src3 };
await key('H', 'KeyH', 72, 4 | 8); await sleep(200);
report.on = { cls: await ev(`document.querySelector('#app').classList.contains('no-txtc')`), red: await colourOf('#app .doc span[data-c]') };
checks.switch = report.off.cls && report.off.red[0] === report.body[0] && report.off.src && !report.on.cls && report.on.red[0] === report.red[0];
// removing a colour takes the span out of the file
await ev(`document.querySelector('#app .top [data-mode=write]').click()`); await sleep(400);
await selectWord('#app .doc span[data-c]', 'brown');
report.pick3 = await pick('#app .wbar [data-act=tcolour]', 't', 'strong', null); await sleep(600);
report.src4 = await SRC();
checks.mdRemove = report.src4.includes('The quick brown fox jumps. Yes') && !report.src4.includes('data-c=');

// ===== JSON: on this machine, the file untouched, back after a reload =====
report.jMounted = await mount(base + '/test/fixtures/write.json'); await sleep(800);
const jsrc = await SRC();
report.jsel = await selectWord('#app [data-wk=v][data-p*="team"]', 'assets');
report.jpick = await pick('#app .wdbar [data-act=tc]', 't', 'strong', 'green'); await sleep(400);
report.jsel2 = await selectWord('#app .table-wrap td[data-col="step"]', 'Build');
report.jpick2 = await pick('#app .wdbar [data-act=tc]', 'h', 'soft', 'amber'); await sleep(400);
report.jstore = await ev(`localStorage.getItem('mdr-marks')`);
report.jhl = await ev(`[CSS.highlights.has('mdr-t-green-strong'), CSS.highlights.has('mdr-h-amber-soft')]`);
await shot('tc-json.png');
checks.jsonSaved = /"q":"assets","n":0,"c":"green.strong"/.test(report.jstore || '') && /"q":"Build","n":\d+,"hl":"amber"/.test(report.jstore || '') && (await SRC()) === jsrc;
report.jMounted2 = await mount(base + '/test/fixtures/write.json'); await sleep(900);
report.jhl2 = await ev(`[CSS.highlights.has('mdr-t-green-strong'), CSS.highlights.has('mdr-h-amber-soft')]`);
checks.jsonPersist = report.jhl2.every(Boolean);
await ev(`document.body.focus()`); await key('H', 'KeyH', 72, 4 | 8); await sleep(200);
report.jhlOff = await ev(`[CSS.highlights.has('mdr-t-green-strong')]`);
await key('H', 'KeyH', 72, 4 | 8); await sleep(200);
checks.jsonSwitch = report.jhlOff[0] === false && (await ev(`CSS.highlights.has('mdr-t-green-strong')`));
// an unsaved paste cannot keep colours: it says so
await ev(`dispatchEvent(new KeyboardEvent('keydown',{key:'t',metaKey:true,bubbles:true}))`); await sleep(300);
await ev(`(()=>{const ta=document.querySelector('#app textarea.src'); ta.value='select a, b from t;'; ta.dispatchEvent(new Event('input',{bubbles:true}));})()`); await sleep(200);
await ev(`document.querySelector('#app .top [data-mode=write]').click()`); await sleep(400);
await selectWord('#app .sqlb pre > code', 'from');
await pick('#app .wdbar [data-act=tc]', 't', 'soft', 'blue'); await sleep(200);
report.sqlToast = await ev(`document.querySelector('#app .toast').textContent`);
checks.unsaved = /Save this file first/.test(report.sqlToast);

report.checks = checks;
report.textColourOk = !!(report.mounted && report.mode === 'write' && Object.values(checks).every(Boolean) && !logs.length);
writeFileSync(path.join(outdir, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ textColourOk: report.textColourOk, checks, logs }));
killChrome(); process.exit(report.textColourOk ? 0 : 1);
