// Headless test for the Chrome extension via the DevTools protocol (Node 22 built-in WebSocket, no deps).
// Usage: node test/ext-test.mjs <url> <outdir>
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';

const [url, outdir] = process.argv.slice(2);
const root = path.resolve(import.meta.dirname, '..');
const ud = path.join(outdir, 'ud');
rmSync(ud, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const CH = process.env.MDR_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const chrome = spawn(CH, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${ud}`, `--load-extension=${path.join(root, 'extension')}`,
  '--remote-debugging-port=0', '--window-size=' + (process.env.MDR_W || '1280,1800'), 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
const killChrome = () => { try { chrome.kill('SIGKILL'); } catch {} };
process.on('exit', killChrome);
const hardStop = setTimeout(() => { console.error('FAIL: global timeout'); killChrome(); process.exit(2); }, 60000);

// Find the DevTools port from stderr.
const port = await new Promise((res, rej) => {
  let buf = '';
  chrome.stderr.on('data', (d) => { buf += d; const m = buf.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/); if (m) res(+m[1]); });
  chrome.on('exit', () => rej(new Error('chrome exited early')));
});

let page;
for (let i = 0; i < 20 && !page; i++) { const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); page = targets.find((t) => t.type === 'page'); if (!page) await sleep(250); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
const logs = [];
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.type + ': ' + m.params.args.map((a) => a.value ?? a.description).join(' ')); if (m.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)); };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result?.result?.value; };
const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(path.join(outdir, name), Buffer.from(r.result.data, 'base64')); };

await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url });

// Wait for the content script to replace the <pre> with the MdReader shell.
let mounted = false;
for (let i = 0; i < 40; i++) { await sleep(250); if (await evalJs(`!!document.querySelector('#app .top') && document.querySelectorAll('#app table').length > 0`)) { mounted = true; break; } }
const report = { url, mounted, logs };
if (!mounted) {
  report.bodyHead = await evalJs('document.body ? document.body.innerHTML.slice(0,300) : null');
  report.contentType = await evalJs('document.contentType');
  await shot('ext-fail.png');
  console.log(JSON.stringify(report, null, 2)); clearTimeout(hardStop); killChrome(); process.exit(1);
}
report.rects = await evalJs(`Object.fromEntries(['.files','.outline','.content','.doc'].map(q=>{const e=document.querySelector('#app '+q); const r=e.getBoundingClientRect(); return [q,{x:r.x|0,w:r.width|0,display:getComputedStyle(e).display}]}))`);
report.cols = await evalJs(`getComputedStyle(document.querySelector('#app')).gridTemplateColumns`);
report.contentType = await evalJs('document.contentType');
report.h1 = await evalJs(`document.querySelector('#app h1')?.textContent`);
report.tables = await evalJs(`document.querySelectorAll('#app table').length`);
report.numericCells = await evalJs(`document.querySelectorAll('#app td.num, #app th.num').length`);
report.totalRows = await evalJs(`document.querySelectorAll('#app tr.total').length`);
report.outlineItems = await evalJs(`document.querySelectorAll('#app .outline a, #app .outline li').length`);
report.filesDebug = await evalJs(`({cls: document.querextSelector ? 0 : document.querySelector('#app').className, disp: getComputedStyle(document.querySelector('#app .files')).display, cols: getComputedStyle(document.querySelector('#app')).gridTemplateColumns})`);
report.filesHidden = await evalJs(`getComputedStyle(document.querySelector('#app .files')).display==='none' && getComputedStyle(document.querySelector('#app')).gridTemplateColumns.startsWith('0px')`);
report.extraButtons = await evalJs(`[...document.querySelectorAll('#app .top button')].map(b=>b.title||b.textContent.trim()).filter(Boolean)`);
report.themes = {};
for (const t of ['paper', 'studio', 'sections', 'mono']) {
  await evalJs(`(async()=>{const s=document.querySelector('#app select.theme'); s.value='${t}'; s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await sleep(400);
  report.themes[t] = { headerAlign: await evalJs(`(()=>{const th=document.querySelector('#app table thead th.num'); const td=document.querySelector('#app table tbody tr td.num'); const a=getComputedStyle(th).textAlign, b=getComputedStyle(td).textAlign; return a+'/'+b})()`), applied: await evalJs('document.documentElement.dataset.theme'), bg: await evalJs('getComputedStyle(document.body).backgroundColor'), font: await evalJs(`getComputedStyle(document.querySelector('#app h1')).fontFamily.slice(0,40)`) };
  await shot(`ext-${t}.png`);
}
// Width modes + zoom steps.
report.widths = {};
for (const w of ['auto', 'narrow', 'wide', 'full']) {
  await evalJs(`(()=>{const b=document.querySelector('#app .top button.width'); while(document.querySelector('#app').dataset.width!=='${w}') b.click();})()`);
  await sleep(150);
  report.widths[w] = await evalJs(`document.querySelector('#app .doc').getBoundingClientRect().width|0`);
}
await evalJs(`document.querySelector('#app .top button.width').click()`); // back to auto
report.zoomBefore = await evalJs(`getComputedStyle(document.querySelector('#app')).getPropertyValue('--zoom').trim()`);
await evalJs(`document.querySelector('#app .top button.zoom-in').click()`); await sleep(100);
report.zoomAfterPlus = await evalJs(`getComputedStyle(document.querySelector('#app')).getPropertyValue('--zoom').trim()`);
report.h1pxAfterPlus = await evalJs(`document.querySelector('#app h1').getBoundingClientRect().height|0`);
await evalJs(`document.querySelector('#app .top button.zoom-out').click()`); await sleep(100);
// Trackpad pinch arrives as ctrl+wheel: negative deltaY = pinch out (zoom in). 10 ticks of -8 => x2.2, clamped at 2.
const zoomVar = () => evalJs(`+getComputedStyle(document.querySelector('#app')).getPropertyValue('--zoom')`);
const pinch = (dy, n) => evalJs(`(()=>{const el=document.querySelector('#app .doc')||document.querySelector('#app');for(let i=0;i<${n};i++) el.dispatchEvent(new WheelEvent('wheel',{deltaY:${dy},ctrlKey:true,bubbles:true,cancelable:true}));})()`);
const z0 = await zoomVar();
await pinch(-8, 3); await sleep(50); const zIn = await zoomVar();
await pinch(8, 6); await sleep(50); const zOut = await zoomVar();
await pinch(-8, 40); await sleep(50); const zMax = await zoomVar();
await evalJs(`document.querySelector('#app .top button.zoom-out').click()`); await sleep(50); const zStepFromMax = await zoomVar();
await pinch(8, 200); await sleep(50); const zMin = await zoomVar();
await evalJs(`document.querySelector('#app .top button.zoom-in').click()`); await sleep(50); const zStepFromMin = await zoomVar();
await evalJs(`(()=>{const el=document.querySelector('#app .doc')||document.querySelector('#app');el.dispatchEvent(new WheelEvent('wheel',{deltaY:8,bubbles:true,cancelable:true}));})()`); await sleep(50); const zPlainWheel = await zoomVar();
report.pinch = { z0, zIn, zOut, zMax, zStepFromMax, zMin, zStepFromMin, zPlainWheel };
// autoZoom multiplies --zoom, so compare ratios rather than absolute values.
report.pinchOk = zIn > z0 && zOut < zIn && Math.abs(zMax / z0 - 2) < 0.02 && Math.abs(zStepFromMax / z0 - 1.7) < 0.02
  && Math.abs(zMin / z0 - 0.8) < 0.02 && Math.abs(zStepFromMin / z0 - 0.9) < 0.02 && zPlainWheel === zStepFromMin;
await evalJs(`document.querySelector('#app .top button.zoom-in').click()`); await sleep(50); // back to 100%
// Edit mode: toggle, type, confirm dirty flag and re-render.
await evalJs(`(async()=>{document.querySelector('#app .top button.edit, #app .top [data-mode=edit]')?.click()})()`);
await sleep(300);
report.editorVisible = await evalJs(`!!document.querySelector('#app textarea, #app .editor') && getComputedStyle(document.querySelector('#app textarea, #app .editor')).display !== 'none'`);
if (report.editorVisible) {
  await evalJs(`(()=>{const ta=document.querySelector('#app textarea'); if(!ta) return; ta.value = ta.value.replace('Coffee bar','Coffee bar [EXT-EDIT]'); ta.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await sleep(200);
  report.dirty = await evalJs(`document.body.innerHTML.includes('●') || !!document.querySelector('#app .dirty, #app .top .dot')`);
  await evalJs(`(async()=>{document.querySelector('#app .top button.read, #app .top [data-mode=read]')?.click()})()`);
  await sleep(300);
  report.editRendered = await evalJs(`document.querySelector('#app h1')?.textContent.includes('[EXT-EDIT]')`);
  await shot('ext-edited.png');
}
console.log(JSON.stringify(report, null, 2));
clearTimeout(hardStop); killChrome(); process.exit(report.mounted && report.tables > 0 && report.pinchOk ? 0 : 1);
