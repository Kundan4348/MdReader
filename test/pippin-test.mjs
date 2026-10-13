// Pippin in the desktop app, against a fake pippin-mcp-server (test/fake-pippin.mjs) -- a test never reaches the
// real Pippin. Covers: create in my Pippin (Quick Create) and in a picked folder, the link surviving a relaunch,
// pulling Pippin's threads onto the right words, posting our new thread (anchored) and reply, Pippin-resolved
// threads, a reviewer's later reply arriving on the next sync, link-an-existing-doc, an expired sign-in, Disconnect.
// Usage: node test/pippin-test.mjs <outdir>
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';

const outdir = path.resolve(process.argv[2]); mkdirSync(outdir, { recursive: true });
const root = path.resolve(import.meta.dirname, '..');
const electron = path.join(root, 'app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const busy = async (pt) => { try { await fetch(`http://127.0.0.1:${pt}/json/version`, { signal: AbortSignal.timeout(800) }); return true; } catch (e) { if (e.name === 'TypeError' || e.name === 'TimeoutError') return false; throw e; } };
setTimeout(() => { console.error('FAIL: timeout'); process.exit(2); }, 260000);

const dir = path.join(outdir, 'docs'); rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
const MD = '# Switch sources\n\nThe quick brown fox jumps over the lazy dog.\n\nDeploy happens on Friday after the review.\n';
const f1 = path.join(dir, 'switch.md'), f2 = path.join(dir, 'other.md');
writeFileSync(f1, MD); writeFileSync(f2, '# Other doc\n\nNothing here yet.\n');
const STATE = path.join(outdir, 'fake-pippin.json'); rmSync(STATE, { force: true });
const fake = () => JSON.parse(readFileSync(STATE, 'utf8'));
const editFake = (fn) => { const s = fake(); fn(s); writeFileSync(STATE, JSON.stringify(s, null, 2)); };
const side = (p) => { try { return JSON.parse(readFileSync(p + '.mdr-comments.json', 'utf8')); } catch { return null; } };
const udd = path.join(outdir, 'ud'); rmSync(udd, { recursive: true, force: true }); mkdirSync(udd, { recursive: true });

async function launch(files) {
  let port = 9603; while (await busy(port)) port++;
  const proc = spawn(electron, [`--remote-debugging-port=${port}`, `--user-data-dir=${udd}`, path.join(root, 'app'), ...files], { stdio: 'ignore',
    env: { ...process.env, MDR_TEST_USER: 'Alice Rao', MDR_TEST_USER_ID: 'alice', MDR_OPEN_LOG: path.join(outdir, 'opens.log'), MDR_PIPPIN_CMD: `${process.execPath} ${path.join(root, 'test/fake-pippin.mjs')}`, FAKE_PIPPIN_STATE: STATE } });
  process.on('exit', () => { try { proc.kill('SIGKILL'); } catch {} }); // a crashed run must not leave its window holding the test profile
  let page;
  for (let i = 0; i < 60 && !page; i++) { try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.type === 'page' && x.url.includes('index.html')); } catch {} if (!page) await sleep(500); }
  const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = new Map(); const logs = [];
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } if (m.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)); };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) logs.push('EVAL: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300)); return r.result?.result?.value; };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false });
  for (let i = 0; i < 40 && (await ev(`document.querySelectorAll('#app .tabs .tab').length`)) < files.length; i++) await sleep(250);
  await sleep(800);
  return { send, ev, logs, stop: () => { try { proc.kill('SIGKILL'); } catch {} } };
}
let A, ev, send;
const use = (x) => { A = x; ev = x.ev; send = x.send; };
const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(path.join(outdir, name), Buffer.from(r.result.data, 'base64')); };
const key = (k, code, vk, mods = 0) => send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods }).then(() => send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods }));
const typeText = (t) => send('Input.insertText', { text: t });
const tab = async (p) => { await ev(`document.querySelector('#app .tabs .tab[data-path=${JSON.stringify(p)}]').click()`); await sleep(700); };
const menu = () => ev(`(()=>{const p=document.querySelector('#app .pp-pop'); return p.hidden?null:{title:p.querySelector('.pp-title')?.textContent, text:p.textContent.replace(/\\s+/g,' ').trim(), opts:[...p.querySelectorAll('.pp-opt b, .pp-f .n')].map(b=>b.textContent)}})()`);
const openMenu = async () => { if (await menu()) return; await ev(`document.querySelector('#app .top .ppb').click()`); await sleep(250); };
const clickText = (sel, t) => ev(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(sel)})].find(x=>x.textContent.includes(${JSON.stringify(t)})); if(!b) return false; b.click(); return true})()`);
const waitFor = async (expr, ms = 8000) => { for (let i = 0; i < ms / 200; i++) { if (await ev(expr)) return true; await sleep(200); } return false; };
const hlTexts = () => ev(`(()=>{const h=CSS.highlights.get('mdr-cmt'); return h?[...h].map(r=>r.toString()):[]})()`);
const select = (word) => ev(`(()=>{const doc=document.querySelector('#app .doc'); const w=document.createTreeWalker(doc,NodeFilter.SHOW_TEXT); let n; while((n=w.nextNode())){const i=n.nodeValue.indexOf(${JSON.stringify(word)}); if(i>=0){const r=document.createRange(); r.setStart(n,i); r.setEnd(n,i+${word.length}); const s=getSelection(); s.removeAllRanges(); s.addRange(r); return s.toString();}} return 'nf'})()`);
const synced = () => ev(`document.querySelector('#app .top .ppb').classList.contains('busy')`).then((b) => !b);

const r = {}; const ok = {};
use(await launch([f1, f2]));
await tab(f1);
// ---- 1. create in my Pippin ----
await openMenu(); r.menu0 = await menu();
ok.menuOffers = r.menu0?.opts.join('|') === 'Create in my Pippin|Create in a folder…|Link an existing Pippin doc…' && r.menu0.text.includes('"Switch sources"');
await shot('pp-menu.png');
await clickText('#app .pp-opt', 'Create in my Pippin');
await waitFor(`!!document.querySelector('#app .pp-pop .pp-doc')`); await waitFor(`!document.querySelector('#app .top .ppb').classList.contains('busy')`);
r.created = fake(); r.link1 = side(f1)?.pippin;
const doc1 = Object.values(r.created.docs)[0];
ok.createdQuick = !!doc1 && doc1.quick && doc1.name === 'Switch sources' && doc1.content === MD && r.created.calls[0].args.quick_create === true
  && r.link1?.designId === doc1.designId && r.link1.url.includes(doc1.designId) && r.link1.folder === 'Quick Create';
r.menu1 = await menu(); ok.linkedMenu = r.menu1?.title === 'Linked to Pippin' && r.menu1.text.includes('Switch sources') && r.menu1.text.includes('Text and comments synced');
ok.badge = await ev(`document.querySelector('#app .top .ppb').classList.contains('on')`);
await shot('pp-linked.png');
await key('Escape', 'Escape', 27);
// ---- 2. a reviewer comments on Pippin; next sync pulls it onto the right words ----
editFake((s) => { s.docs[doc1.designId].threads.push({ parent: { commentId: 'P-1', content: 'Is Friday a freeze day?', createdAt: Date.now() - 60000, updatedAt: Date.now() - 60000, createdBy: 'wquankan', status: 'ACTIVE', textAnchor: { selectedText: 'Friday' } }, replies: [] });
  s.docs[doc1.designId].threads.push({ parent: { commentId: 'P-2', content: 'Old note', createdAt: Date.now() - 90000, updatedAt: Date.now() - 90000, createdBy: 'wquankan', status: 'ACTIVE', textAnchor: { selectedText: 'lazy dog' } }, replies: [], resolved: true }); });
await openMenu(); await clickText('#app .pp-pop .cmt-send', 'Sync now'); await sleep(400); await waitFor(`!document.querySelector('#app .top .ppb').classList.contains('busy')`);
r.pull = side(f1).comments.map((c) => ({ q: c.anchor.q, who: c.author.id, res: !!c.resolved, pid: c.pippin?.id }));
ok.pulled = r.pull.length === 2 && r.pull.some((c) => c.q === 'Friday' && c.who === 'wquankan' && c.pid === 'P-1' && !c.res) && r.pull.some((c) => c.q === 'lazy dog' && c.res);
r.hl = await hlTexts(); ok.onWords = r.hl.join() === 'Friday';
await key('Escape', 'Escape', 27);
// ---- 3. reply here -> goes to Pippin into that thread ----
await ev(`(()=>{const h=CSS.highlights.get('mdr-cmt'); const x=[...h][0].getClientRects()[0]; return 1})()`);
await ev(`(()=>{const c=window.__mdr||null; return 1})()`);
await ev(`document.querySelector('#app .top .cmtb').click()`); await sleep(300);
await ev(`[...document.querySelectorAll('#app .cpane .cp-card')].find(c=>c.textContent.includes('Friday')).click()`); await sleep(400);
r.popTags = await ev(`[...document.querySelectorAll('#app .cmt-pop .cmt-pp')].map(t=>t.textContent)`);
r.noEditOnSynced = await ev(`!document.querySelector('#app .cmt-pop .cmt-e.root .cmt-acts')`);
await ev(`document.querySelector('#app .cmt-pop .cmt-foot .cmt-in').focus()`); await typeText('No, the freeze is Monday.'); await key('Enter', 'Enter', 13, 4);
await sleep(2400); await waitFor(`!document.querySelector('#app .top .ppb').classList.contains('busy')`);
r.fakeAfterReply = fake().docs[doc1.designId].threads.find((t) => t.parent.commentId === 'P-1').replies;
ok.replySent = r.popTags.join() === 'Pippin' && r.noEditOnSynced && r.fakeAfterReply.length === 1 && r.fakeAfterReply[0].content === 'No, the freeze is Monday.' && r.fakeAfterReply[0].createdBy === 'alice'
  && side(f1).comments.find((c) => c.pippin?.id === 'P-1').replies[0].pippin?.id === r.fakeAfterReply[0].commentId;
await key('Escape', 'Escape', 27);
// ---- 4. a new thread here -> anchored comment on Pippin ----
await select('quick brown fox'); await sleep(300);
await ev(`document.querySelector('#app .cmt-bubble').click()`); await sleep(200);
await typeText('Rename this example?'); await key('Enter', 'Enter', 13, 4);
await sleep(2400); await waitFor(`!document.querySelector('#app .top .ppb').classList.contains('busy')`);
r.fakeNew = fake().docs[doc1.designId].threads.find((t) => t.parent.content === 'Rename this example?');
ok.threadSent = !!r.fakeNew && r.fakeNew.parent.textAnchor?.selectedText === 'quick brown fox' && side(f1).comments.find((c) => c.text === 'Rename this example?').pippin?.id === r.fakeNew.parent.commentId;
// running sync again must not post anything twice
const nCalls = fake().calls.filter((c) => c.name === 'pippin_post_artifact_comment').length;
await openMenu(); await clickText('#app .pp-pop .cmt-send', 'Sync now'); await sleep(400); await waitFor(`!document.querySelector('#app .top .ppb').classList.contains('busy')`); await key('Escape', 'Escape', 27);
ok.noDuplicates = fake().calls.filter((c) => c.name === 'pippin_post_artifact_comment').length === nCalls && side(f1).comments.length === 3;
// ---- 5. the reviewer replies on Pippin; relaunch: the link holds and the reply arrives ----
editFake((s) => { const t = s.docs[doc1.designId].threads.find((x) => x.parent.commentId === 'P-1'); t.replies.push({ commentId: 'P-1r2', content: 'Thanks, updated.', createdAt: Date.now(), updatedAt: Date.now(), createdBy: 'wquankan', status: 'ACTIVE', parentCommentId: 'P-1' }); });
r.logs1 = A.logs.slice(); A.stop(); await sleep(800);
use(await launch([f1, f2])); await tab(f1); await sleep(2600); await waitFor(`!document.querySelector('#app .top .ppb').classList.contains('busy')`);
r.afterRelaunch = { linked: await ev(`document.querySelector('#app .top .ppb').classList.contains('on')`), replies: side(f1).comments.find((c) => c.pippin?.id === 'P-1').replies.map((x) => x.author.id + ':' + x.text) };
ok.relaunchKeepsLinkAndPulls = r.afterRelaunch.linked && r.afterRelaunch.replies.join('|') === 'alice:No, the freeze is Monday.|wquankan:Thanks, updated.';
// ---- 6. other.md: create in a folder ----
await tab(f2); await openMenu(); await clickText('#app .pp-opt', 'Create in a folder');
await waitFor(`document.querySelectorAll('#app .pp-pop .pp-f').length>0`);
r.folders = (await menu()).opts;
ok.folderList = r.folders.join('|') === 'My designs|Asset-Svc-Oncall'; // yours first, Quick Create hidden
await shot('pp-folders.png');
await clickText('#app .pp-pop .pp-f', 'Asset-Svc-Oncall');
await waitFor(`!!document.querySelector('#app .pp-pop .pp-doc')`);
const doc2 = Object.values(fake().docs).find((d) => d.name === 'Other doc');
ok.createdInFolder = !!doc2 && doc2.projectId === 'FOLD1' && !doc2.quick && side(f2)?.pippin?.folder === 'Asset-Svc-Oncall';
// ---- 7. expired sign-in shows a plain message and keeps the link ----
editFake((s) => { s.failAuth = true; });
await clickText('#app .pp-pop .cmt-send', 'Sync now'); await sleep(600); await waitFor(`!document.querySelector('#app .top .ppb').classList.contains('busy')`);
r.authMsg = (await menu())?.text;
ok.authError = /sign-in expired: run mwinit -o/.test(r.authMsg || '') && await ev(`document.querySelector('#app .top .ppb').classList.contains('err')`) && !!side(f2)?.pippin;
editFake((s) => { s.failAuth = false; });
// ---- 8. disconnect: link gone, comments stay; then link an existing doc by URL ----
await clickText('#app .pp-pop .cmt-ghost', 'Disconnect'); await sleep(150); await clickText('#app .pp-pop .cmt-ghost', 'Disconnect?'); await sleep(600);
ok.disconnect = !side(f2) && !(await ev(`document.querySelector('#app .top .ppb').classList.contains('on')`)); // no comments on other.md, so the file goes
await tab(f1); await openMenu(); await clickText('#app .pp-pop .cmt-ghost', 'Disconnect'); await sleep(150); await clickText('#app .pp-pop .cmt-ghost', 'Disconnect?'); await sleep(600);
r.afterDisc = side(f1);
ok.disconnectKeepsComments = !r.afterDisc.pippin && r.afterDisc.comments.length === 3;
await openMenu(); await clickText('#app .pp-opt', 'Link an existing');
await ev(`(()=>{const i=document.querySelector('#app .pp-pop input'); i.focus()})()`); await typeText(r.link1.url); await key('Enter', 'Enter', 13);
await waitFor(`!!document.querySelector('#app .pp-pop .pp-doc')`); await sleep(600); await waitFor(`!document.querySelector('#app .top .ppb').classList.contains('busy')`);
r.relinked = side(f1);
ok.linkExisting = r.relinked.pippin?.designId === doc1.designId && r.relinked.comments.length === 3 && fake().docs[doc1.designId].threads.length === 3; // re-adopted, nothing re-posted
ok.docsUnchanged = readFileSync(f1, 'utf8') === MD;
// ---- 9. placing Pippin comments: the same words appear several times; Pippin's markers say which one ----
const MD3 = '# Placement\n\nWe list the field rules below.\n\n## Overview\n\nSee Sources per field for each Field and the sources.\n\n## Sources per field\n\n| Field | Source |\n|---|---|\n| Serial | NSM |\n| Field | AsBuilt |\n\n- **Sources disagree:** a person decides.\n';
const f3 = path.join(dir, 'place.md'); writeFileSync(f3, MD3);
const MARKED = '# Placement\n\nWe list the field rules below.\n\n## Overview\n\nSee Sources per field for each Field and the sources.\n\n## <!-- comment:m1 -->Sources per field<!-- /comment:m1 -->\n\n<table>\n  <tr>\n    <th>Field</th>\n    <th>Source</th>\n  </tr>\n  <tr>\n    <td>Serial</td>\n    <td>NSM</td>\n  </tr>\n  <tr>\n    <td><!-- comment:m2 -->Field<!-- /comment:m2 --></td>\n    <td>AsBuilt</td>\n  </tr>\n</table>\n\n- <!-- comment:m3 -->**Sources disagree:**<!-- /comment:m3 --><!-- comment:m3 --> a person decides.<!-- /comment:m3 -->\n';
editFake((s) => { s.docs.PLACE = { projectId: 'QCP', designId: 'PLACE', name: 'Placement', content: MD3, marked: MARKED, threads: [
  { parent: { commentId: 'C1', content: 'on the heading', createdAt: 1, updatedAt: 1, createdBy: 'wquankan', status: 'ACTIVE', textAnchor: { selectedText: 'Sources per field' } }, replies: [] },
  { parent: { commentId: 'C2', content: 'on the second Field cell', createdAt: 2, updatedAt: 2, createdBy: 'wquankan', status: 'ACTIVE', textAnchor: { selectedText: 'Field' } }, replies: [] },
  { parent: { commentId: 'C3', content: 'on the list item', createdAt: 3, updatedAt: 3, createdBy: 'wquankan', status: 'ACTIVE', textAnchor: { selectedText: 'Sources disagree: a person decides.' } }, replies: [] }] }; });
r.logs2a = A.logs.slice(); A.stop(); await sleep(600);
use(await launch([f3])); await tab(f3);
await openMenu(); await clickText('#app .pp-opt', 'Link an existing');
await ev(`document.querySelector('#app .pp-pop input').focus()`); await typeText('https://pippin.amazon.dev/architect/QCP?artifact=PLACE'); await key('Enter', 'Enter', 13);
await waitFor(`!!document.querySelector('#app .pp-pop .pp-doc')`); await sleep(800); await waitFor(`!document.querySelector('#app .top .ppb').classList.contains('busy')`); await sleep(400);
r.place = await ev(`(()=>{const h=CSS.highlights.get('mdr-cmt'); return h?[...h].map(r=>{const e=r.startContainer.parentElement; const blk=e.closest('h2,th,td,li,p,nav'); return r.toString()+' @ '+(blk?blk.tagName+':'+blk.textContent.replace(/\\s+/g,' ').trim().slice(0,40):'?')}):[]})()`);
const want = ['Sources per field @ H2:', 'Field @ TD:Field', 'Sources disagree: a person decides. @ LI:'];
ok.placedByPippin = r.place.length === 3 && want.every((w) => r.place.some((p) => p.startsWith(w)));

// ---- 10. text sync: edits here go up, edits on Pippin come down, the same paragraph on both sides waits for a choice ----
const MD4 = '# Text sync\n\nFirst paragraph here.\n\nSecond paragraph here.\n\n| Name | Value |\n|---|---|\n| one | 1 |\n| two | 2 |\n\nLast paragraph.\n';
const f4 = path.join(dir, 'text.md'); writeFileSync(f4, MD4);
r.logs2b = A.logs.slice(); A.stop(); await sleep(600);
use(await launch([f4])); await tab(f4);
const tdoc = () => Object.values(fake().docs).find((d) => d.name === 'Text sync');
const syncClick = async () => { await openMenu(); await clickText('#app .pp-pop .cmt-send', 'Sync now'); await sleep(500); await waitFor(`!document.querySelector('#app .top .ppb').classList.contains('busy')`); await sleep(300); };
const onDisk = () => readFileSync(f4, 'utf8');
const shown = () => ev(`document.querySelector('#app .doc').textContent.replace(/\\s+/g,' ')`);
await openMenu(); await clickText('#app .pp-opt', 'Create in my Pippin');
await waitFor(`!!document.querySelector('#app .pp-pop .pp-doc')`); await waitFor(`!document.querySelector('#app .top .ppb').classList.contains('busy')`);
r.t0 = { base: side(f4)?.pippin?.base, menu: (await menu())?.text };
ok.textBaseOnCreate = r.t0.base?.local === MD4 && r.t0.base.remote === tdoc().content && /Sync the text too/.test(r.t0.menu) && await ev(`document.querySelector('#app .pp-sw input').checked`);
await key('Escape', 'Escape', 27);
// (a) edited here (another app saves the file): goes up as a targeted edit, nothing else on Pippin touched
writeFileSync(f4, MD4.replace('Second paragraph here.', 'Second paragraph, edited in MdReader.')); await sleep(800);
await syncClick();
r.ta = { pippin: tdoc().content, upd: fake().calls.filter((c) => c.name === 'pippin_update_artifact').map((c) => c.args.updateType) };
ok.textPushed = r.ta.pippin === MD4.replace('Second paragraph here.', 'Second paragraph, edited in MdReader.') && r.ta.upd.join() === 'string_replace' && side(f4).pippin.base.local === onDisk();
// (b) edited on Pippin: written into the file and shown
editFake((s) => { const d = Object.values(s.docs).find((x) => x.name === 'Text sync'); d.content = d.content.replace('| two | 2 |', '| two | 22 |').replace('Last paragraph.', 'Last paragraph, edited on Pippin.'); });
await syncClick();
r.tb = { disk: onDisk(), shown: await shown(), dirty: await ev(`document.querySelector('#app .tabs .tab.on').classList.contains('dirty')`) };
ok.textPulled = r.tb.disk === MD4.replace('Second paragraph here.', 'Second paragraph, edited in MdReader.').replace('| two | 2 |', '| two | 22 |').replace('Last paragraph.', 'Last paragraph, edited on Pippin.') && r.tb.shown.includes('edited on Pippin') && r.tb.shown.includes('22') && !r.tb.dirty;
// (c) the same paragraph changed on both sides: nothing applied, both versions shown, then "Keep mine" sends ours
const before = { disk: onDisk(), pippin: tdoc().content };
writeFileSync(f4, before.disk.replace('First paragraph here.', 'First paragraph, my version.')); await sleep(800);
editFake((s) => { const d = Object.values(s.docs).find((x) => x.name === 'Text sync'); d.content = d.content.replace('First paragraph here.', 'First paragraph, Pippin version.').replace('| one | 1 |', '| one | 100 |'); });
await syncClick();
r.tc = { menu: (await menu())?.text, disk: onDisk(), pippin: tdoc().content };
ok.conflictHeld = /1 part changed both here and on Pippin/.test(r.tc.menu) && r.tc.menu.includes('First paragraph, my version.') && r.tc.menu.includes('First paragraph, Pippin version.')
  && r.tc.disk === before.disk.replace('First paragraph here.', 'First paragraph, my version.') && !r.tc.pippin.includes('my version') && !r.tc.disk.includes('100'); // the unrelated Pippin edit waits too
await shot('pp-conflict.png');
await clickText('#app .pp-pop .cmt-send', 'Keep mine'); await sleep(500); await waitFor(`!document.querySelector('#app .top .ppb').classList.contains('busy')`); await sleep(300);
r.tc2 = { disk: onDisk(), pippin: tdoc().content, menu: (await menu())?.text };
ok.keepMine = r.tc2.pippin.includes('First paragraph, my version.') && !r.tc2.pippin.includes('Pippin version') && r.tc2.disk.includes('| one | 100 |') && r.tc2.disk.includes('my version') && !/changed both/.test(r.tc2.menu);
// (d) "Keep Pippin's" writes theirs into the file
writeFileSync(f4, onDisk().replace('Last paragraph, edited on Pippin.', 'Last paragraph, mine again.')); await sleep(800);
editFake((s) => { const d = Object.values(s.docs).find((x) => x.name === 'Text sync'); d.content = d.content.replace('Last paragraph, edited on Pippin.', 'Last paragraph, theirs again.'); });
await syncClick(); await clickText('#app .pp-pop .cmt-ghost', "Keep Pippin's"); await sleep(500); await waitFor(`!document.querySelector('#app .top .ppb').classList.contains('busy')`); await sleep(300);
ok.keepTheirs = onDisk().includes('Last paragraph, theirs again.') && tdoc().content.includes('theirs again') && !tdoc().content.includes('mine again');
await key('Escape', 'Escape', 27);
// (e) unsaved edits wait for the save; saving sends them
await key('2', 'Digit2', 50, 4); await sleep(400);
await ev(`(()=>{const t=document.querySelector('#app textarea.src, #app .editor textarea, #app textarea'); t.focus(); t.setSelectionRange(t.value.length,t.value.length); return 1})()`);
await typeText('\nTyped, not saved yet.\n'); await sleep(300);
await syncClick();
r.te = { menu: (await menu())?.text, pippin: tdoc().content };
ok.waitsForSave = /Save the file to sync its text/.test(r.te.menu) && !r.te.pippin.includes('Typed, not saved');
await key('Escape', 'Escape', 27);
await key('s', 'KeyS', 83, 4); await sleep(2600); await waitFor(`!document.querySelector('#app .top .ppb').classList.contains('busy')`); await sleep(300);
ok.saveSends = tdoc().content.includes('Typed, not saved yet.') && side(f4).pippin.base.local === onDisk();
// (f) switched off: Pippin edits stay on Pippin; switched on again the Pippin edit made meanwhile comes down
await key('1', 'Digit1', 49, 4); await sleep(300);
await openMenu(); await ev(`document.querySelector('#app .pp-sw input').click()`); await sleep(600);
editFake((s) => { const d = Object.values(s.docs).find((x) => x.name === 'Text sync'); d.content = d.content.replace('Typed, not saved yet.', 'Typed, then changed on Pippin.'); });
await syncClick();
r.tf = { side: side(f4).pippin, disk: onDisk() };
ok.switchOff = r.tf.side.text === false && !r.tf.disk.includes('changed on Pippin');
await ev(`document.querySelector('#app .pp-sw input').click()`); await sleep(500); await waitFor(`!document.querySelector('#app .top .ppb').classList.contains('busy')`); await sleep(300);
r.tf2 = (await menu())?.text;
ok.switchOnPulls = onDisk().includes('Typed, then changed on Pippin.') && !/changed both/.test(r.tf2 || '') && side(f4).pippin.text === undefined;
// (g) a doc linked by URL whose text differs: every differing part is a choice, never a silent overwrite
const url4 = side(f4).pippin.url;
await clickText('#app .pp-pop .cmt-ghost', 'Disconnect'); await sleep(150); await clickText('#app .pp-pop .cmt-ghost', 'Disconnect?'); await sleep(600);
writeFileSync(f4, onDisk().replace('Second paragraph, edited in MdReader.', 'Second paragraph, local only.')); await sleep(800);
await openMenu(); await clickText('#app .pp-opt', 'Link an existing');
await ev(`document.querySelector('#app .pp-pop input').focus()`); await typeText(url4); await key('Enter', 'Enter', 13);
await waitFor(`!!document.querySelector('#app .pp-pop .pp-doc')`); await sleep(600); await waitFor(`!document.querySelector('#app .top .ppb').classList.contains('busy')`); await sleep(300);
r.tg = (await menu())?.text;
ok.linkAsks = /1 part changed both here and on Pippin/.test(r.tg || '') && r.tg.includes('local only') && onDisk().includes('local only') && !tdoc().content.includes('local only');

await key('Escape', 'Escape', 27);

r.logs2 = A.logs.slice(); A.stop();
ok.noErrors = !r.logs1.length && !r.logs2a.length && !r.logs2b.length && !r.logs2.length;
writeFileSync(path.join(outdir, 'report.json'), JSON.stringify({ ok, r }, null, 2));
console.log(JSON.stringify({ ok }, null, 2));
process.exit(Object.values(ok).every(Boolean) ? 0 : 1);
