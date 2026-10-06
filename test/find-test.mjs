// JSON documents through the extension host (shared core, so the app renders identically).
// Usage: node test/find-test.mjs <base-url> <outdir>   -- base-url serves the repo root
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
// ⌘F find bar: markdown, JSON and SQL; Read, Edit and Split.
const report = { logs };
const key = (k, extra = '') => ev(`dispatchEvent(new KeyboardEvent('keydown',{key:'${k}',metaKey:true,bubbles:true${extra}}))`);
const type = (q) => ev(`(()=>{const i=document.querySelector('#app .findbar .fq'); i.value=${JSON.stringify(q)}; i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
const enter = (shift = false) => ev(`document.querySelector('#app .findbar .fq').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',shiftKey:${shift},bubbles:true}))`);
const state = () => ev(`(()=>{const b=document.querySelector('#app .findbar'),c=document.querySelector('#app .content'),cr=c.getBoundingClientRect();
  const cur=[...(CSS.highlights.get('mdr-find-cur')||[])][0], all=CSS.highlights.get('mdr-find');
  let inView=null,curText=null,curLine=null;
  if(cur){curText=cur.toString(); const ln=cur.startContainer.parentElement.closest('.srchl .ln');
    if(ln){const ta=document.querySelector('#app textarea.src'),L=[...ln.parentElement.children];curLine=L.indexOf(ln);const y=ln.offsetTop-ta.scrollTop;inView=y>=0&&y<ta.clientHeight;}
    else{const r=cur.getBoundingClientRect();inView=r.height>0&&r.top>=cr.top&&r.bottom<=cr.bottom;}}
  return {open:!b.hidden,focused:document.activeElement===b.querySelector('.fq'),count:b.querySelector('.fcount').textContent,total:all?all.size+(cur?1:0):0,curText,curLine,inView,
    barInPane:(()=>{const r=b.getBoundingClientRect();return r.right<=cr.right+1&&r.top>=cr.top-1&&r.top<cr.top+60})()}})()`);
// independent counts: the source text (Edit) and the visible rendered text minus the tool buttons (Read)
const srcCount = (q, cs) => ev(`(()=>{const v=document.querySelector('#app textarea.src').value;const h=${cs}?v:v.toLowerCase(),n=${cs}?${JSON.stringify(q)}:${JSON.stringify(q)}.toLowerCase();let c=0,i=h.indexOf(n);while(i>=0){c++;i=h.indexOf(n,i+n.length);}return c})()`);
const docCount = (q) => ev(`(()=>{const h=document.querySelector('#app .doc').innerText.toLowerCase(),n=${JSON.stringify(q)}.toLowerCase();let c=0,i=h.indexOf(n);while(i>=0){c++;i=h.indexOf(n,i+n.length);}return c})()`);
const mode = async (m) => { await ev(`document.querySelector('#app .top [data-mode=${m}]').click()`); await sleep(450); };
const shotF = async (n) => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(path.join(outdir, n), Buffer.from(r.result.data, 'base64')); };

// ---- markdown
report.mdMounted = await mount(base + '/sample.md');
await key('f'); await sleep(150);
await type('catering'); await sleep(200);
const md = { opened: await state() };
md.indep = await docCount('catering');
await enter(); await sleep(250); md.next = await state();
await enter(true); await sleep(250); md.prev = await state();
await key('g'); await sleep(250); md.cmdG = await state();
await type('Coffee'); await sleep(150); md.ci = await state();
await ev(`document.querySelector('#app .findbar .fcase').click()`); await sleep(150); md.cs = await state();
md.csIndep = await ev(`(document.querySelector('#app .doc').innerText.match(/Coffee/g)||[]).length`);
await ev(`document.querySelector('#app .findbar .fcase').click()`);
await type('zzqqxx'); await sleep(150); md.none = await state();
await type('catering'); await sleep(150);
for (let i = 0; i < 5; i++) { await enter(); await sleep(120); } md.far = await state();
await shotF('find-md-read.png');
await mode('edit');
await sleep(300); md.edit = await state(); md.editIndep = await srcCount('catering', false);
await enter(); await sleep(250); md.editNext = await state();
await shotF('find-md-edit.png');
await ev(`document.querySelector('#app .findbar .fq').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`); await sleep(150);
md.closed = await state();
md.caret = await ev(`(()=>{const t=document.querySelector('#app textarea.src');return {focused:document.activeElement===t,sel:t.value.slice(t.selectionStart,t.selectionEnd)}})()`);
md.hlLeft = await ev(`!!(CSS.highlights.get('mdr-find')||CSS.highlights.get('mdr-find-cur'))`);
await mode('split');
await key('f'); await sleep(200); await ev(`document.querySelector('#app .doc').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`); await sleep(250);
md.split = await state();
await ev(`document.querySelector('#app textarea.src').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`); await sleep(250);
md.splitSrc = await state();
await shotF('find-md-split.png');
await ev(`document.querySelector('#app .findbar .fclose').click()`); await mode('read');
report.md = md;
const nOf = (s) => { const m = /^(\d+) of (\d+)/.exec(s.count || ''); return m ? [+m[1], +m[2]] : null; };
report.mdOk = md.opened.open && md.opened.focused && md.opened.barInPane && nOf(md.opened)?.[1] === md.indep && md.indep > 2 && md.opened.curText.toLowerCase() === 'catering' && md.opened.inView
  && nOf(md.next)[0] === nOf(md.opened)[0] % md.indep + 1 && md.next.inView && nOf(md.prev)[0] === nOf(md.opened)[0] && nOf(md.cmdG)[0] === nOf(md.next)[0]
  && nOf(md.cs)[1] === md.csIndep && nOf(md.ci)[1] >= nOf(md.cs)[1] && md.none.count === 'No matches' && md.far.inView
  && nOf(md.edit)?.[1] === md.editIndep && md.editNext.inView && md.editNext.curLine >= 0 && !md.closed.open && md.caret.focused && md.caret.sel.toLowerCase() === 'catering' && !md.hlLeft
  && nOf(md.split)?.[1] === md.indep && nOf(md.splitSrc)?.[1] === md.editIndep && md.splitSrc.curLine >= 0;

// ---- JSON: a match inside a folded node opens it
report.jsonMounted = await mount(base + '/test/fixtures/long.json');
await ev(`document.querySelectorAll('#app details.jn').forEach(d=>d.open=false); document.querySelector('#app details.jn').open=true`); await sleep(100);
await key('f'); await sleep(150); await type('owner7@'); await sleep(200);
const js = { opened: await state(), indep: (await ev(`document.querySelector('#app textarea.src').value`)).split('owner7@').length - 1 };
js.openedPath = await ev(`(()=>{const c=[...(CSS.highlights.get('mdr-find-cur')||[])][0];if(!c)return null;const out=[];for(let d=c.startContainer.parentElement.closest('details');d;d=d.parentElement.closest('details'))out.push(d.open);return out})()`);
await shotF('find-json.png');
await ev(`document.querySelector('#app .findbar .fclose').click()`);
report.json = js;
report.jsonOk = nOf(js.opened)?.[1] === js.indep && js.indep >= 1 && js.opened.inView && js.openedPath && js.openedPath.length > 1 && js.openedPath.every(Boolean);

// ---- SQL
report.sqlMounted = await mount(base + '/sample.md');
const sqlText = readFileSync(path.join(path.resolve(import.meta.dirname, '..'), 'test/fixtures/switch-queries.sql'), 'utf8');
await key('t'); await sleep(200);
await ev(`(()=>{const ta=document.querySelector('#app textarea.src'); ta.value=${JSON.stringify(sqlText)}; ta.dispatchEvent(new Event('input',{bubbles:true}));})()`); await sleep(100);
await mode('read'); report.sqlKind = await ev(`document.querySelector('#app').dataset.kind`);
await key('f'); await sleep(150); await type('o_infr_part_model'); await sleep(200);
const sq = { opened: await state() }; sq.indep = await srcCount('o_infr_part_model', false); sq.docIndep = await docCount('o_infr_part_model');
await enter(); await sleep(200); sq.next = await state();
await mode('edit'); await sleep(300); sq.edit = await state();
await shotF('find-sql-edit.png');
await ev(`document.querySelector('#app .findbar .fclose').click()`); await mode('read');
report.sql = sq;
report.sqlOk = report.sqlKind === 'sql' && nOf(sq.opened)?.[1] === sq.docIndep && sq.indep >= 3 && sq.opened.inView && sq.next.inView && nOf(sq.edit)?.[1] === sq.indep && sq.edit.inView;

report.findOk = report.mdOk && report.jsonOk && report.sqlOk;
console.log(JSON.stringify(report, null, 2));
killChrome(); process.exit(report.findOk ? 0 : 1);
