// MdReader diagrams (shared by the app and the extension).
// A ```mermaid fence (or a .mmd file) renders as a picture instead of code, inside a calm card:
//   a header that says in plain words what the picture is and how big ("Flowchart · 7 steps, 2 decisions · 9 arrows"),
//   the diagram drawn in the reader's own theme colours (muted, same fonts as the page),
//   a one-line legend for the shapes and arrows this diagram actually uses (closable, remembered),
//   hover a step / participant to trace its arrows (the rest fades), ⤢ opens it large with wheel-zoom and drag,
//   Source shows the mermaid text, Copy copies it, and a broken diagram gets a quiet banner with the line, not a bomb.
// The heavy lifting is mermaid (core/mermaid.min.js, loaded on first use in the app); this file is the reading layer.
(function (global) {
  const SELF = (document.currentScript && document.currentScript.src) || '';
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v; else if (k === 'html') el.innerHTML = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (v !== null && v !== undefined) el.setAttribute(k, v);
    }
    for (const k of kids.flat(Infinity)) if (k !== null && k !== undefined && k !== false) el.append(k.nodeType ? k : document.createTextNode(k));
    return el;
  };
  const plural = (n, w, ws) => `${n} ${n === 1 ? w : (ws || w + 's')}`;
  const list = (a, max = 4) => (a.length <= max ? a.join(', ') : a.slice(0, max).join(', ') + ` and ${a.length - max} more`);
  const unq = (s) => String(s || '').trim().replace(/^["'`]+|["'`]+$/g, '').replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim();

  // ---------- what kind of diagram is this ----------
  // Mermaid names its diagram by the first word; this table gives each a plain label and one sentence of help.
  const KINDS = {
    flowchart: ['Flowchart', 'Boxes are steps, arrows show what comes next'], graph: ['Flowchart', 'Boxes are steps, arrows show what comes next'],
    sequenceDiagram: ['Sequence diagram', 'Who talks to whom, in time order from top to bottom'],
    classDiagram: ['Class diagram', 'The kinds of things in a system and how they relate'],
    stateDiagram: ['State diagram', 'The states something can be in and what moves it between them'], 'stateDiagram-v2': ['State diagram', 'The states something can be in and what moves it between them'],
    erDiagram: ['Entity relationships', 'Tables or entities and how they link'],
    gantt: ['Gantt chart', 'Tasks laid out on a calendar'], pie: ['Pie chart', 'Shares of a whole'],
    journey: ['User journey', 'Steps a person goes through, scored by how it felt'],
    gitGraph: ['Git graph', 'Branches and commits'], mindmap: ['Mind map', 'One idea in the middle, branches around it'],
    timeline: ['Timeline', 'Events in order'], quadrantChart: ['Quadrant chart', 'Items placed on two axes'],
    'xychart-beta': ['Chart', 'Values plotted on x and y'], xychart: ['Chart', 'Values plotted on x and y'],
    'block-beta': ['Block diagram', 'Blocks arranged on a grid'], block: ['Block diagram', 'Blocks arranged on a grid'],
    'sankey-beta': ['Flow amounts', 'How a quantity splits and flows'], sankey: ['Flow amounts', 'How a quantity splits and flows'],
    requirementDiagram: ['Requirements', 'Requirements and what satisfies them'],
    C4Context: ['System context', 'A system and the people and systems around it'], C4Container: ['Containers', 'The deployable pieces of a system'], C4Component: ['Components', 'Parts inside a container'], C4Dynamic: ['Interactions', 'Steps between parts of a system'], C4Deployment: ['Deployment', 'Where the pieces run'],
    'architecture-beta': ['Architecture', 'Services and how they connect'], architecture: ['Architecture', 'Services and how they connect'],
    kanban: ['Kanban board', 'Work items by column'], 'packet-beta': ['Packet layout', 'Bits and fields of a packet'], packet: ['Packet layout', 'Bits and fields of a packet'],
    radar: ['Radar chart', 'Several measures on spokes'], treemap: ['Treemap', 'Sizes as nested boxes'],
  };
  // Lines that are not the diagram: %% comments, a leading `---` front-matter block (title etc.), blank lines.
  function body(text) {
    const lines = String(text).replace(/\r\n/g, '\n').split('\n');
    let i = 0, title = null, config = false;
    if (/^\s*---\s*$/.test(lines[0] || '')) { // yaml front matter
      for (i = 1; i < lines.length && !/^\s*---\s*$/.test(lines[i]); i++) { const m = lines[i].match(/^\s*title\s*:\s*(.+?)\s*$/); if (m) title = unq(m[1]); if (/^\s*config\s*:/.test(lines[i])) config = true; }
      i++;
    }
    const out = [];
    for (; i < lines.length; i++) { const l = lines[i]; if (/^\s*%%/.test(l) && !/^\s*%%\{/.test(l)) continue; if (/^\s*%%\{/.test(l)) continue; if (!l.trim()) continue; out.push({ ln: i, text: l.replace(/%%(?![{]).*$/, '').trimEnd() }); }
    return { lines: out, title, config };
  }
  function kindOf(text) {
    const b = body(text); const first = b.lines[0]; if (!first) return null;
    const w = first.text.trim().split(/\s+/)[0].replace(/[:;]+$/, '');
    if (KINDS[w]) return w;
    const lw = w.toLowerCase(); const k = Object.keys(KINDS).find((x) => x.toLowerCase() === lw); return k || null;
  }
  const looksLike = (text) => !!kindOf(text);
  const label = (kind) => (KINDS[kind] ? KINDS[kind][0] : 'Diagram');
  const help = (kind) => (KINDS[kind] ? KINDS[kind][1] : '');

  // ---------- what the diagram shows (read from the text, in plain words) ----------
  // Light, forgiving readers for the common diagram types. They only have to be right about counts and names;
  // mermaid does the real parsing when it draws. Each returns { line: 'short summary', legend: [...], ...facts }.
  const SHAPES = { // mermaid node brackets -> what the shape conventionally means
    stadium: ['Start / end', 'stadium'], circle: ['Start / end', 'circle'], dcircle: ['Stop', 'dcircle'], decision: ['Decision', 'diamond'], database: ['Database / store', 'cylinder'], io: ['Input / output', 'parallelogram'],
    manual: ['Manual step', 'trapezoid'], subroutine: ['Sub-process', 'subroutine'], prepare: ['Preparation', 'hexagon'], flag: ['Note / flag', 'flag'], step: ['Step', 'rect'], rounded: ['Step', 'round'],
  };
  const NODE_RE = /([\w][\w-]*)(\(\(\(.*?\)\)\)|\(\[.*?\]\)|\[\[.*?\]\]|\[\(.*?\)\]|\(\(.*?\)\)|\{\{.*?\}\}|\[\/.*?\/\]|\[\\.*?\\\]|\[\/.*?\\\]|\[\\.*?\/\]|>.*?\]|\[.*?\]|\(.*?\)|\{.*?\})?(?::::[\w-]+)?/y;
  const EDGE_RE = /(<?-{2,}>?|<?-\.+->?|<?={2,}>?|-{2,}[xo]\b|[xo]-{2,}>?|~{3,})(\|[^|]*\|)?/y;
  function shapeOf(br) {
    if (!br) return 'step';
    if (br.startsWith('(((')) return 'dcircle'; if (br.startsWith('([')) return 'stadium'; if (br.startsWith('[[')) return 'subroutine'; if (br.startsWith('[(')) return 'database';
    if (br.startsWith('((')) return 'circle'; if (br.startsWith('{{')) return 'prepare';
    if (/^\[\/.*\/\]$/.test(br) || /^\[\\.*\\\]$/.test(br)) return 'io'; if (br.startsWith('[/') || br.startsWith('[\\')) return 'manual';
    if (br.startsWith('>')) return 'flag'; if (br.startsWith('{')) return 'decision'; if (br.startsWith('(')) return 'rounded'; return 'step';
  }
  const stripBr = (br) => (br ? unq(br.replace(/^[(\[{>\\\/]+|[)\]}\\\/]+$/g, '')) : '');
  const DIRS = { TD: 'top to bottom', TB: 'top to bottom', LR: 'left to right', RL: 'right to left', BT: 'bottom to top' };
  function readFlow(b) {
    const nodes = new Map(), edges = []; let dir = 'TD', subgraphs = 0;
    const node = (id, br) => { const n = nodes.get(id) || { id, label: id, shape: 'step', in: 0, out: 0 }; if (br) { n.shape = shapeOf(br); const t = stripBr(br); if (t) n.label = t; } nodes.set(id, n); return n; };
    b.lines.forEach((L, li) => {
      let s = L.text.trim();
      if (li === 0) { const m = s.match(/^(?:flowchart|graph)\s+(\w+)/); if (m && DIRS[m[1]]) dir = m[1]; return; }
      if (/^subgraph\b/.test(s)) { subgraphs++; return; }
      if (/^(end|style|classDef|class|click|linkStyle|direction)\b/.test(s)) return;
      // "A -- text --> B", "A -. text .-> B", "A == text ==> B" -> normalise to the |text| form
      s = s.replace(/--\s*([^-|>]+?)\s*-->/g, '-->|$1|').replace(/-\.\s*([^.|>]+?)\s*\.->/g, '-.->|$1|').replace(/==\s*([^=|>]+?)\s*==>/g, '==>|$1|');
      s = s.replace(/@\{[^}]*\}/g, ''); // v11 "A@{ shape: ... }" attribute blocks
      let i = 0, left = [], right = [], edge = null;
      const flush = () => { if (edge && left.length && right.length) { left.forEach((a) => right.forEach((c) => { edges.push({ a, b: c, kind: edge.kind, label: edge.label }); nodes.get(a).out++; nodes.get(c).in++; })); left = right; right = []; edge = null; } };
      while (i < s.length) {
        if (/\s/.test(s[i])) { i++; continue; }
        if (s[i] === '&') { i++; continue; }
        EDGE_RE.lastIndex = i; let m = EDGE_RE.exec(s);
        if (m && m.index === i) { flush(); const op = m[1]; edge = { kind: /^-\./.test(op) || /^<-\./.test(op) ? 'dotted' : /^<?=/.test(op) ? 'thick' : /~/.test(op) ? 'invisible' : /^-{2,}$/.test(op) || /^={2,}$/.test(op) ? 'line' : /[xo]$/.test(op) ? 'cross' : 'arrow', label: m[2] ? unq(m[2].slice(1, -1)) : '' }; i += m[0].length; continue; }
        NODE_RE.lastIndex = i; m = NODE_RE.exec(s);
        if (m && m.index === i) { const n = node(m[1], m[2]); (edge ? right : left).push(n.id); i += m[0].length; continue; }
        i++;
      }
      flush();
    });
    const all = [...nodes.values()];
    const decisions = all.filter((n) => n.shape === 'decision');
    const starts = all.filter((n) => n.in === 0 && n.out > 0), ends = all.filter((n) => n.out === 0 && n.in > 0);
    const parts = [`Flow, ${DIRS[dir]}`, `${plural(all.length, 'step')}${decisions.length ? `, ${plural(decisions.length, 'decision')}` : ''}`, plural(edges.length, 'arrow')];
    if (subgraphs) parts.push(plural(subgraphs, 'group'));
    const line2 = [];
    if (starts.length && starts.length <= 2) line2.push(`Starts at ${starts.map((n) => `“${n.label}”`).join(' / ')}`);
    if (ends.length && ends.length <= 2) line2.push(`ends at ${ends.map((n) => `“${n.label}”`).join(' / ')}`);
    if (decisions.length && decisions.length <= 3) line2.push(`${decisions.length === 1 ? 'decision' : 'decisions'}: ${decisions.map((n) => `“${n.label}”`).join(', ')}`);
    const shapes = [...new Set(all.map((n) => n.shape))];
    const legend = [];
    const seen = new Set();
    for (const sh of ['step', 'rounded', 'decision', 'stadium', 'circle', 'dcircle', 'database', 'io', 'manual', 'subroutine', 'prepare', 'flag']) if (shapes.includes(sh)) { const [name, glyph] = SHAPES[sh]; if (seen.has(name)) continue; seen.add(name); legend.push({ glyph, name }); }
    const kinds = new Set(edges.map((e) => e.kind));
    if (kinds.has('arrow')) legend.push({ glyph: 'arrow', name: 'Then' });
    if (kinds.has('dotted')) legend.push({ glyph: 'dotted', name: 'Optional / async' });
    if (kinds.has('thick')) legend.push({ glyph: 'thick', name: 'Main path' });
    if (kinds.has('line')) legend.push({ glyph: 'line', name: 'Related' });
    if (kinds.has('cross')) legend.push({ glyph: 'cross', name: 'Stops / rejects' });
    if (edges.some((e) => e.label)) legend.push({ glyph: 'label', name: 'Arrow text = the condition or event' });
    return { line: parts.join(' · '), line2: line2.length ? line2.join(' · ').replace(/^./, (c) => c.toUpperCase()) : '', legend, hover: all.length > 1 && edges.length ? 'Hover a step to trace its arrows' : '', nodeList: all, nodes: all.length, edges: edges.length, decisions: decisions.length };
  }
  const MSG_RE = /^([\w][\w .-]*?)\s*(<<-->>|<<->>|-->>|->>|-->|->|--x|-x|--\)|-\))\s*([+-]?)\s*([\w][\w .-]*?)\s*:\s*(.*)$/;
  function readSequence(b) {
    const parts = new Map(); const order = []; const msgs = []; const frames = { loop: 0, alt: 0, opt: 0, par: 0, critical: 0, break: 0 }; let notes = 0, numbered = false;
    const add = (id, alias) => { id = unq(id); if (!id) return; if (!parts.has(id)) { parts.set(id, alias ? unq(alias) : id); order.push(id); } else if (alias) parts.set(id, unq(alias)); };
    for (const L of b.lines.slice(1)) {
      const s = L.text.trim(); let m;
      if ((m = s.match(/^(?:participant|actor)\s+(.+?)(?:\s+as\s+(.+))?$/))) { add(m[1], m[2]); continue; }
      if (/^autonumber\b/.test(s)) { numbered = true; continue; }
      if ((m = s.match(/^(loop|alt|opt|par|critical|break)\b/))) { frames[m[1]]++; continue; }
      if (/^(?:note|Note)\b/.test(s)) { notes++; continue; }
      if (/^(end|else|and|option|activate|deactivate|rect|box|title|accTitle|accDescr|create|destroy|links?|properties|details)\b/i.test(s)) continue;
      if ((m = s.match(MSG_RE))) { add(m[1]); add(m[4]); msgs.push({ from: m[1].trim(), to: m[4].trim(), arrow: m[2], text: unq(m[5]), reply: m[2].startsWith('--') }); }
    }
    const names = order.map((id) => parts.get(id));
    const line = [`${plural(names.length, 'participant')}: ${list(names, 5)}`, plural(msgs.length, 'message')];
    const fr = Object.entries(frames).filter(([, n]) => n).map(([k, n]) => `${n} ${k}${n === 1 ? '' : 's'}`); if (fr.length) line.push(fr.join(', '));
    if (notes) line.push(plural(notes, 'note'));
    const first = msgs[0];
    const line2 = first ? `Starts with ${parts.get(first.from) || first.from} → ${parts.get(first.to) || first.to}${first.text ? `: “${first.text}”` : ''}` : '';
    const legend = [];
    if (msgs.some((m) => !m.reply)) legend.push({ glyph: 'arrow', name: 'Asks / calls' });
    if (msgs.some((m) => m.reply)) legend.push({ glyph: 'dotted', name: 'Replies' });
    if (msgs.some((m) => /[x)]$/.test(m.arrow))) legend.push({ glyph: 'cross', name: 'Fire and forget / lost' });
    if (fr.length) legend.push({ glyph: 'frame', name: 'Framed part = repeats or a choice' });
    if (notes) legend.push({ glyph: 'note', name: 'Note' });
    if (numbered) legend.push({ glyph: 'num', name: 'Numbers = order' });
    return { line: line.join(' · '), line2, legend, hover: names.length > 1 && msgs.length ? 'Hover a participant to see only its messages' : '', participants: names.length, messages: msgs.length };
  }
  const CLASS_REL = [[/<\|--|--\|>/, 'inherits', 'inherit'], [/\*--|--\*/, 'made of', 'compose'], [/o--|--o/, 'has', 'aggregate'], [/\.\.\|>|<\|\.\./, 'implements', 'implement'], [/\.\.>|<\.\./, 'depends on', 'depend'], [/-->|<--/, 'uses', 'use'], [/--|\.\./, 'linked to', 'link']];
  function readClass(b) {
    const classes = new Set(); const rels = {}; let n = 0;
    for (const L of b.lines.slice(1)) {
      const s = L.text.trim(); let m;
      if ((m = s.match(/^class\s+([\w~<>]+)/))) { classes.add(m[1]); continue; }
      if ((m = s.match(/^([\w~<>]+)\s*("[^"]*")?\s*(<\|--|--\|>|\*--|--\*|o--|--o|\.\.\|>|<\|\.\.|\.\.>|<\.\.|-->|<--|--|\.\.)\s*("[^"]*")?\s*([\w~<>]+)/))) {
        classes.add(m[1]); classes.add(m[5]); n++; const r = CLASS_REL.find(([re]) => re.test(m[3])); if (r) rels[r[1]] = (rels[r[1]] || 0) + 1; continue;
      }
      if ((m = s.match(/^([\w~<>]+)\s*:/))) classes.add(m[1]);
    }
    const kinds = Object.entries(rels).map(([k, c]) => `${c} ${k}`);
    const legend = Object.keys(rels).map((k) => ({ glyph: 'rel-' + CLASS_REL.find((r) => r[1] === k)[2], name: k.replace(/^./, (c) => c.toUpperCase()) }));
    return { line: `${plural(classes.size, 'class', 'classes')} · ${plural(n, 'relationship')}${kinds.length ? ` (${kinds.join(', ')})` : ''}`, line2: classes.size <= 6 ? list([...classes], 6) : '', legend, hover: '', classes: classes.size, relations: n };
  }
  function readState(b) {
    const states = new Map(); let trans = 0, composite = 0; const starts = new Set(), ends = new Set();
    const st = (id) => { if (id === '[*]') return; states.set(id, (states.get(id) || 0) + 1); };
    for (const L of b.lines.slice(1)) {
      const s = L.text.trim(); let m;
      if ((m = s.match(/^state\s+("[^"]+"\s+as\s+)?([\w-]+)\s*\{/))) { composite++; st(m[2]); continue; }
      if ((m = s.match(/^state\s+"([^"]+)"\s+as\s+([\w-]+)/))) { st(m[2]); continue; }
      if ((m = s.match(/^(\[\*\]|[\w-]+)\s*-->\s*(\[\*\]|[\w-]+)\s*(?::\s*(.*))?$/))) { trans++; st(m[1]); st(m[2]); if (m[1] === '[*]') starts.add(m[2]); if (m[2] === '[*]') ends.add(m[1]); continue; }
      if ((m = s.match(/^([\w-]+)\s*:/))) st(m[1]);
    }
    const line2 = [];
    if (starts.size && starts.size <= 2) line2.push(`Starts at ${[...starts].map((x) => `“${x}”`).join(' / ')}`);
    if (ends.size && ends.size <= 2) line2.push(`ends at ${[...ends].map((x) => `“${x}”`).join(' / ')}`);
    const legend = [{ glyph: 'round', name: 'State' }, { glyph: 'arrow', name: 'Moves to (text = what triggers it)' }];
    if (starts.size || ends.size) legend.push({ glyph: 'dot', name: 'Filled dot = start, ringed dot = end' });
    if (composite) legend.push({ glyph: 'frame', name: 'Box around states = one state with inner states' });
    return { line: `${plural(states.size, 'state')} · ${plural(trans, 'transition')}${composite ? ` · ${plural(composite, 'nested state')}` : ''}`, line2: line2.join(' · ').replace(/^./, (c) => c.toUpperCase()), legend, hover: '', states: states.size, transitions: trans };
  }
  function readEr(b) {
    const ents = new Set(); let rels = 0, attrs = 0; let inBlock = false;
    for (const L of b.lines.slice(1)) {
      const s = L.text.trim(); let m;
      if (inBlock) { if (s === '}') inBlock = false; else attrs++; continue; }
      if ((m = s.match(/^([\w-]+)\s*\{/))) { ents.add(m[1]); inBlock = true; continue; }
      if ((m = s.match(/^([\w-]+)\s+[|}o][o|{]?[.-]{2}[|o{][o|}]?\s+([\w-]+)/))) { ents.add(m[1]); ents.add(m[2]); rels++; continue; }
      if ((m = s.match(/^([\w-]+)\s*$/))) ents.add(m[1]);
    }
    return { line: `${plural(ents.size, 'entity', 'entities')} · ${plural(rels, 'relationship')}${attrs ? ` · ${plural(attrs, 'field')}` : ''}`, line2: ents.size <= 6 ? list([...ents], 6) : '', legend: [{ glyph: 'er', name: 'Line ends: | exactly one · o{ zero or many · |{ one or many · o| zero or one' }], hover: '' };
  }
  function readGantt(b) {
    let sections = 0, tasks = 0, title = ''; let m;
    for (const L of b.lines.slice(1)) {
      const s = L.text.trim();
      if (/^section\b/.test(s)) { sections++; continue; }
      if ((m = s.match(/^title\s+(.+)/))) { title = m[1]; continue; }
      if (/^(dateFormat|axisFormat|excludes|todayMarker|tickInterval|weekday|inclusiveEndDates|topAxis|displayMode)\b/.test(s)) continue;
      if (/:/.test(s)) tasks++;
    }
    return { line: `${plural(tasks, 'task')}${sections ? ` in ${plural(sections, 'section')}` : ''}`, line2: title, legend: [{ glyph: 'bar', name: 'Bar = a task, left edge start, right edge end' }, { glyph: 'today', name: 'Vertical line = today' }], hover: '' };
  }
  function readPie(b) {
    const slices = []; let title = '';
    for (const L of b.lines) { const s = L.text.trim(); let m; if ((m = s.match(/^"([^"]+)"\s*:\s*([\d.]+)/))) slices.push({ label: m[1], v: +m[2] }); else if ((m = s.match(/^title\s+(.+)/))) title = m[1]; else if ((m = s.match(/^pie\s+title\s+(.+)/))) title = m[1]; }
    const total = slices.reduce((a, s) => a + s.v, 0); const big = slices.slice().sort((a, c) => c.v - a.v)[0];
    return { line: `${plural(slices.length, 'slice')}${total ? ` · total ${+total.toFixed(2)}` : ''}`, line2: big && total ? `Largest: ${big.label} (${Math.round((big.v / total) * 100)}%)${title ? ` · ${title}` : ''}` : title, legend: [], hover: '' };
  }
  function readGeneric(b, kind) {
    const n = Math.max(0, b.lines.length - 1);
    return { line: `${plural(n, 'line')}`, line2: '', legend: [], hover: '' };
  }
  function analyse(text) {
    const b = body(text); const kind = kindOf(text);
    let r;
    try {
      r = kind === 'flowchart' || kind === 'graph' ? readFlow(b) : kind === 'sequenceDiagram' ? readSequence(b) : kind === 'classDiagram' ? readClass(b)
        : kind === 'stateDiagram' || kind === 'stateDiagram-v2' ? readState(b) : kind === 'erDiagram' ? readEr(b) : kind === 'gantt' ? readGantt(b) : kind === 'pie' ? readPie(b) : readGeneric(b, kind);
    } catch { r = readGeneric(b, kind); }
    return Object.assign({ kind, label: label(kind), help: help(kind), title: b.title, lines: String(text).replace(/\n$/, '').split('\n').length }, r);
  }

  // Legend glyphs: tiny inline SVGs in the current text colour, so the legend reads like text, not like a toolbar.
  const G = (inner, w = 22) => `<svg class="g" viewBox="0 0 ${w} 14" width="${w}" height="14" aria-hidden="true">${inner}</svg>`;
  const GLYPH = {
    rect: G('<rect x="1.5" y="2.5" width="19" height="9" rx="1"/>'), round: G('<rect x="1.5" y="2.5" width="19" height="9" rx="3"/>'), stadium: G('<rect x="1.5" y="2.5" width="19" height="9" rx="4.5"/>'),
    circle: G('<circle cx="7" cy="7" r="5"/>', 14), dcircle: G('<circle cx="7" cy="7" r="5.5"/><circle cx="7" cy="7" r="3"/>', 14), diamond: G('<path d="M8 1.5 14.5 7 8 12.5 1.5 7Z"/>', 16),
    cylinder: G('<path d="M2.5 4.5v6c0 1.1 3.4 2 7.5 2s7.5-.9 7.5-2v-6"/><ellipse cx="10" cy="4.5" rx="7.5" ry="2"/>', 20), parallelogram: G('<path d="M5 2.5h15.5l-3.5 9H1.5Z"/>'), trapezoid: G('<path d="M4 2.5h14l3 9H1Z"/>'),
    subroutine: G('<rect x="1.5" y="2.5" width="19" height="9"/><path d="M4.5 2.5v9M17.5 2.5v9"/>'), hexagon: G('<path d="M5 2.5h12l3.5 4.5L17 11.5H5L1.5 7Z"/>'), flag: G('<path d="M1.5 2.5h14l5 4.5-5 4.5h-14l3-4.5Z"/>'),
    arrow: G('<path d="M1.5 7h16"/><path d="M14 3.5 18.5 7 14 10.5" fill="none"/>'), dotted: G('<path d="M1.5 7h16" stroke-dasharray="2.5 2.5"/><path d="M14 3.5 18.5 7 14 10.5" fill="none"/>'),
    thick: G('<path d="M1.5 7h16" stroke-width="2.6"/><path d="M14 3.5 18.5 7 14 10.5" fill="none" stroke-width="2.2"/>'), line: G('<path d="M1.5 7h19"/>'), cross: G('<path d="M1.5 7h14"/><path d="M15 4l5 6M20 4l-5 6"/>'),
    label: G('<path d="M1.5 7h5M15.5 7h5"/><rect x="7" y="3.5" width="8" height="7" rx="1.5" stroke-dasharray="1.5 1.5"/>'), frame: G('<rect x="1.5" y="1.5" width="19" height="11" rx="1"/><path d="M1.5 5h6v-3.5"/>'),
    note: G('<path d="M2.5 1.5h12l5 5v6h-17Z"/><path d="M14.5 1.5v5h5"/>'), num: G('<circle cx="7" cy="7" r="5.5"/><path d="M6 4.8l1.5-1v6.5" fill="none"/>', 14), dot: G('<circle cx="5" cy="7" r="3.5" fill="currentColor"/><circle cx="16" cy="7" r="4.5"/><circle cx="16" cy="7" r="2.2" fill="currentColor"/>'),
    'rel-inherit': G('<path d="M1.5 7h12"/><path d="M13.5 2.5 19.5 7l-6 4.5Z" fill="none"/>'), 'rel-compose': G('<path d="M1.5 7h11"/><path d="M12.5 7l3.5-3.5 3.5 3.5-3.5 3.5Z" fill="currentColor"/>'), 'rel-aggregate': G('<path d="M1.5 7h11"/><path d="M12.5 7l3.5-3.5 3.5 3.5-3.5 3.5Z" fill="none"/>'),
    'rel-implement': G('<path d="M1.5 7h12" stroke-dasharray="2.5 2.5"/><path d="M13.5 2.5 19.5 7l-6 4.5Z" fill="none"/>'), 'rel-depend': G('<path d="M1.5 7h16" stroke-dasharray="2.5 2.5"/><path d="M14 3.5 18.5 7 14 10.5" fill="none"/>'), 'rel-use': G('<path d="M1.5 7h16"/><path d="M14 3.5 18.5 7 14 10.5" fill="none"/>'), 'rel-link': G('<path d="M1.5 7h19"/>'),
    er: G('<path d="M1.5 7h19"/><path d="M4 3.5v7"/><circle cx="17" cy="7" r="2.5"/>'), bar: G('<rect x="1.5" y="4" width="15" height="6" rx="1" fill="currentColor" opacity=".55"/>'), today: G('<path d="M11 1.5v11" stroke-dasharray="2 2"/>'),
  };
  const MIN_SCALE = 0.85, SHRINK_LIMIT = 0.6; // fitting below 60% makes text unreadable: show at 85% and scroll instead
  // ---------- AWS service icons ----------
  // A flowchart node whose label names an AWS service (Lambda, Kinesis, SNS, SQS, DynamoDB, S3, ...) is drawn as that
  // service's icon with the label underneath, the way AWS architecture diagrams look. The icons are drawn here in the
  // style of the AWS set (a rounded tile in the service category's colour, a white line glyph) -- nothing is fetched.
  // A cylinder (database) node that names no service gets the generic database icon.
  const AWS_CAT = { compute: '#ED7100', storage: '#7AA116', database: '#C925D1', integration: '#E7157B', analytics: '#8C4FFF', network: '#8C4FFF', mgmt: '#E7157B' };
  const W = 'fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';
  const AWS = {
    lambda: ['Lambda function', 'compute', `<path ${W} d="M8.2 5.5h3.1l5.2 13h-2.6l-1.5-3.8-2.9 3.8H6.8l4.3-5.6-1.6-4.2H8.2Z"/>`],
    ecs: ['Container (ECS)', 'compute', `<path ${W} d="M12 5.5 18 9v6l-6 3.5L6 15V9Z M12 12.4 18 9 M12 12.4 6 9 M12 12.4v6.1"/>`],
    ec2: ['EC2 instance', 'compute', `<rect ${W} x="7.5" y="7.5" width="9" height="9" rx="1"/><path ${W} d="M10 5v2.5M14 5v2.5M10 16.5V19M14 16.5V19M5 10h2.5M5 14h2.5M16.5 10H19M16.5 14H19"/>`],
    kinesis: ['Kinesis stream', 'analytics', `<path ${W} d="M5.5 8.5c2.2-1.6 4.3 1.6 6.5 0s4.3 1.6 6.5 0M5.5 12c2.2-1.6 4.3 1.6 6.5 0s4.3 1.6 6.5 0M5.5 15.5c2.2-1.6 4.3 1.6 6.5 0s4.3 1.6 6.5 0"/>`],
    firehose: ['Data Firehose', 'analytics', `<path ${W} d="M5.5 9h9M5.5 12h11M5.5 15h9M15 7l3.5 5-3.5 5"/>`],
    redshift: ['Redshift', 'analytics', `<path ${W} d="M6 17.5V10M10 17.5V7M14 17.5v-6M18 17.5V8.5M5 17.5h14"/>`],
    athena: ['Athena', 'analytics', `<circle ${W} cx="11" cy="11" r="4.6"/><path ${W} d="m14.4 14.4 4 4"/>`],
    glue: ['Glue job', 'analytics', `<path ${W} d="M6 8.5h5v3H6ZM13 12.5h5v3h-5ZM11 10h2.2v4H13"/>`],
    sns: ['SNS topic', 'integration', `<circle cx="12" cy="12" r="1.7" fill="#fff"/><path ${W} d="M8.6 8.6a4.8 4.8 0 0 0 0 6.8M15.4 8.6a4.8 4.8 0 0 1 0 6.8M6.3 6.3a8 8 0 0 0 0 11.4M17.7 6.3a8 8 0 0 1 0 11.4"/>`],
    sqs: ['SQS queue', 'integration', `<rect ${W} x="5.5" y="8" width="13" height="8" rx="1"/><path ${W} d="M8.5 8v8M11.5 8v8M14.5 8v8"/>`],
    eventbridge: ['EventBridge', 'integration', `<circle ${W} cx="7" cy="12" r="1.8"/><circle ${W} cx="17" cy="7.5" r="1.8"/><circle ${W} cx="17" cy="16.5" r="1.8"/><path ${W} d="M8.7 11.2 15.3 8.3M8.7 12.8l6.6 2.9"/>`],
    stepfunctions: ['Step Functions', 'integration', `<rect ${W} x="9" y="5" width="6" height="3.6" rx=".8"/><rect ${W} x="5" y="15.4" width="6" height="3.6" rx=".8"/><rect ${W} x="13" y="15.4" width="6" height="3.6" rx=".8"/><path ${W} d="M12 8.6v3.4M8 15.4V12h8v3.4"/>`],
    apigateway: ['API Gateway', 'network', `<path ${W} d="M9.5 7.5 5.5 12l4 4.5M14.5 7.5l4 4.5-4 4.5M12.8 6.5l-1.6 11"/>`],
    dynamodb: ['DynamoDB table', 'database', `<ellipse ${W} cx="12" cy="7.5" rx="5.5" ry="2"/><path ${W} d="M6.5 7.5v9c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2v-9M6.5 12c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2"/><path d="m14.3 10.6 1.9-.6-.9 1.7" fill="#fff"/>`],
    rds: ['RDS database', 'database', `<ellipse ${W} cx="12" cy="7.5" rx="5.5" ry="2"/><path ${W} d="M6.5 7.5v9c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2v-9M6.5 12c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2"/>`],
    database: ['Database / store', 'database', `<ellipse ${W} cx="12" cy="7.5" rx="5.5" ry="2"/><path ${W} d="M6.5 7.5v9c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2v-9M6.5 12c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2"/>`],
    s3: ['S3 bucket', 'storage', `<path ${W} d="M5.5 8c0-1.2 2.9-2.2 6.5-2.2s6.5 1 6.5 2.2l-1.6 9.4c0 .9-2.2 1.6-4.9 1.6s-4.9-.7-4.9-1.6Z M5.5 8c0 1.2 2.9 2.2 6.5 2.2s6.5-1 6.5-2.2"/>`],
    cloudwatch: ['CloudWatch', 'mgmt', `<path ${W} d="M5.5 16.5a6.5 6.5 0 0 1 13 0M12 16.5l3-4.5M5.5 16.5h13"/>`],
    appconfig: ['AppConfig', 'mgmt', `<path ${W} d="M7 8h10M7 12h10M7 16h10"/><circle cx="10" cy="8" r="1.5" fill="#fff"/><circle cx="15" cy="12" r="1.5" fill="#fff"/><circle cx="9" cy="16" r="1.5" fill="#fff"/>`],
  };
  const AWS_MATCH = [
    [/\bstep ?functions?\b|\bsfn\b|state machine/i, 'stepfunctions'], [/\blambdas?\b/i, 'lambda'], [/\bfirehose\b/i, 'firehose'],
    [/\bkinesis\b|\bkds\b/i, 'kinesis'], [/\bsns\b|\btopic\b/i, 'sns'], [/\bsqs\b|queue\b|\bdlq\b/i, 'sqs'], [/\bevent ?bridge\b|\bevent bus\b/i, 'eventbridge'],
    [/\bapi ?gateway\b|\bapigw\b/i, 'apigateway'], [/\bdynamo(db)?\b|\bddb\b/i, 'dynamodb'], [/\bs3\b|\bbucket\b/i, 's3'], [/\bcloudwatch\b/i, 'cloudwatch'],
    [/\bappconfig\b/i, 'appconfig'], [/\bredshift\b/i, 'redshift'], [/\bathena\b/i, 'athena'], [/\bglue\b/i, 'glue'], [/\b(rds|aurora|postgres(ql)?|mysql)\b/i, 'rds'],
    [/\b(ecs|fargate|eks)\b/i, 'ecs'], [/\bec2\b/i, 'ec2'],
  ];
  const awsTile = (key, size = 24) => `<rect width="24" height="24" rx="4.5" fill="${AWS_CAT[AWS[key][1]]}" stroke="none"/>${AWS[key][2]}`;
  const awsSvg = (key, px) => `<svg class="g aws" viewBox="0 0 24 24" width="${px}" height="${px}" aria-hidden="true">${awsTile(key)}</svg>`;
  function awsKey(n) {
    const t = String(n.label || '').replace(/<br\s*\/?>/gi, ' ');
    for (const [re, k] of AWS_MATCH) if (re.test(t)) return k;
    return n.shape === 'database' ? 'database' : null;
  }
  // Flowchart source + the parsed node list -> source with one "id@{ icon: ... }" line per AWS node (mermaid keeps the
  // label from the node's first definition), and the services used, for the legend.
  function withAws(src, a) {
    if (!(a.kind === 'flowchart' || a.kind === 'graph') || !Array.isArray(a.nodeList) || localStorage.getItem('mdr-dg-aws') === 'off') return { src, used: [], iconed: new Set() };
    const extra = [], used = [], iconed = new Set();
    const keys = new Map(a.nodeList.map((n) => [n.id, awsKey(n)]));
    // a cylinder alone is just "a database"; only an AWS diagram (one that names a real service) gets the AWS look
    if (![...keys.values()].some((k) => k && k !== 'database')) return { src, used: [], iconed: new Set() };
    for (const n of a.nodeList) {
      const k = keys.get(n.id); if (!k || !/^[\w-]+$/.test(n.id)) continue;
      const label = String(n.label || n.id).replace(/"/g, '#quot;');
      extra.push(`  ${n.id}@{ icon: "aws:${k}", pos: "b", h: 44, label: "${label}" }`);
      iconed.add(n.id);
      if (!used.includes(k)) used.push(k);
    }
    return extra.length ? { src: src + '\n' + extra.join('\n'), used, iconed } : { src, used, iconed };
  }
  let awsRegistered = false;
  function registerAws(m) {
    if (awsRegistered || typeof m.registerIconPacks !== 'function') return;
    const icons = {}; for (const k of Object.keys(AWS)) icons[k] = { body: awsTile(k) };
    m.registerIconPacks([{ name: 'aws', icons: { prefix: 'aws', width: 24, height: 24, icons } }]);
    awsRegistered = true;
  }

  function legendEl(a) {
    if (!a.legend.length && !a.hover) return null;
    const el = h('div', { class: 'dglegend', title: 'How to read this diagram' });
    el.append(h('span', { class: 'lgt' }, 'How to read'));
    a.legend.forEach((it) => el.append(h('span', { class: 'lg' + (it.aws ? ' lg-aws' : ''), html: (it.html || GLYPH[it.glyph] || '') + `<span>${esc(it.name)}</span>` })));
    if (a.hover) el.append(h('span', { class: 'lg hint' }, a.hover));
    el.append(h('button', { type: 'button', class: 'lgx', title: 'Hide the legend (click the dots to bring it back)' }, '✕'));
    return el;
  }

  // ---------- drawing: mermaid in the reader's colours ----------
  // Every theme sets --dg-* colours on <html> (core/shell.css); mermaid wants hex, so they are read from the computed
  // style and poured into its "base" theme. Re-done whenever data-theme changes (observer below).
  const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  // --dg-font is usually itself a var() (Lumen: var(--sans)); resolve it through a probe element so mermaid measures
  // labels in the same font the CSS draws them in -- measuring in the body serif clipped labels drawn in Inter.
  const fontOf = () => {
    const b = getComputedStyle(document.body);
    const p = document.createElement('span'); p.style.cssText = 'position:absolute;visibility:hidden;font-family:var(--dg-font)'; document.body.append(p);
    const f = getComputedStyle(p).fontFamily; p.remove();
    return f || b.fontFamily || 'system-ui';
  };
  function palette() {
    const v = (n, d) => cssVar(n) || d;
    const node = v('--dg-node', '#f1eadf'), border = v('--dg-border', '#cdbfae'), text = v('--dg-text', '#2b2622'), line = v('--dg-line', '#8d837a'), accent = v('--dg-accent', '#b0552f');
    const alt = v('--dg-alt', node), cluster = v('--dg-cluster', '#f3eee6'), clusterB = v('--dg-cluster-border', border), bg = v('--dg-bg', '#ffffff'), note = v('--dg-note', '#f6ead9'), noteB = v('--dg-note-border', '#e4cfb3'), soft = v('--dg-soft', alt);
    const pies = (v('--dg-pies', '') || '').split(/\s*,\s*/).filter(Boolean);
    const dark = v('--dg-dark', '0') === '1';
    const tv = {
      fontFamily: fontOf(), fontSize: '14px', darkMode: dark, background: bg,
      primaryColor: node, primaryTextColor: text, primaryBorderColor: border, secondaryColor: alt, secondaryBorderColor: border, secondaryTextColor: text,
      tertiaryColor: cluster, tertiaryBorderColor: clusterB, tertiaryTextColor: text, lineColor: line, textColor: text, mainBkg: node, nodeBorder: border,
      clusterBkg: cluster, clusterBorder: clusterB, titleColor: text, edgeLabelBackground: bg, nodeTextColor: text, defaultLinkColor: line, arrowheadColor: line,
      // sequence
      actorBkg: node, actorBorder: border, actorTextColor: text, actorLineColor: border, signalColor: line, signalTextColor: text, labelBoxBkgColor: cluster, labelBoxBorderColor: clusterB,
      labelTextColor: text, loopTextColor: text, noteBkgColor: note, noteBorderColor: noteB, noteTextColor: text, activationBkgColor: soft, activationBorderColor: border, sequenceNumberColor: bg,
      // state / class / er
      labelColor: text, altBackground: cluster, classText: text, attributeBackgroundColorOdd: bg, attributeBackgroundColorEven: cluster, transitionColor: line, transitionLabelColor: text, stateLabelColor: text, stateBkg: node, compositeBackground: cluster, compositeTitleBackground: cluster, compositeBorder: clusterB, specialStateColor: line, innerEndBackground: line,
      // gantt
      sectionBkgColor: cluster, altSectionBkgColor: bg, sectionBkgColor2: cluster, taskBkgColor: soft, taskBorderColor: border, taskTextColor: text, taskTextDarkColor: text, taskTextLightColor: text, taskTextOutsideColor: text, taskTextClickableColor: accent,
      activeTaskBkgColor: accent, activeTaskBorderColor: accent, doneTaskBkgColor: alt, doneTaskBorderColor: border, critBkgColor: v('--dg-crit', '#e8b4a8'), critBorderColor: v('--dg-crit-border', '#c1392b'), gridColor: clusterB, todayLineColor: accent, excludeBkgColor: cluster,
      // pie / git / misc
      pieTitleTextColor: text, pieSectionTextColor: text, pieLegendTextColor: text, pieStrokeColor: bg, pieOuterStrokeColor: border, pieStrokeWidth: '1px', pieOpacity: '0.9',
      git0: accent, git1: line, git2: border, git3: soft, commitLabelColor: text, commitLabelBackground: cluster, tagLabelColor: text, tagLabelBackground: note, tagLabelBorder: noteB, gitBranchLabel0: text,
      quadrant1Fill: cluster, quadrant2Fill: bg, quadrant3Fill: bg, quadrant4Fill: cluster, quadrantPointFill: accent, quadrantPointTextFill: text, quadrantXAxisTextFill: text, quadrantYAxisTextFill: text, quadrantTitleFill: text,
      cScale0: node, cScale1: alt, cScale2: cluster, cScaleLabel0: text, cScaleLabel1: text, cScaleLabel2: text,
      xyChart: { backgroundColor: bg, titleColor: text, xAxisLabelColor: text, xAxisTitleColor: text, xAxisTickColor: line, xAxisLineColor: line, yAxisLabelColor: text, yAxisTitleColor: text, yAxisTickColor: line, yAxisLineColor: line, plotColorPalette: pies.join(',') || accent },
    };
    pies.forEach((c, i) => { tv['pie' + (i + 1)] = c; });
    return { tv, dark };
  }
  const CFG = () => ({
    startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, theme: 'base', themeVariables: palette().tv, fontFamily: fontOf(),
    flowchart: { curve: 'basis', htmlLabels: true, padding: 10, nodeSpacing: 40, rankSpacing: 50, useMaxWidth: true },
    sequence: { mirrorActors: false, actorMargin: 60, messageMargin: 38, boxMargin: 8, noteMargin: 10, useMaxWidth: true, rightAngles: false },
    state: { useMaxWidth: true }, class: { useMaxWidth: true, htmlLabels: true }, er: { useMaxWidth: true }, gantt: { useMaxWidth: true, useWidth: 760, barHeight: 24, fontSize: 13, sectionFontSize: 13, barGap: 6, topPadding: 48, leftPadding: 90 }, pie: { useMaxWidth: true, textPosition: 0.7 },
    mindmap: { useMaxWidth: true }, timeline: { useMaxWidth: true }, gitGraph: { useMaxWidth: true, showCommitLabel: true },
  });
  let lib = null, themedFor = null;
  function ensureLib() {
    if (global.mermaid) return Promise.resolve(global.mermaid);
    if (lib) return lib;
    lib = new Promise((res, rej) => {
      const src = SELF ? SELF.replace(/diagram\.js(\?.*)?$/, 'mermaid.min.js') : 'core/mermaid.min.js';
      const s = document.createElement('script'); s.src = src; s.onload = () => (global.mermaid ? res(global.mermaid) : rej(new Error('mermaid did not load'))); s.onerror = () => rej(new Error('could not load ' + src));
      document.head.append(s);
    });
    return lib;
  }
  async function engine() {
    const m = await ensureLib();
    const theme = document.documentElement.dataset.theme || '';
    if (themedFor !== theme) { m.initialize(CFG()); themedFor = theme; }
    registerAws(m);
    return m;
  }
  let seq = 0;
  const cache = new Map(); // text + theme -> svg string (split view repaints on every keystroke; unchanged diagrams must be free)
  async function draw(text) {
    const m = await engine();
    const key = (document.documentElement.dataset.theme || '') + '\n' + text;
    if (cache.has(key)) return cache.get(key);
    // labels are measured once, at layout: if the web font is still loading they are sized for the fallback face and
    // the real one is then clipped at the end ('Manufacturec'). Wait for it first (no-op once loaded).
    try { if (document.fonts) await Promise.race([document.fonts.load('14px ' + fontOf()), new Promise((r) => setTimeout(r, 1500))]); } catch { /* best effort */ }
    const id = 'dg-' + (++seq) + '-' + Date.now().toString(36);
    const { svg } = await m.render(id, text);
    if (cache.size > 60) cache.delete(cache.keys().next().value);
    cache.set(key, svg);
    return svg;
  }

  // ---------- the card ----------
  // <div class="diagram" data-kind><div class="dgbar">kind · summary · [Source] [Copy] [⤢]</div><div class="dgv">svg</div>
  // <p class="dgsum">starts at …</p><div class="dglegend">…</div><pre class="code dgsrc" hidden>mermaid text</pre></div>
  function card(text, opts = {}) {
    const src = String(text).replace(/\r\n/g, '\n').replace(/\n$/, '');
    const a = analyse(src);
    const aws = withAws(src, a);
    if (aws.used.length) {
      // shapes now drawn only as icons drop out of the legend; the services used come first, in their own colours
      const left = new Set(a.nodeList.filter((n) => !aws.iconed.has(n.id)).map((n) => SHAPES[n.shape] && SHAPES[n.shape][0]));
      const shapeNames = new Set(Object.values(SHAPES).map((x) => x[0]));
      a.legend = [...aws.used.map((k) => ({ aws: true, html: awsSvg(k, 16), name: AWS[k][0] })), ...a.legend.filter((it) => !shapeNames.has(it.name) || left.has(it.name))];
    }
    const el = h('div', { class: 'diagram', 'data-kind': a.kind || 'unknown', 'data-label': a.label });
    const bar = h('div', { class: 'dgbar' },
      h('span', { class: 'kind', title: a.help || '' }, a.label),
      h('span', { class: 'sum' }, a.line),
      h('span', { class: 'sp' }),
      h('button', { type: 'button', class: 'srcb', title: 'Show the mermaid text under the diagram', 'aria-pressed': 'false' }, 'Source'),
      h('button', { type: 'button', class: 'copy', title: 'Copy the mermaid text' }, 'Copy'),
      h('button', { type: 'button', class: 'big', title: 'Open large (wheel to zoom, drag to pan, Esc to close)' }, '⤢'));
    const view = h('div', { class: 'dgv', 'aria-busy': 'true' }, h('div', { class: 'dgwait' }, 'Drawing…'));
    el.append(bar, view);
    if (a.line2) el.append(h('p', { class: 'dgsum' }, a.line2));
    const lg = legendEl(a);
    if (lg) {
      if (localStorage.getItem('mdr-dg-legend') === 'off') lg.classList.add('off');
      lg.querySelector('.lgx').addEventListener('click', (e) => { e.stopPropagation(); lg.classList.add('off'); localStorage.setItem('mdr-dg-legend', 'off'); toast(el, 'Legend hidden -- click the dots to bring it back'); });
      lg.addEventListener('click', () => { if (lg.classList.contains('off')) { lg.classList.remove('off'); localStorage.removeItem('mdr-dg-legend'); } });
      el.append(lg);
    }
    const code = h('code', { class: 'hl' });
    const pre = h('pre', { class: 'code dgsrc', hidden: '' }, code);
    const hl = global.HL ? HL.highlight(src, 'mermaid') : null;
    if (hl && hl.html !== null) code.innerHTML = hl.html; else code.textContent = src;
    if (a.lines >= 8) { el.classList.add('numbered'); el.style.setProperty('--gutter', String(a.lines).length + 'ch'); }
    el.append(pre);
    const srcb = bar.querySelector('.srcb');
    srcb.addEventListener('click', () => { const on = pre.hidden; pre.hidden = !on; srcb.setAttribute('aria-pressed', String(on)); srcb.textContent = on ? 'Hide source' : 'Source'; el.classList.toggle('with-src', on); });
    bar.querySelector('.copy').addEventListener('click', (e) => copyText(src, e.currentTarget, el));
    bar.querySelector('.big').addEventListener('click', () => openLarge(el, a));
    view.addEventListener('dblclick', () => openLarge(el, a));
    el._dg = { src, a, view, draw: aws.src };
    render(el);
    return el;
  }
  function copyText(text, btn, el) {
    const ok = () => { if (btn) { const was = btn.textContent; btn.textContent = 'Copied'; btn.classList.add('done'); setTimeout(() => { btn.textContent = was; btn.classList.remove('done'); }, 1400); } };
    const legacy = () => { const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.append(ta); ta.select(); let done = false; try { done = document.execCommand('copy'); } catch { /* refused */ } ta.remove(); done ? ok() : toast(el, 'Copy failed'); };
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(ok, legacy);
  }
  function toast(el, msg) { const t = h('div', { class: 'dgtoast' }, msg); el.append(t); setTimeout(() => t.remove(), 2600); }

  async function render(el) {
    const { src, a, view } = el._dg;
    let svg;
    try { svg = await draw(el._dg.draw || src); } catch (e) { return showError(el, e); }
    if (!el._dg || el._dg.src !== src) return; // card was re-pointed meanwhile
    view.innerHTML = svg; view.removeAttribute('aria-busy'); el.classList.remove('broken');
    const s = view.querySelector('svg');
    if (s) {
      s.removeAttribute('height'); s.style.maxWidth = s.style.maxWidth || '100%';
      // A wide diagram squeezed into the column becomes unreadable (a 16-step left-to-right flow ended up with ~6px
      // text). When fitting would shrink it below SHRINK_LIMIT, it is shown at MIN_SCALE instead and the card scrolls sideways.
      const vb = (s.getAttribute('viewBox') || '').split(/\s+/).map(Number), natural = vb[2] || 0;
      const room = view.clientWidth - 36;
      if (natural && room > 0 && room / natural < SHRINK_LIMIT) { s.style.width = Math.round(natural * MIN_SCALE) + 'px'; s.style.maxWidth = 'none'; el.classList.add('wide'); } else { s.style.width = ''; el.classList.remove('wide'); }
      wireHover(s, a.kind); el.dataset.state = 'drawn';
    }
  }
  // mermaid's messages read like "Parse error on line 3:\n...A -> B\n-----^\nExpecting 'SEMI', got 'TXT'". Show the line
  // number, the offending line with the caret, and a plain-words gloss; the source stays visible underneath.
  function showError(el, e) {
    const { src, view } = el._dg;
    const msg = String((e && (e.str || e.message)) || e || 'could not draw');
    const m = msg.match(/Parse error on line (\d+):\n([^\n]*)\n([^\n]*)/);
    const lines = src.split('\n');
    let where = '', snippet = null;
    if (m) {
      const n = Math.min(+m[1], lines.length); where = `line ${n}`;
      const caret = m[3].indexOf('^'); const shown = lines[n - 1] || m[2];
      snippet = h('pre', { class: 'dgerr-line' }, h('span', { class: 'ln' }, String(n)), shown, '\n', h('span', { class: 'ln' }, ''), ' '.repeat(Math.max(0, caret >= 0 ? Math.min(caret, shown.length) : shown.search(/\S|$/))), '^');
    }
    const TOK = { SQS: 'a “[”', SQE: 'a “]”', PS: 'a “(”', PE: 'a “)”', DIAMOND_START: 'a “{”', DIAMOND_STOP: 'a “}”', PIPE: 'a “|”', COLON: 'a “:”', SEMI: 'a “;”', NEWLINE: 'the end of the line', NL: 'the end of the line', EOF: 'the end of the text', TXT: 'text', STR: 'text', LINK: 'an arrow', ARROW_POINT: 'an arrow', START_LINK: 'an arrow', SPACE: 'a space', AMP: 'a “&”', MINUS: 'a “-”', TAGSTART: 'a “<”', TAGEND: 'a “>”', UP: 'a “^”', DOWN: 'a “v”', ALPHA: 'a word', NUM: 'a number', NODE_STRING: 'a name', DEFAULT: 'default', STYLE_SEPARATOR: 'a “:::”' };
    const gloss = (() => {
      const g = msg.match(/Expecting ([^\n]*?), got '([^']*)'/);
      if (g) { const got = TOK[g[2]] || (g[2] === g[2].toUpperCase() && /^[A-Z_]+$/.test(g[2]) ? 'an unexpected symbol' : `“${g[2]}”`); return `Found ${got} where mermaid expected something else -- usually a missing arrow, bracket or colon just before it.`; }
      if (/No diagram type detected|UnknownDiagramError/i.test(msg)) return 'The first line should name the diagram, e.g. “flowchart LR”, “sequenceDiagram” or “classDiagram”.';
      if (/Lexical error/i.test(msg)) return 'A character here is not allowed in this kind of diagram -- quotes around the label usually fix it.';
      return msg.split('\n')[0].slice(0, 160);
    })();
    view.replaceChildren(h('div', { class: 'dgerr' }, h('b', {}, `This diagram can’t be drawn yet${where ? ` -- ${where}` : ''}`), h('span', {}, gloss), snippet));
    view.removeAttribute('aria-busy'); el.classList.add('broken'); el.dataset.state = 'error';
    const pre = el.querySelector('pre.dgsrc'); if (pre) { pre.hidden = false; el.classList.add('with-src'); const b = el.querySelector('.srcb'); if (b) { b.textContent = 'Hide source'; b.setAttribute('aria-pressed', 'true'); } }
  }

  // ---------- hover: trace one step's arrows / one participant's messages ----------
  // Flowchart: node ids look like "flowchart-A-12", edge ids "L_A_B_0" (mermaid v11+); edges also carry LS-A / LE-B
  // classes. Sequence: actors and messages share no ids, so they are matched by x position (lifeline centre).
  function wireHover(svg, kind) {
    const k = kind === 'graph' ? 'flowchart' : kind;
    if (k === 'flowchart') return hoverFlow(svg);
    if (k === 'sequenceDiagram') return hoverSeq(svg);
  }
  const nodeId = (el) => { const m = (el.id || '').match(/flowchart-(.+)-\d+$/); return m ? m[1] : (el.dataset && el.dataset.id) || null; };
  function hoverFlow(svg) {
    const nodes = [...svg.querySelectorAll('g.node, g.icon-shape')].filter(nodeId); // AWS icon nodes are drawn as g.icon-shape
    const edges = [...svg.querySelectorAll('path.flowchart-link, path.transition')];
    if (nodes.length < 2 || !edges.length) return;
    const ids = new Set(nodes.map(nodeId));
    // edge ids are "<render id>-L_<from>_<to>_<n>"; node ids may themselves contain "_", so split where both halves are nodes
    const ends = (p) => {
      const id = p.id || ''; const at = id.indexOf('L_'); if (at < 0 || !/_\d+$/.test(id)) { const cl = [...p.classList]; const s = cl.find((c) => c.startsWith('LS-')), e = cl.find((c) => c.startsWith('LE-')); return s && e ? [s.slice(3), e.slice(3)] : null; }
      const rest = id.slice(at + 2).replace(/_\d+$/, '');
      for (const a of ids) if (rest.startsWith(a + '_') && ids.has(rest.slice(a.length + 1))) return [a, rest.slice(a.length + 1)];
      return null;
    };
    // edge labels carry no id: pair each with the edge whose midpoint it sits on
    const labels = [...svg.querySelectorAll('g.edgeLabel')].filter((l) => l.textContent.trim());
    const mid = (p) => { try { const L = p.getTotalLength(); const pt = p.getPointAtLength(L / 2); const m = p.getScreenCTM(); return m ? { x: m.a * pt.x + m.c * pt.y + m.e, y: m.b * pt.x + m.d * pt.y + m.f } : null; } catch { return null; } };
    const labelFor = (p) => { const c = mid(p); if (!c) return null; let best = null, bd = 60; labels.forEach((l) => { const r = l.getBoundingClientRect(); if (!r.width) return; const d = Math.hypot(r.left + r.width / 2 - c.x, r.top + r.height / 2 - c.y); if (d < bd) { bd = d; best = l; } }); return best; };
    const paths = edges.map((p) => ({ p, ab: ends(p), lab: null })).filter((x) => x.ab);
    if (!paths.length) return;
    let paired = false;
    const pair = () => { if (paired) return; paired = true; paths.forEach((x) => { x.lab = labelFor(x.p); }); };
    const clear = () => { svg.classList.remove('dg-trace'); svg.querySelectorAll('.dg-on').forEach((x) => x.classList.remove('dg-on')); };
    nodes.forEach((n) => {
      const id = nodeId(n);
      n.addEventListener('mouseenter', () => {
        pair(); clear(); svg.classList.add('dg-trace'); n.classList.add('dg-on');
        const near = new Set();
        paths.forEach(({ p, ab, lab }) => { if (ab[0] === id || ab[1] === id) { p.classList.add('dg-on'); if (lab) lab.classList.add('dg-on'); near.add(ab[0]); near.add(ab[1]); } });
        nodes.forEach((o) => { if (near.has(nodeId(o))) o.classList.add('dg-on'); });
      });
      n.addEventListener('mouseleave', clear);
    });
    svg.addEventListener('mouseleave', clear);
  }
  function hoverSeq(svg) {
    const rects = [...svg.querySelectorAll('rect.actor, rect.actor-top')].filter((r) => r.getAttribute('x') !== null);
    if (rects.length < 2) return;
    const centre = (r) => +r.getAttribute('x') + (+r.getAttribute('width') || 0) / 2;
    const actors = rects.map((r) => { const cx = centre(r); const g = r.closest('g') || r; const txt = [...svg.querySelectorAll('text.actor')].find((t) => Math.abs(+t.getAttribute('x') - cx) < 2); return { r, g, txt, cx }; });
    const lines = [...svg.querySelectorAll('line.messageLine0, line.messageLine1, path.messageLine0, path.messageLine1')];
    const texts = [...svg.querySelectorAll('text.messageText')];
    const nearest = (x) => actors.reduce((b, a) => (Math.abs(a.cx - x) < Math.abs(b.cx - x) ? a : b));
    const xOf = (ln) => {
      if (ln.tagName === 'line') return [+ln.getAttribute('x1'), +ln.getAttribute('x2')];
      const d = ln.getAttribute('d') || ''; const xs = [...d.matchAll(/[ML]\s*([\d.-]+)/g)].map((m) => +m[1]); return xs.length ? [xs[0], xs[xs.length - 1]] : null;
    };
    const msgs = lines.map((ln) => { const xs = xOf(ln); if (!xs) return null; const a = nearest(xs[0]), b = nearest(xs[1]); const y = +(ln.getAttribute('y1') || (ln.getAttribute('d') || '').match(/[ML]\s*[\d.-]+[ ,]([\d.-]+)/)?.[1] || 0); const t = texts.reduce((best, tx) => { const ty = +tx.getAttribute('y'); return ty <= y && (!best || ty > +best.getAttribute('y')) ? tx : best; }, null); return { ln, a, b, t }; }).filter(Boolean);
    if (!msgs.length) return;
    const clear = () => { svg.classList.remove('dg-trace'); svg.querySelectorAll('.dg-on').forEach((x) => x.classList.remove('dg-on')); };
    actors.forEach((a) => {
      const on = () => { clear(); svg.classList.add('dg-trace'); a.r.classList.add('dg-on'); if (a.txt) a.txt.classList.add('dg-on'); msgs.forEach((m) => { if (m.a === a || m.b === a) { m.ln.classList.add('dg-on'); if (m.t) m.t.classList.add('dg-on'); m.a.r.classList.add('dg-on'); m.b.r.classList.add('dg-on'); if (m.a.txt) m.a.txt.classList.add('dg-on'); if (m.b.txt) m.b.txt.classList.add('dg-on'); } }); };
      a.r.addEventListener('mouseenter', on); if (a.txt) a.txt.addEventListener('mouseenter', on);
      a.r.addEventListener('mouseleave', clear); if (a.txt) a.txt.addEventListener('mouseleave', clear);
    });
    svg.addEventListener('mouseleave', clear);
    svg.classList.add('dg-seq');
  }

  // ---------- large view ----------
  function openLarge(cardEl, a) {
    const s = cardEl.querySelector('.dgv svg'); if (!s) return;
    const clone = s.cloneNode(true); clone.removeAttribute('style'); clone.removeAttribute('width'); clone.removeAttribute('height');
    const vb = (clone.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number); const w0 = vb[2] || s.getBoundingClientRect().width || 800, h0 = vb[3] || s.getBoundingClientRect().height || 600;
    const stage = h('div', { class: 'dgstage' }, clone);
    const bar = h('div', { class: 'dgzbar' }, h('span', { class: 'kind' }, a.label), h('span', { class: 'sum' }, a.line), h('span', { class: 'sp' }), h('span', { class: 'pct' }, '100%'), h('button', { type: 'button', class: 'fit', title: 'Fit to window' }, 'Fit'), h('button', { type: 'button', class: 'one', title: 'Actual size' }, '1:1'), h('button', { type: 'button', class: 'x', title: 'Close (Esc)' }, '✕'));
    const ov = h('div', { class: 'dgzoom', role: 'dialog', 'aria-label': a.label + ', large view' }, bar, stage, h('div', { class: 'dgzhint' }, 'Scroll to zoom · drag to move · double-click to fit · Esc to close'));
    document.body.append(ov);
    let scale = 1, tx = 0, ty = 0;
    const apply = () => { clone.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`; bar.querySelector('.pct').textContent = Math.round(scale * 100) + '%'; };
    clone.style.width = w0 + 'px'; clone.style.height = h0 + 'px'; clone.style.transformOrigin = '0 0';
    const fit = () => { const r = stage.getBoundingClientRect(); scale = Math.min((r.width - 48) / w0, (r.height - 48) / h0, 2.5); if (!isFinite(scale) || scale <= 0) scale = 1; tx = (r.width - w0 * scale) / 2; ty = (r.height - h0 * scale) / 2; apply(); };
    const one = () => { const r = stage.getBoundingClientRect(); scale = 1; tx = Math.max(24, (r.width - w0) / 2); ty = Math.max(24, (r.height - h0) / 2); apply(); };
    stage.addEventListener('wheel', (e) => { e.preventDefault(); const r = stage.getBoundingClientRect(); const px = e.clientX - r.left, py = e.clientY - r.top; const f = Math.exp(-e.deltaY * 0.0015); const ns = Math.min(8, Math.max(0.1, scale * f)); const k = ns / scale; tx = px - (px - tx) * k; ty = py - (py - ty) * k; scale = ns; apply(); }, { passive: false });
    let drag = null;
    stage.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; drag = { x: e.clientX - tx, y: e.clientY - ty }; stage.setPointerCapture(e.pointerId); stage.classList.add('dragging'); });
    stage.addEventListener('pointermove', (e) => { if (!drag) return; tx = e.clientX - drag.x; ty = e.clientY - drag.y; apply(); });
    const up = () => { drag = null; stage.classList.remove('dragging'); };
    stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', up);
    stage.addEventListener('dblclick', fit);
    const close = () => { ov.remove(); document.removeEventListener('keydown', onKey, true); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } else if (e.key === '0') one(); else if (e.key === 'f' || e.key === 'F') fit(); };
    document.addEventListener('keydown', onKey, true);
    bar.querySelector('.x').addEventListener('click', close); bar.querySelector('.fit').addEventListener('click', fit); bar.querySelector('.one').addEventListener('click', one);
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    wireHover(clone, a.kind);
    requestAnimationFrame(fit);
    return ov;
  }

  // ---------- theme changes redraw every diagram on the page ----------
  new MutationObserver(() => { themedFor = null; document.querySelectorAll('.diagram').forEach((el) => { if (el._dg) render(el); }); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  // ---------- a .mmd / .mermaid file as a document ----------
  // One card, the file name as the title, the summary in the outline. Same shape as JV / SQLV .renderDoc.
  function renderDoc(text, opts = {}) {
    const name = opts.name || 'Diagram';
    const headEl = h('div', {});
    const id = 'diagram';
    const h1 = h('h1', { id }, name); headEl.append(h1);
    const el = card(text);
    const a = el._dg.a;
    headEl.append(h('p', { class: 'jmeta' }, `${a.label}${a.title ? ` · ${a.title}` : ''} · ${a.line} · ${plural(a.lines, 'line')}`));
    el.dataset.l0 = 0; el.dataset.l1 = a.lines;
    headEl.append(el);
    return { headEl, sectionEls: [], toc: [{ lvl: 1, id, text: name }], stats: { words: 0, minutes: 1, sections: 0, tables: 0 }, diagram: a };
  }

  global.DG = { kindOf, looksLike, label, help, analyse, legendEl, card, render, renderDoc, openLarge, palette, h, esc, GLYPH };
})(window);
