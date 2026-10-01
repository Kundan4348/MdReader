// Headless check of fenced-code rendering (core/hl.js + md.js decorateCode) in the extension viewer.
// Usage: node test/code-test.mjs <base-url> <outdir>   -- base-url serves the repo root (test/fixtures/code.md)
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';

const [base, outdir] = process.argv.slice(2);
const root = path.resolve(import.meta.dirname, '..');
const ud = path.join(outdir, 'ud');
rmSync(ud, { recursive: true, force: true }); mkdirSync(outdir, { recursive: true });
const CH = process.env.MDR_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const chrome = spawn(CH, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${ud}`,
  `--load-extension=${path.join(root, 'extension')}`, '--remote-debugging-port=0', '--window-size=1280,1600', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const killChrome = () => { try { chrome.kill('SIGKILL'); } catch {} };
process.on('exit', killChrome);
const hardStop = setTimeout(() => { console.error('FAIL: global timeout'); killChrome(); process.exit(2); }, 60000);
const port = await new Promise((res, rej) => { let buf = ''; chrome.stderr.on('data', (d) => { buf += d; const m = buf.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/); if (m) res(+m[1]); }); chrome.on('exit', () => rej(new Error('chrome exited early'))); });
let page; for (let i = 0; i < 20 && !page; i++) { const t = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); page = t.find((x) => x.type === 'page'); if (!page) await sleep(250); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0; const pending = new Map(); const logs = [];
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.args.map((a) => a.value ?? a.description).join(' ')); if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + JSON.stringify(m.params.exceptionDetails).slice(0, 400)); };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result?.result?.value; };
const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(path.join(outdir, name), Buffer.from(r.result.data, 'base64')); };
await send('Page.enable'); await send('Runtime.enable');
const mount = async (url) => { await send('Page.navigate', { url }); for (let i = 0; i < 40; i++) { await sleep(250); if (await ev(`!!document.querySelector('#app .doc h1')`)) return true; } return false; };
const report = { logs };

report.mounted = await mount(base + '/test/fixtures/code.md');
const blocks = await ev(`[...document.querySelectorAll('#app .codeblock')].map(b => { const code = b.querySelector('pre>code'); const bar = b.querySelector('.codebar');
  const tk = (c) => code.querySelectorAll('.tk-' + c).length;
  const barR = bar.getBoundingClientRect(), preR = b.querySelector('pre').getBoundingClientRect();
  const firstLine = code.querySelector('.line'); const gutter = b.classList.contains('numbered') ? getComputedStyle(firstLine, '::before').content : null;
  return { lang: b.dataset.lang || null, label: bar.querySelector('.lang').textContent, lc: bar.querySelector('.lc').textContent, copy: !!bar.querySelector('button.copy'),
    lines: code.querySelectorAll('.line').length, kw: tk('k'), str: tk('s'), num: tk('n'), com: tk('c'), fn: tk('f'), attr: tk('a'),
    text: code.textContent, numbered: b.classList.contains('numbered'), gutter, barInsidePre: barR.top >= preR.top - 1 && barR.right <= preR.right + 1 && barR.left >= preR.left - 1,
    stamped: !!b.dataset.l0 && !b.querySelector('pre').dataset.l0, plainPreLeft: b.querySelector('pre').getBoundingClientRect().left };
})`);
report.blocks = blocks.map((b) => Object.assign({}, b, { text: b.text.slice(0, 40) }));
const [sql, glued, json, bash, plain, py] = blocks;
// Numbers sit in the gutter left of the code: measure the first line's ::before box vs the text start.
report.gutterGeom = await ev(`(() => { const b = document.querySelector('#app .codeblock.numbered'); const l = b.querySelector('code .line'); const r = l.getBoundingClientRect(); const cs = getComputedStyle(l, '::before'); const pre = b.querySelector('pre').getBoundingClientRect(); return { lineLeft: r.left|0, preLeft: pre.left|0, beforeW: parseFloat(cs.width)|0, beforeLeft: parseFloat(cs.left)|0 }; })()`);
const g = report.gutterGeom;
// The shell runs in the extension's isolated world, so the clipboard cannot be stubbed from here: grant the permission,
// click, and read the clipboard back from the page.
await send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
report.copy = await ev(`(async () => { const b = document.querySelector('#app .codeblock'); b.querySelector('button.copy').click(); await new Promise(r => setTimeout(r, 150)); let got = null; try { got = await navigator.clipboard.readText(); } catch (e) { got = 'ERR ' + e.message; } return { eq: got === b.querySelector('pre>code').textContent.replace(/\\n$/, ''), head: got && got.slice(0, 30), tail: got && got.slice(-30), btn: b.querySelector('button.copy').textContent, toast: document.querySelector('#app .toast')?.textContent }; })()`);
report.copyOk = report.copy.eq && report.copy.head.startsWith('WITH p AS (') && report.copy.tail.endsWith('ORDER BY d.realm, d.name;') && report.copy.btn === 'Copied';
await shot('code-mono.png');
report.themes = {};
for (const th of ['paper', 'studio', 'sections']) {
  await ev(`(()=>{const s=document.querySelector('#app select.theme'); s.value='${th}'; s.dispatchEvent(new Event('change',{bubbles:true}));})()`); await sleep(250);
  report.themes[th] = await ev(`(() => { const b = document.querySelector('#app .codeblock'); const k = b.querySelector('.tk-k'), s = b.querySelector('.tk-s'), code = b.querySelector('pre>code'); const bar = b.querySelector('.codebar').getBoundingClientRect(), pre = b.querySelector('pre').getBoundingClientRect(); return { kwColor: getComputedStyle(k).color, strColor: getComputedStyle(s).color, base: getComputedStyle(code).color, barInside: bar.top >= pre.top - 1 && bar.right <= pre.right + 1, textBelowBar: code.getBoundingClientRect().top >= bar.bottom - 1 }; })()`);
}
await shot('code-sections.png');
const distinct = (o) => o.kwColor !== o.strColor && o.kwColor !== o.base;
report.codeOk = report.mounted && blocks.length === 6
  && sql.lang === 'sql' && sql.label === 'SQL' && sql.lines === 15 && sql.lc === '15 lines' && sql.kw >= 12 && sql.str >= 3 && sql.num >= 2 && sql.com === 1 && sql.fn >= 4 && sql.numbered && sql.gutter === 'counter(ln)' && sql.copy && sql.stamped && sql.barInsidePre
  && sql.text.startsWith('WITH p AS (\n  SELECT date_format(')
  && glued.lang === 'sql' && glued.text.startsWith('WITH q AS (\n  SELECT 1 AS one') && glued.lines === 4 && !glued.numbered
  && json.lang === 'json' && json.attr === 6 && json.str === 3 && json.num === 1 && json.kw === 2
  && bash.lang === 'bash' && bash.com === 1 && bash.str >= 2 && bash.kw >= 1
  && plain.lang === null && plain.label === '' && plain.kw === 0 && plain.text === 'just text'
  && py.lang === 'python' && py.com === 1 && py.kw >= 4 && py.str >= 3
  && g.beforeLeft < 0 && g.beforeW > 20 && g.lineLeft - g.preLeft > 40
  && report.copyOk
  && Object.values(report.themes).every((t) => distinct(t) && t.barInside && t.textBelowBar)
  && !logs.some((l) => l.startsWith('EXC'));
console.log(JSON.stringify(report, null, 2));
clearTimeout(hardStop); killChrome(); process.exit(report.codeOk ? 0 : 1);
