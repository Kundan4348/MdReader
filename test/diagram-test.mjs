// Headless check of mermaid diagrams (core/diagram.js) in the extension viewer: every fence in test/fixtures/diagrams.md is
// drawn in the theme colours, with the plain-words header line (title inside the picture), the summary, the how-to-read legend, hover tracing, the
// large view, Source / Copy, a quiet error for a broken diagram, and a .mmd paste recognised as its own document kind.
// Usage: node test/diagram-test.mjs <base-url> <outdir>
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
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

const waitDrawn = async () => { for (let i = 0; i < 60; i++) { await sleep(250); const st = await ev(`[...document.querySelectorAll('#app .diagram')].map(d => d.dataset.state || 'pending')`); if (st.length && st.every((s) => s !== 'pending')) return st; } return null; };

report.mounted = await mount(base + '/test/fixtures/diagrams.md');
report.states = await waitDrawn();
report.cards = await ev(`[...document.querySelectorAll('#app .diagram')].map(d => { const bar = d.querySelector('.dgbar'), v = d.querySelector('.dgv svg'); const barR = bar.getBoundingClientRect();
  return { kind: d.dataset.kind, state: d.dataset.state, label: bar.querySelector('.kind').textContent, sum: bar.querySelector('.sum').textContent, line2: d.querySelector('.dgsum')?.textContent || null,
    legend: [...d.querySelectorAll('.dglegend .lg')].map(l => l.textContent), svgW: v ? v.getBoundingClientRect().width|0 : 0, svgH: v ? v.getBoundingClientRect().height|0 : 0, cardW: d.getBoundingClientRect().width|0,
    barOneRow: barR.height < 48, buttons: [...bar.querySelectorAll('button')].map(b => b.textContent), srcHidden: d.querySelector('pre.dgsrc').hidden, l0: +d.dataset.l0, l1: +d.dataset.l1, codeblocks: d.querySelectorAll('.codeblock').length, err: d.querySelector('.dgerr')?.textContent || null }; })`);
const [flow, seq, cls, state, pie, gantt, untagged, broken] = report.cards;
// no fence in this file is left as a code block; the paragraph after the diagrams still renders
report.rest = await ev(`({ codeblocks: document.querySelectorAll('#app .codeblock').length, lastP: document.querySelector('#app .doc .sec:last-child p:last-child')?.textContent, outline: document.querySelectorAll('#app .toc a').length })`);
// hover trace on the flowchart: C (the decision) connects to B, D, E
report.hover = await ev(`(async () => { const s = document.querySelector('#app .diagram[data-kind=flowchart] svg'); const n = [...s.querySelectorAll('g.node')].find(n => /flowchart-C-/.test(n.id)); n.dispatchEvent(new MouseEvent('mouseenter')); await new Promise(r => setTimeout(r, 250));
  const onNodes = [...s.querySelectorAll('g.node.dg-on')].map(x => x.id.replace(/.*flowchart-(.+)-\\d+$/, '$1')).sort(), onEdges = [...s.querySelectorAll('path.dg-on')].map(x => x.id.replace(/.*L_/, 'L_')).sort(), onLabels = [...s.querySelectorAll('g.edgeLabel.dg-on')].map(l => l.textContent.trim()).sort();
  const dimmed = [...s.querySelectorAll('g.node:not(.dg-on)')].map(x => +getComputedStyle(x).opacity); const trace = s.classList.contains('dg-trace'); n.dispatchEvent(new MouseEvent('mouseleave')); return { trace, onNodes, onEdges, onLabels, dimmed: dimmed.every(o => o < 0.5) && dimmed.length, after: s.querySelectorAll('.dg-on').length + (s.classList.contains('dg-trace') ? 100 : 0) }; })()`);
// hover an actor on the sequence diagram: API takes part in 7 of the 10 messages
report.seqHover = await ev(`(async () => { const s = document.querySelector('#app .diagram[data-kind=sequenceDiagram] svg'); const t = [...s.querySelectorAll('text.actor')].find(t => t.textContent.trim() === 'API'); t.dispatchEvent(new MouseEvent('mouseenter')); await new Promise(r => setTimeout(r, 250)); const lines = s.querySelectorAll('.messageLine0.dg-on, .messageLine1.dg-on').length, texts = [...s.querySelectorAll('text.messageText.dg-on')].map(x => x.textContent.trim()), dim = [...s.querySelectorAll('text.messageText:not(.dg-on)')].map(x => +getComputedStyle(x).opacity); t.dispatchEvent(new MouseEvent('mouseleave')); return { lines, texts, dimmedOk: dim.length === 3 && dim.every(o => o < 0.5) }; })()`);
// Source shows the mermaid text (highlighted, numbered, same text as the fence); Copy puts it on the clipboard
await send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] }); await send('Emulation.setFocusEmulationEnabled', { enabled: true });
report.source = await ev(`(async () => { const d = document.querySelector('#app .diagram[data-kind=sequenceDiagram]'); d.querySelector('.srcb').click(); const pre = d.querySelector('pre.dgsrc'); const shown = !pre.hidden && pre.getBoundingClientRect().height > 40; const text = pre.textContent; const kws = pre.querySelectorAll('.tk-k').length, ops = pre.querySelectorAll('.tk-o').length, head = pre.querySelectorAll('.tk-h').length, lines = pre.querySelectorAll('.line').length; const gutter = getComputedStyle(pre.querySelector('.line'), '::before').content;
  d.querySelector('.srcb').click(); const hiddenAgain = pre.hidden; d.querySelector('.dgbar .copy').click(); await new Promise(r => setTimeout(r, 150)); let got = null; try { got = await navigator.clipboard.readText(); } catch (e) { got = 'ERR ' + e.message; } return { shown, hiddenAgain, startsWith: text.slice(0, 15), lines, kws, ops, head, gutter, btn: d.querySelector('.srcb').textContent, copied: got === text, copyBtn: d.querySelector('.dgbar .copy').textContent }; })()`);
// broken diagram: quiet error with the line, source open underneath, nothing else on the page affected
report.brokenOk = !!broken && broken.state === 'error' && /can’t be drawn yet -- line 3/.test(broken.err) && /Found a “\[”/.test(broken.err) && broken.srcHidden === false && broken.svgW === 0;
// large view: opens, fits, zooms with the wheel, closes on Esc
report.large = await ev(`(async () => { const d = document.querySelector('#app .diagram[data-kind=flowchart]'); d.querySelector('.dgbar .big').click(); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); const ov = document.querySelector('.dgzoom'); if (!ov) return { open: false };
  const svg = ov.querySelector('svg'), stage = ov.querySelector('.dgstage'); const r1 = svg.getBoundingClientRect(), st = stage.getBoundingClientRect(); const pct1 = ov.querySelector('.pct').textContent;
  const fits = r1.width <= st.width && r1.height <= st.height && r1.height > st.height * 0.6; stage.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, clientX: st.left + st.width / 2, clientY: st.top + st.height / 2, bubbles: true, cancelable: true })); const r2 = svg.getBoundingClientRect(); const pct2 = ov.querySelector('.pct').textContent;
  const nodes = svg.querySelectorAll('g.node').length; document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return { open: true, fits, pct1, pct2, zoomed: r2.width > r1.width * 1.3, nodes, closed: !document.querySelector('.dgzoom'), bar: ov.querySelector('.dgzbar').textContent.replace(/\\s+/g, ' ').trim() }; })()`);
// legend hide / restore, remembered
report.legend = await ev(`(async () => { const d = document.querySelector('#app .diagram[data-kind=flowchart]'); const lg = d.querySelector('.dglegend'); lg.querySelector('.lgx').click(); const off = lg.classList.contains('off'), stored = localStorage.getItem('mdr-dg-legend'); const h1 = lg.getBoundingClientRect().height; lg.click(); const back = !lg.classList.contains('off') && localStorage.getItem('mdr-dg-legend') === null; return { off, stored, compact: h1 < 32, back }; })()`);
await ev(`document.querySelector('#app .diagram[data-kind=flowchart]').scrollIntoView({ block: 'start' })`); await sleep(200); await shot('diagram-mono-flow.png');
await ev(`document.querySelector('#app .diagram[data-kind=flowchart] .dgbar .big').click()`); await sleep(400); await shot('diagram-mono-large.png'); await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
await ev(`document.querySelector('#app .diagram.broken').scrollIntoView({ block: 'center' })`); await sleep(200); await shot('diagram-mono-broken.png');
// themes: the picture is redrawn in each theme's own colours and font
report.themes = {};
for (const th of ['paper', 'studio', 'sections', 'lumen']) {
  await ev(`(()=>{const s=document.querySelector('#app select.theme'); s.value='${th}'; s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  for (let i = 0; i < 40; i++) { await sleep(150); if (await ev(`[...document.querySelectorAll('#app .diagram:not(.broken)')].every(d => d.dataset.state === 'drawn' && !d.querySelector('.dgv').getAttribute('aria-busy'))`)) break; }
  await sleep(250);
  report.themes[th] = await ev(`(() => { const d = document.querySelector('#app .diagram[data-kind=flowchart]'); const s = d.querySelector('svg'); const rect = s.querySelector('g.node rect, g.node path, g.node polygon'); const want = getComputedStyle(document.documentElement); const hex = (v) => { const m = v.trim().match(/^#([0-9a-f]{6})$/i); return m ? 'rgb(' + [0,2,4].map(i => parseInt(m[1].slice(i,i+2),16)).join(', ') + ')' : v; }; const probe = document.createElement('span'); probe.style.fontFamily = 'var(--dg-font)'; document.body.append(probe); const wantFont = getComputedStyle(probe).fontFamily.split(',')[0].replace(/['"]/g,''); probe.remove();
    return { fill: getComputedStyle(rect).fill, wantFill: hex(want.getPropertyValue('--dg-node')), font: getComputedStyle(s.querySelector('.nodeLabel')).fontFamily.split(',')[0].replace(/['"]/g,''), wantFont, drawn: d.dataset.state, cardBg: getComputedStyle(d).backgroundColor }; })()`);
  await ev(`document.querySelector('#app .diagram[data-kind=sequenceDiagram]').scrollIntoView({ block: 'start' })`); await sleep(150); await shot(`diagram-${th}.png`);
}
// a pasted .mmd becomes its own document kind (one card, the summary in the header), like JSON / SQL pastes do
const mmd = readFileSync(path.join(root, 'test/fixtures/flow.mmd'), 'utf8');
await ev(`(()=>{const s=document.querySelector('#app select.theme'); s.value='mono'; s.dispatchEvent(new Event('change',{bubbles:true}));})()`); await sleep(200);
await ev(`dispatchEvent(new KeyboardEvent('keydown',{key:'t',metaKey:true,bubbles:true}))`); await sleep(200);
await ev(`(()=>{const ta=document.querySelector('#app textarea.src'); ta.value=${JSON.stringify(mmd)}; ta.dispatchEvent(new Event('input',{bubbles:true}));})()`); await sleep(100);
await ev(`document.querySelector('#app .top [data-mode=read]').click()`); await sleep(250);
await waitDrawn();
report.mmd = await ev(`(() => { const app = document.querySelector('#app'); const d = app.querySelector('.diagram'); return { kind: app.dataset.kind, cards: app.querySelectorAll('.diagram').length, state: d?.dataset.state, sum: d?.querySelector('.sum').textContent, meta: app.querySelector('.meta')?.textContent, fmtShown: getComputedStyle(app.querySelector('.top button.fmt')).display, l: d ? d.dataset.l0 + '-' + d.dataset.l1 : null, h1: app.querySelector('.doc h1')?.textContent }; })()`);
await shot('diagram-mmd.png');

const okCard = (c, kind, sumRe, l2Re) => c && c.kind === kind && c.state === 'drawn' && sumRe.test(c.sum) && (!l2Re || l2Re.test(c.line2 || '')) && c.svgW > 100 && c.svgW <= c.cardW && c.barOneRow && c.srcHidden && c.l1 > c.l0 && c.codeblocks === 0;
report.flowOk = okCard(flow, 'flowchart', /^Flow, top to bottom · 9 steps, 1 decision · 9 arrows · 1 group$/, /Starts at “Customer places order” · ends at “Orders DB” \/ “Done” · decision: “In stock\?”/) && flow.legend.join('|') === 'Step|Decision|Start / end|Database / store|Input / output|Then|Optional / async|Arrow text = the condition or event|Hover a step to trace its arrows' && flow.l0 === 6 && flow.l1 === 25;
report.seqOk = okCard(seq, 'sequenceDiagram', /^4 participants: User, Web app, API, Database · 10 messages · 1 loop, 1 alt · 1 note$/, /^Starts with User → Web app: “open login page”$/) && seq.legend.length === 6;
report.othersOk = okCard(cls, 'classDiagram', /^4 classes · 4 relationships \(2 inherits, 1 has, 1 uses\)$/, /^Animal, Dog, Cat, Owner$/) && okCard(state, 'stateDiagram-v2', /^4 states · 6 transitions$/, /Starts at “Open” · ends at “Closed”/) && okCard(pie, 'pie', /^4 slices · total 78$/, /Largest: Alarm \(54%\)/) && okCard(gantt, 'gantt', /^4 tasks in 2 sections$/, /Switch accuracy baseline/) && okCard(untagged, 'flowchart', /^Flow, left to right · 2 steps · 1 arrow$/);
report.hoverOk = report.hover.trace && report.hover.onNodes.join() === 'B,C,D,E' && report.hover.onEdges.join() === 'L_B_C_0,L_C_D_0,L_C_E_0' && report.hover.onLabels.join() === 'no,yes' && !!report.hover.dimmed && report.hover.after === 0
  && report.seqHover.lines === 7 && report.seqHover.texts.length === 7 && report.seqHover.dimmedOk;
report.sourceOk = report.source.shown && report.source.hiddenAgain && report.source.startsWith === 'sequenceDiagram' && report.source.lines === 22 && report.source.kws >= 10 && report.source.ops >= 10 && report.source.head >= 1 && report.source.gutter === 'counter(ln)' && report.source.copied && report.source.copyBtn === 'Copied';
report.largeOk = report.large.open && report.large.fits && report.large.zoomed && report.large.closed && report.large.nodes === 9 && /^FlowchartFlow, top to bottom/.test(report.large.bar);
report.legendOk = report.legend.off && report.legend.stored === 'off' && report.legend.compact && report.legend.back;
report.themesOk = ['paper', 'studio', 'sections', 'lumen'].every((t) => { const o = report.themes[t]; return o.drawn === 'drawn' && o.fill === o.wantFill && o.font === o.wantFont; }) && new Set(Object.values(report.themes).map((o) => o.fill)).size === 4;
report.mmdOk = report.mmd.kind === 'mmd' && report.mmd.cards === 1 && report.mmd.state === 'drawn' && /^Flow, left to right · 5 steps, 1 decision · 5 arrows$/.test(report.mmd.sum) && report.mmd.fmtShown === 'none';
report.diagramOk = report.mounted && report.cards.length === 8 && report.rest.codeblocks === 0 && report.rest.lastP === 'Closing paragraph after the diagrams.' && report.flowOk && report.seqOk && report.othersOk && report.hoverOk && report.sourceOk && report.brokenOk && report.largeOk && report.legendOk && report.themesOk && report.mmdOk;
console.log(JSON.stringify(report, null, 1));
clearTimeout(hardStop); killChrome();
process.exit(report.diagramOk ? 0 : 1);
