// Smoke test for the desktop app: node test/app-test.mjs <outdir>
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';

const outdir = process.argv[2]; mkdirSync(outdir, { recursive: true });
const root = path.resolve(import.meta.dirname, '..');
const sample = path.join(root, 'sample.md');
const backup = path.join(outdir, 'sample.backup.md'); copyFileSync(sample, backup);
const electron = path.join(root, 'app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const port = 9333;
const udd = path.join(outdir, 'user-data'); rmSync(udd, { recursive: true, force: true }); mkdirSync(udd, { recursive: true }); // fresh profile every run
const proc = spawn(electron, [`--remote-debugging-port=${port}`, `--user-data-dir=${udd}`, path.join(root, 'app'), sample], { stdio: ['ignore', 'ignore', 'pipe'] });
const stop = () => { try { proc.kill('SIGKILL'); } catch {} };
process.on('exit', stop);
setTimeout(() => { console.error('FAIL: timeout'); stop(); process.exit(2); }, 90000);

let page, lastTargets = [], errBuf = '';
proc.stderr.on('data', (d) => (errBuf += d));
for (let i = 0; i < 60 && !page; i++) { try { lastTargets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); page = lastTargets.find((x) => x.type === 'page' && x.url.includes('index.html')); } catch {} if (!page) await sleep(500); }
if (!page) { console.log(JSON.stringify({ fail: 'no page target', targets: lastTargets.map((t) => t.type + ' ' + t.url), stderr: errBuf.slice(-1500) }, null, 2)); stop(); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map(); const logs = [];
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } if (m.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)); };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result?.result?.value; };
const shot = async (n) => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(path.join(outdir, n), Buffer.from(r.result.data, 'base64')); };
await send('Runtime.enable'); await send('Page.enable');

const report = { logs };
let ok = false; for (let i = 0; i < 40; i++) { await sleep(250); if (await ev(`document.querySelectorAll('#app table').length > 0`)) { ok = true; break; } }
report.mounted = ok;
report.h1 = await ev(`document.querySelector('#app h1')?.textContent`);
report.defaultTheme = await ev('document.documentElement.dataset.theme');
// Navigation guard: a relative link to a non-markdown file must not replace the window contents.
await ev(`(()=>{const a=document.createElement('a'); a.href='core/themes/sections.css'; a.textContent='x'; document.querySelector('#app .doc').appendChild(a); a.click(); a.remove();})()`);
await sleep(600);
report.stillMounted = await ev(`!!document.querySelector('#app h1') && location.pathname.endsWith('index.html')`);
report.debug = await ev(`(async()=>({cls: document.querySelector('#app').className, hasListDir: typeof window.mdreader?.listDir, apiKeys: Object.keys(window.mdreader||window.api||{}), prefFiles: await (window.mdreader||window.api)?.getPref?.('files'), w: innerWidth}))()`);
report.filesPanelVisible = await ev(`getComputedStyle(document.querySelector('#app .files')).display !== 'none' && !getComputedStyle(document.querySelector('#app')).gridTemplateColumns.startsWith('0px')`);
report.fileTreeEntries = await ev(`document.querySelectorAll('#app .files li, #app .files .node, #app .files a, #app .files button').length`);
report.widths = {};
for (const w of ['auto', 'narrow', 'wide', 'full']) {
  await ev(`(()=>{const b=document.querySelector('#app .top button.width'); let n=0; while(document.querySelector('#app').dataset.width!=='${w}' && n++<5) b.click();})()`);
  await sleep(150);
  report.widths[w] = await ev(`document.querySelector('#app .doc').getBoundingClientRect().width|0`);
}
await ev(`document.querySelector('#app .top button.width').click()`);
report.zoom = await ev(`getComputedStyle(document.querySelector('#app')).getPropertyValue('--zoom').trim()`);
report.themes = {};
for (const t of ['paper', 'studio', 'sections', 'mono']) {
  await ev(`(()=>{const s=document.querySelector('#app select.theme'); s.value='${t}'; s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await sleep(400);
  report.themes[t] = { applied: await ev('document.documentElement.dataset.theme'), cols: await ev(`getComputedStyle(document.querySelector('#app')).gridTemplateColumns`) };
  await shot(`app-${t}.png`);
}
// Outline toggle: collapses the column in side-panel themes, hides the chips row in Sections.
await ev(`(()=>{const s=document.querySelector('#app select.theme'); s.value='mono'; s.dispatchEvent(new Event('change',{bubbles:true}));})()`); await sleep(200);
const clickOutline = async () => { const b = await ev(`(()=>{const r=document.querySelector('#app .top button.outline-toggle').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}})()`); for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: b.x, y: b.y, button: 'left', clickCount: 1 }); await sleep(250); };
await clickOutline(); report.outlineOffCols = await ev(`getComputedStyle(document.querySelector('#app')).gridTemplateColumns`);
await ev(`(()=>{const s=document.querySelector('#app select.theme'); s.value='sections'; s.dispatchEvent(new Event('change',{bubbles:true}));})()`); await sleep(200);
report.sectionsChipsWhenOff = await ev(`getComputedStyle(document.querySelector('#app .head .chips')).display`);
await clickOutline(); report.sectionsChipsWhenOn = await ev(`getComputedStyle(document.querySelector('#app .head .chips')).display`);
report.outlineToggleOk = report.outlineOffCols.endsWith(' 0px') && report.sectionsChipsWhenOff === 'none' && report.sectionsChipsWhenOn === 'flex';
await ev(`(()=>{const s=document.querySelector('#app select.theme'); s.value='paper'; s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
// ---- tabs: a second launch with a file (what Finder / `open` do) must land as a tab in THIS window.
const launch2 = (file) => new Promise((res) => { const c = spawn(electron, [`--user-data-dir=${udd}`, path.join(root, 'app'), file], { stdio: 'ignore' }); c.on('exit', res); setTimeout(res, 4000); });
await launch2(path.join(root, 'test/fixtures/second.md')); await sleep(800);
await launch2(path.join(root, 'test/fixtures/third.md')); await sleep(800);
const targetsNow = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
report.windows = targetsNow.filter((t) => t.type === 'page' && t.url.includes('index.html')).length;
const tabs = async () => ev(`[...document.querySelectorAll('#app .tabs .tab')].map(t=>t.querySelector('.name').textContent+(t.classList.contains('on')?'*':'')+(t.classList.contains('dirty')?'!':''))`);
report.tabsAfterOpens = await tabs();
await ev(`(()=>{const s=document.querySelector('#app select.theme'); s.value='mono'; s.dispatchEvent(new Event('change',{bubbles:true}));})()`); await sleep(300); await shot('app-tabs-mono.png');
report.tabStripVisible = await ev(`getComputedStyle(document.querySelector('#app .tabs')).display`);
report.activeH1 = await ev(`document.querySelector('#app h1')?.textContent`);
// relative link inside third.md opens second.md's existing tab (no duplicate)
await ev(`document.querySelector('#app .doc a[href="second.md"]').click()`); await sleep(400);
report.afterLinkClick = await tabs();
// absolute paths written as text in third.md are links: the .md one opens as a tab (second.md already open -> focused,
// no duplicate), the missing one is demoted to plain text, the folder is flagged, the ~ form resolves to sample.md.
await ev(`document.querySelector('#app .tabs .tab[data-path$="third.md"]').click()`); await sleep(500);
report.pathLinks = await ev(`[...document.querySelectorAll('#app .doc a.path')].map(a=>{const p=a.dataset.path,s=p.split('/');return (p.endsWith('/')?s.at(-2)+'/':s.at(-1))+':'+[...a.classList].filter(c=>c!=='path').join('|')})`);
await ev(`document.querySelector('#app .doc a.path[data-path$="second.md"]').click()`); await sleep(400);
report.afterPathClick = await tabs();
await ev(`document.querySelector('#app .tabs .tab[data-path$="third.md"]').click()`); await sleep(300);
await ev(`document.querySelector('#app .doc a.path[data-path$="gone.md"]').click()`); await sleep(300);
report.afterMissingClick = await tabs();
report.pathLinksOk = report.pathLinks.join() === 'tool.py:,second.md:,fixtures/:,sample.md:,gone.md:missing'
  && report.afterPathClick.join() === 'sample.md,second.md*,third.md' && report.afterMissingClick.join() === 'sample.md,second.md,third.md*';
await ev(`document.querySelector('#app .tabs .tab[data-path$="second.md"]').click()`); await sleep(300); // back to where the tab flow expects us
// edit second, switch away and back: edit must survive, dirty dot must show
await ev(`document.querySelector('#app .top button[data-mode=edit]').click()`); await sleep(200);
await ev(`(()=>{const ta=document.querySelector('#app textarea.src'); ta.value = ta.value.replace('Second doc','Second doc EDITED'); ta.dispatchEvent(new Event('input',{bubbles:true}));})()`); await sleep(150);
await ev(`document.querySelector('#app .top button[data-mode=read]').click()`); await sleep(200);
await ev(`document.querySelector('#app .tabs .tab[data-path$="sample.md"]').click()`); await sleep(300);
report.sampleH1 = await ev(`document.querySelector('#app h1')?.textContent`);
report.tabsWhileAway = await tabs();
await ev(`document.querySelector('#app .tabs .tab[data-path$="second.md"]').click()`); await sleep(300);
report.editSurvived = await ev(`document.querySelector('#app h1')?.textContent`);
// ctrl+tab cycles; close the clean third tab via its ✕
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', modifiers: 2 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', modifiers: 2 }); await sleep(300);
report.afterCtrlTab = await tabs();
await ev(`document.querySelector('#app .tabs .tab[data-path$="third.md"] .x').click()`); await sleep(400);
report.afterCloseThird = await tabs();
// discard the second.md edit so the file is untouched: revert text, then close it
await ev(`document.querySelector('#app .tabs .tab[data-path$="second.md"]').click()`); await sleep(200);
await ev(`document.querySelector('#app .top button[data-mode=edit]').click()`); await sleep(200);
await ev(`(()=>{const ta=document.querySelector('#app textarea.src'); ta.value = ta.value.replace('Second doc EDITED','Second doc'); ta.dispatchEvent(new Event('input',{bubbles:true}));})()`); await sleep(150);
await ev(`document.querySelector('#app .top button[data-mode=read]').click()`); await sleep(200);
await ev(`document.querySelector('#app .tabs .tab[data-path$="second.md"] .x').click()`); await sleep(400);
report.afterCloseSecond = await tabs();
report.tabsOk = report.windows === 1 && report.tabsAfterOpens.join() === 'sample.md,second.md,third.md*' && report.afterLinkClick.join() === 'sample.md,second.md*,third.md'
  && report.tabsWhileAway.join() === 'sample.md*,second.md!,third.md' && report.editSurvived === 'Second doc EDITED' && report.afterCloseSecond.join() === 'sample.md*';
report.secondFileUntouched = readFileSync(path.join(root, 'test/fixtures/second.md'), 'utf8').startsWith('# Second doc\n');
// breadcrumbs: sample.md is open; its crumbs end with "~ / Documents / MdReader". Clicking "Documents" must re-root
// the Files tree there, expand it down to MdReader/, and keep sample.md highlighted. The ⌖ button must exist (app can reveal).
report.crumbLabels = await ev(`[...document.querySelectorAll('#app .top .crumbs button.c')].map(b=>b.textContent)`);
report.revealBtn = await ev(`!!document.querySelector('#app .top .crumbs .reveal')`);
await ev(`(()=>{const bs=[...document.querySelectorAll('#app .top .crumbs button.c')]; bs[bs.length-2].click();})()`); await sleep(900);
report.treeRootAfterCrumb = await ev(`document.querySelector('#app .tree > .folder')?.dataset.path`);
report.treeExpandedToFile = await ev(`(()=>{const f=document.querySelector('#app .tree .file.on'); if(!f) return null; let n=f.parentElement.closest('.folder'), open=true; while(n){open=open&&n.classList.contains('open'); n=n.parentElement.closest('.folder');} return {path:f.dataset.path, allOpen:open}})()`);
report.crumbsOk = report.revealBtn && report.crumbLabels[0] === '~' && report.crumbLabels.at(-1) === 'MdReader'
  && report.treeRootAfterCrumb === path.dirname(root) && report.treeExpandedToFile?.path === sample && report.treeExpandedToFile?.allOpen === true;
// edit + save round trip
await ev(`document.querySelector('#app .top button.edit, #app .top [data-mode=edit]')?.click()`); await sleep(300);
await ev(`(()=>{const ta=document.querySelector('#app textarea'); ta.value = ta.value.replace('Coffee bar','Coffee bar [APP-EDIT]'); ta.dispatchEvent(new Event('input',{bubbles:true}));})()`);
await sleep(200);
await ev(`document.querySelector('#app .top button.save')?.click()`); await sleep(800);
report.savedToDisk = readFileSync(sample, 'utf8').includes('[APP-EDIT]');
report.dirtyAfterSave = await ev(`document.querySelector('#app').classList.contains('dirty')`);
copyFileSync(backup, sample); // restore
await sleep(800);
report.reloadedFromDisk = await ev(`!document.querySelector('#app textarea').value.includes('[APP-EDIT]')`);
console.log(JSON.stringify(report, null, 2));
stop(); process.exit(report.mounted && report.filesPanelVisible && report.savedToDisk && !report.dirtyAfterSave && report.defaultTheme === 'mono' && report.stillMounted && report.outlineToggleOk && report.tabsOk && report.pathLinksOk && report.secondFileUntouched && report.crumbsOk ? 0 : 1);
