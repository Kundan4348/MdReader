// MdReader SQL documents (shared by the app and the extension).
// A .sql file -- or an untitled tab whose pasted text is SQL -- renders through here instead of marked. The source is
// split into statements; each statement becomes a block with the comment above it as its title, a plain-English
// summary of what the query does (what it defines, reads, keeps, returns, groups and sorts by), and the code coloured
// BY ROLE rather than by token class: every clause keyword and the left edge of every line take the colour of the job
// that part of the query does (define / output / source / filter / shape / combine / write); each table alias gets its
// own hue, used where it is defined and on every `alias.column` that refers to it; comments are kept legible, not faded.
// Fenced ```sql blocks in markdown go through highlight() and get the same colouring (hl.js delegates here).
(function (global) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v; else if (k === 'html') el.innerHTML = v; else if (v !== null && v !== undefined) el.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k !== null && k !== undefined) el.append(k.nodeType ? k : document.createTextNode(k));
    return el;
  };
  const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
  const slug = (t) => String(t).toLowerCase().replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'x';

  // ---------- lexer ----------
  // token: { t: ws|cm|str|qid|num|word|op|punct|x, v: text, s: start offset, e: end offset, ln: first line (0-based), ln2: last line }
  const RX = [
    ['ws', /\s+/y], ['cm', /--[^\n]*/y], ['cm', /\/\*[\s\S]*?(?:\*\/|$)/y], ['cm', /#[^\n]*/y],
    ['str', /'(?:[^']|'')*'?/y], ['qid', /"(?:[^"]|"")*"?|`[^`\n]*`?/y],
    ['num', /(?<![\w.])(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?\b/iy], ['word', /[A-Za-z_][\w$]*/y],
    ['op', /::|<=>|<>|!=|<=|>=|\|\||->>|->|[-+*\/%<>=!&|^~?]/y], ['punct', /[(),;.:\[\]{}]/y],
  ];
  function lex(text) {
    const out = []; let i = 0, ln = 0;
    while (i < text.length) {
      let hit = null;
      for (const [t, re] of RX) { re.lastIndex = i; const m = re.exec(text); if (m && m.index === i && m[0].length) { hit = { t, v: m[0] }; break; } }
      if (!hit) hit = { t: 'x', v: text[i] };
      // a '#' comment only at line start or after whitespace (Hive); elsewhere it is just a character
      if (hit.t === 'cm' && hit.v[0] === '#' && i > 0 && !/\s/.test(text[i - 1])) hit = { t: 'x', v: '#' };
      const nl = (hit.v.match(/\n/g) || []).length;
      out.push({ t: hit.t, v: hit.v, s: i, e: i + hit.v.length, ln, ln2: ln + nl });
      ln += nl; i += hit.v.length;
    }
    return out;
  }

  // ---------- statements ----------
  const isCode = (tk) => tk.t !== 'ws' && tk.t !== 'cm';
  // Comment token -> its lines without the markers
  const cmLines = (tk) => (tk.v.startsWith('--') || tk.v.startsWith('#') ? [tk.v.replace(/^(--|#)\s?/, '')] : tk.v.replace(/^\/\*\s?|\s?\*\/$/g, '').split('\n').map((l) => l.replace(/^\s*\*?\s?/, ''))).map((l) => l.replace(/\s+$/, ''));
  // Leading comments grouped into blocks separated by blank lines: [{ lines, l0, l1 }]
  function groups(toks) {
    const out = []; let cur = null;
    for (const tk of toks) {
      if (tk.t === 'ws') { if ((tk.v.match(/\n/g) || []).length >= 2) cur = null; continue; }
      if (tk.t !== 'cm') continue;
      if (!cur) { cur = { lines: [], l0: tk.ln, l1: tk.ln2 + 1 }; out.push(cur); }
      cur.lines.push(...cmLines(tk)); cur.l1 = tk.ln2 + 1;
    }
    return out;
  }
  // parse(text) -> { statements: [{ lead: {lines,l0,l1}|null, title, desc, code: toks, tail: toks, l0, l1, s, e, a: analysis }], header: {lines,l0,l1}|null, lines }
  function parse(text) {
    const toks = lex(text);
    const chunks = []; let cur = [], depth = 0;
    for (const tk of toks) {
      cur.push(tk);
      if (tk.t === 'punct') { if (tk.v === '(') depth++; else if (tk.v === ')') depth = Math.max(0, depth - 1); else if (tk.v === ';' && depth === 0) { chunks.push(cur); cur = []; } }
    }
    if (cur.length) chunks.push(cur);
    const statements = []; let header = null; let trailing = [];
    chunks.forEach((ch) => {
      const i0 = ch.findIndex(isCode);
      if (i0 < 0) { trailing = ch; return; } // only comments / whitespace after the last ';'
      let lead = ch.slice(0, i0), code = ch.slice(i0);
      // a comment on the same line as the previous statement's ';' belongs to that statement, not to this one's title
      const prev = statements[statements.length - 1];
      if (prev) {
        const k = lead.findIndex((tk) => tk.ln > prev.l1 - 1 || (tk.t === 'ws' && tk.v.includes('\n')));
        const same = k < 0 ? lead : lead.slice(0, k);
        if (same.some((tk) => tk.t === 'cm')) { prev.tail = same.filter((tk) => tk.t === 'cm'); prev.code = prev.code.concat(same); prev.e = same[same.length - 1].e; lead = k < 0 ? [] : lead.slice(k); }
      }
      let gs = groups(lead);
      if (!statements.length && gs.length > 1) { header = { lines: gs.slice(0, -1).flatMap((g, i) => (i ? ['', ...g.lines] : g.lines)), l0: gs[0].l0, l1: gs[gs.length - 2].l1 }; gs = gs.slice(-1); }
      const lg = gs.length ? { lines: gs.flatMap((g, i) => (i ? ['', ...g.lines] : g.lines)), l0: gs[0].l0, l1: gs[gs.length - 1].l1 } : null;
      const st = { lead: lg, code, tail: [], l0: lg ? lg.l0 : code[0].ln, l1: code[code.length - 1].ln2 + 1, s: lg ? lead.find((t) => t.t === 'cm' && t.ln >= lg.l0).s : code[0].s, e: code[code.length - 1].e };
      st.title = lg && lg.lines[0] ? lg.lines[0] : '';
      st.desc = lg ? lg.lines.slice(1).filter((l, i, a) => l || (i && a[i - 1])) : [];
      statements.push(st);
    });
    if (trailing.length && !statements.length) { const gs = groups(trailing); if (gs.length) header = { lines: gs.flatMap((g, i) => (i ? ['', ...g.lines] : g.lines)), l0: gs[0].l0, l1: gs[gs.length - 1].l1 }; }
    const tailNote = trailing.length && statements.length ? groups(trailing) : [];
    statements.forEach((st) => { st.a = analyse(st.code, text); });
    return { statements, header, tailNote: tailNote.length ? { lines: tailNote.flatMap((g, i) => (i ? ['', ...g.lines] : g.lines)), l0: tailNote[0].l0, l1: tailNote[tailNote.length - 1].l1 } : null, lines: text.split('\n').length, toks };
  }

  // ---------- role analysis ----------
  // Clause keywords and the job they do. `by`, `join` lead-ins and `into`/`table` are folded into their clause.
  const CLAUSE = { with: 'define', select: 'output', returning: 'output', from: 'source', join: 'source', where: 'filter', having: 'filter', qualify: 'filter',
    group: 'shape', order: 'shape', limit: 'shape', offset: 'shape', fetch: 'shape', union: 'combine', except: 'combine', intersect: 'combine', minus: 'combine',
    insert: 'write', update: 'write', delete: 'write', create: 'write', drop: 'write', alter: 'write', merge: 'write', truncate: 'write', msck: 'write', grant: 'write', revoke: 'write',
    explain: 'shape', show: 'output', describe: 'output', desc_: 'output', analyze: 'write', vacuum: 'write', unload: 'write', copy: 'write' };
  const JOIN_PRE = new Set(['left', 'right', 'inner', 'outer', 'full', 'cross', 'natural', 'lateral', 'anti', 'semi']);
  const K2 = new Set(`as on using and or not in is null like ilike rlike similar between exists case when then else end distinct all any some asc desc nulls first last
    over partition rows range unbounded preceding following current row by into table view temp temporary if replace materialized recursive to set values external
    stored location partitioned tblproperties repair schema database column add primary key foreign references index unique default cast try_cast interval filter within
    only next escape collate cube rollup grouping sets tablesample ties window exclude unnest lateral ordinality with_ no data`.trim().split(/\s+/));
  const TYPES = new Set(`int integer bigint smallint tinyint varchar char character string text boolean bool double float real decimal numeric date timestamp timestamptz
    time datetime array map struct varbinary binary json uuid ipaddress hyperloglog super geometry`.trim().split(/\s+/));
  const CONST = new Set(['true', 'false', 'null', 'current_date', 'current_timestamp', 'current_time', 'localtime', 'localtimestamp', 'sysdate', 'getdate']);
  const HUES = 12;

  // analyse(code tokens, full text) -> { cls: Map(token -> class string), title: Map(token -> tooltip), lineRole: Map(line -> role), main: query summary,
  //   ctes: [{name, hue, q}], aliasHue: Map, tables: Set }
  function analyse(code, text) {
    // Two passes: aliases are declared in FROM but used in the SELECT list above it, so the first pass only learns
    // which aliases each query frame declares and the second colours every reference, including the early ones.
    const first = runAnalysis(code, text, new Map(), new Map());
    return runAnalysis(code, text, new Map(first.frames.map((f) => [f.open || 'base', f.aliases])), first.result.aliasHue).result;
  }
  function runAnalysis(code, text, seed, hues) {
    const cls = new Map(), title = new Map(), lineRole = new Map(); const frames = [];
    const aliasHue = new Map(hues), ctes = new Map(), tables = new Set();
    let hueN = hues.size;
    const hue = (name) => { const k = name.toLowerCase(); if (!aliasHue.has(k)) aliasHue.set(k, hueN++ % HUES); return aliasHue.get(k); };
    const toks = code.filter(isCode);
    const slice = (a, b) => text.slice(a.s, b.e).replace(/\s+/g, ' ').trim();
    // frames: one per paren level; a frame that sees SELECT is a query and collects a summary
    const newQ = (open) => { const q = { open: open || null, clause: null, role: null, aliases: new Map(seed.get(open || 'base') || []), segs: [], sources: [], selects: 0, combine: null, write: null, lastJoin: '', expectTable: false, expectAlias: false, expectCte: false, cte: null, pendingCte: null }; frames.push(q); return q; };
    const base = newQ(); const stack = [base];
    const top = () => stack[stack.length - 1];
    const findAlias = (name) => { for (let i = stack.length - 1; i >= 0; i--) { const a = stack[i].aliases.get(name.toLowerCase()); if (a) return a; } return null; };
    const setLine = (tk, role) => { if (role && !lineRole.has(tk.ln)) lineRole.set(tk.ln, role); };
    const seg = (f, clause, tk) => { f.clause = clause; f.role = CLAUSE[clause] || f.role; f.segs.push({ clause, start: tk, toks: [] }); };
    const addSeg = (f, tk) => { const s = f.segs[f.segs.length - 1]; if (s) s.toks.push(tk); };
    const lower = (tk) => (tk && tk.t === 'word' ? tk.v.toLowerCase() : '');
    const isKw = (tk) => tk && tk.t === 'word' && (CLAUSE[lower(tk)] || K2.has(lower(tk)) || JOIN_PRE.has(lower(tk)) || CONST.has(lower(tk)));
    const chain = (i) => { // identifier chain a.b.c starting at i -> last index
      let j = i; while (toks[j + 1] && toks[j + 1].t === 'punct' && toks[j + 1].v === '.' && toks[j + 2] && (toks[j + 2].t === 'word' || toks[j + 2].t === 'qid' || (toks[j + 2].t === 'op' && toks[j + 2].v === '*'))) j += 2; return j;
    };
    const chainText = (i, j) => text.slice(toks[i].s, toks[j].e);
    for (let i = 0; i < toks.length; i++) {
      const tk = toks[i], f = top(), lw = lower(tk), prev = toks[i - 1], next = toks[i + 1];
      const ownLine = !prev || prev.ln < tk.ln || (prev.t === 'punct' && prev.ln === tk.ln && !lineRole.has(tk.ln));
      // ---- parens: subqueries, CTE bodies, function calls
      if (tk.t === 'punct' && tk.v === '(') {
        cls.set(tk, 'tk-p'); addSeg(f, tk);
        const q = newQ(tk); q.role = f.role;
        if (f.pendingCte) { q.cte = f.pendingCte; f.pendingCte = null; }
        if (f.expectTable) { f.expectTable = false; q.sub = true; }
        stack.push(q); continue;
      }
      if (tk.t === 'punct' && tk.v === ')') {
        cls.set(tk, 'tk-p');
        if (stack.length > 1) {
          const q = stack.pop(); const p = top(); addSeg(p, tk);
          if (q.cte) { const c = ctes.get(q.cte); if (c) c.q = q; }
          if (q.sub && (p.clause === 'from' || p.clause === 'join')) { p.expectAlias = true; p.sources.push({ table: '(subquery)', alias: null, join: p.lastJoin, sub: true }); }
          if (p.clause === 'with') p.expectCte = true;
        }
        continue;
      }
      if (tk.t === 'punct' && tk.v === ',') { cls.set(tk, 'tk-p'); addSeg(f, tk); if (f.clause === 'from' || f.clause === 'join') { f.expectTable = true; f.lastJoin = ''; } if (f.clause === 'with') f.expectCte = true; continue; }
      if (tk.t === 'punct' || tk.t === 'op' || tk.t === 'x') { cls.set(tk, tk.t === 'op' ? 'tk-o' : 'tk-p'); if (tk.v === ';') setLine(tk, f.role); else addSeg(f, tk); continue; }
      if (tk.t === 'str') { cls.set(tk, 'tk-s'); addSeg(f, tk); setLine(tk, f.role); continue; }
      if (tk.t === 'num') { cls.set(tk, 'tk-n'); addSeg(f, tk); setLine(tk, f.role); continue; }
      if (tk.t === 'qid') { cls.set(tk, f.expectTable ? 'tk-tbl' : 'tk-v'); addSeg(f, tk); setLine(tk, f.role); if (f.expectTable) { f.expectTable = false; f.expectAlias = true; f.sources.push({ table: tk.v, alias: null, join: f.lastJoin }); tables.add(tk.v); } continue; }
      // ---- words
      // multi-word clause heads: GROUP BY / ORDER BY / PARTITION BY, LEFT [OUTER] JOIN, INSERT INTO, CREATE TABLE, DELETE FROM, UNION ALL
      let role = null, clause = null;
      if (CLAUSE[lw] && !(lw === 'set' && f.clause !== 'update') && !(lw === 'copy' && f.segs.length)) {
        clause = lw; role = CLAUSE[lw];
        if (lw === 'join' && prev && JOIN_PRE.has(lower(prev))) { /* lead-ins already coloured */ }
        if (lw === 'desc_') clause = null;
      } else if (lw === 'by' && prev && ['group', 'order', 'partition', 'distribute', 'cluster', 'sort'].includes(lower(prev))) { cls.set(tk, 'tk-k tk-r-' + (lower(prev) === 'partition' ? 'shape' : f.role)); addSeg(f, tk); continue; }
      else if (lw === 'partition' && next && lower(next) === 'by') { cls.set(tk, 'tk-k tk-r-shape'); addSeg(f, tk); setLine(tk, f.role); continue; }
      else if (lw === 'over') { cls.set(tk, 'tk-k2 tk-r-shape'); addSeg(f, tk); setLine(tk, f.role); continue; }
      else if (JOIN_PRE.has(lw) && (lower(next) === 'join' || (JOIN_PRE.has(lower(next)) && lower(toks[i + 2]) === 'join'))) { cls.set(tk, 'tk-k tk-r-source'); addSeg(f, tk); setLine(tk, 'source'); f.lastJoin = lw; continue; }
      if (clause) {
        f.expectAlias = false; f.expectTable = false; f.expectCte = false;
        // UNION etc. keep the frame in query mode; INSERT/CREATE/UPDATE/DELETE open a write frame
        if (clause === 'union' || clause === 'except' || clause === 'intersect' || clause === 'minus') { f.combine = (f.combine || 0) + 1; f.combineKind = lw + (lower(next) === 'all' ? ' all' : ''); }
        if (clause === 'select') f.selects++;
        if (clause === 'join') { f.lastJoin = f.lastJoin || 'join'; }
        if (clause === 'from' || clause === 'join') { f.expectTable = true; if (clause === 'from') f.lastJoin = ''; }
        if (clause === 'with') f.expectCte = true;
        if (CLAUSE[clause] === 'write') f.write = f.write || { kind: lw, target: null };
        seg(f, clause, tk);
        cls.set(tk, 'tk-k tk-r-' + role); lineRole.set(tk.ln, ownLine || !lineRole.has(tk.ln) ? role : lineRole.get(tk.ln)); continue;
      }
      setLine(tk, f.role);
      // CTE names: WITH name AS ( ... ), name2 AS ( ... )
      if (f.expectCte && f.clause === 'with' && !isKw(tk) && lower(next) !== '.') {
        if (!(lw === 'recursive')) { const hn = hue(tk.v); ctes.set(tk.v.toLowerCase(), { name: tk.v, hue: hn, q: null, def: tk }); cls.set(tk, `tk-cte tk-def tk-h${hn}`); f.pendingCte = tk.v.toLowerCase(); f.expectCte = false; title.set(tk, `${tk.v}: a named result set defined here`); addSeg(f, tk); continue; }
      }
      // write targets: INSERT INTO t / CREATE TABLE t / UPDATE t / DELETE FROM t
      if (f.write && !f.write.target && !isKw(tk) && !(next && next.t === 'punct' && next.v === '(' && !['into', 'table', 'update'].includes(lower(prev)))) {
        if (['into', 'table', 'update', 'from', 'view', 'exists', 'replace', 'temp', 'temporary', 'if', 'not'].includes(lower(prev)) || f.write.kind === 'update' || f.write.kind === 'msck') {
          const j = chain(i); f.write.target = chainText(i, j); tables.add(f.write.target);
          for (let k = i; k <= j; k++) { cls.set(toks[k], toks[k].t === 'punct' ? 'tk-p' : 'tk-tbl'); addSeg(f, toks[k]); } i = j; continue;
        }
      }
      // table references after FROM / JOIN
      if (f.expectTable && !isKw(tk)) {
        const j = chain(i); const name = chainText(i, j); const key = name.toLowerCase();
        const c = ctes.get(key);
        const src = { table: name, alias: null, join: f.lastJoin, cte: !!c };
        f.sources.push(src); if (!c) tables.add(name);
        for (let k = i; k <= j; k++) { cls.set(toks[k], toks[k].t === 'punct' ? 'tk-p' : c ? `tk-cte tk-h${c.hue}` : 'tk-tbl'); addSeg(f, toks[k]); }
        if (c) title.set(tk, `${c.name}: defined above in WITH`);
        f.expectTable = false; f.expectAlias = true; i = j; continue;
      }
      if (f.expectAlias && !isKw(tk) && !(next && next.t === 'punct' && next.v === '(')) {
        const src = f.sources[f.sources.length - 1]; const hn = hue(tk.v);
        if (src) { src.alias = tk.v; f.aliases.set(tk.v.toLowerCase(), src); }
        cls.set(tk, `tk-al tk-def tk-h${hn}`); title.set(tk, `${tk.v} = ${src ? src.table : '?'}`); f.expectAlias = false; addSeg(f, tk); continue;
      }
      if (f.expectAlias && (lw === 'as')) { cls.set(tk, 'tk-k2 tk-r-' + f.role); addSeg(f, tk); continue; }
      if (f.expectAlias && isKw(tk)) f.expectAlias = false;
      // alias.column / cte.column
      if (next && next.t === 'punct' && next.v === '.' && !isKw(tk)) {
        const src = findAlias(tk.v); const c = ctes.get(lw);
        if (src || c) {
          const hn = src ? hue(src.alias) : c.hue;
          cls.set(tk, `tk-al tk-h${hn}`); title.set(tk, src ? `${src.alias} = ${src.table}` : `${c.name}: defined above in WITH`);
          const j = chain(i); for (let k = i; k <= j; k++) { if (k > i) cls.set(toks[k], toks[k].t === 'punct' ? 'tk-p' : toks[k].t === 'op' ? 'tk-o' : 'tk-col'); addSeg(f, toks[k]); } i = j; continue;
        }
      }
      // output names: SELECT ... AS name
      if (lw === 'as' && (f.clause === 'select' || f.clause === 'returning') && next && (next.t === 'word' || next.t === 'qid') && !isKw(next)) { cls.set(tk, 'tk-k2 tk-r-output'); cls.set(next, 'tk-out'); addSeg(f, tk); addSeg(f, next); i++; continue; }
      if (CONST.has(lw)) { cls.set(tk, 'tk-n'); addSeg(f, tk); continue; }
      if (TYPES.has(lw) && !(next && next.t === 'punct' && next.v === '.')) { cls.set(tk, 'tk-t'); addSeg(f, tk); continue; }
      if (K2.has(lw) || JOIN_PRE.has(lw)) { cls.set(tk, 'tk-k2 tk-r-' + (f.role || 'output')); addSeg(f, tk); continue; }
      if (next && next.t === 'punct' && next.v === '(') { cls.set(tk, 'tk-f'); addSeg(f, tk); continue; }
      cls.set(tk, 'tk-col'); addSeg(f, tk);
    }
    // comments: role 'note' for lines that are only a comment
    code.forEach((tk) => { if (tk.t === 'cm') { cls.set(tk, 'tk-c'); for (let l = tk.ln; l <= tk.ln2; l++) if (!lineRole.has(l)) lineRole.set(l, 'note'); } });
    return { frames, result: { cls, title, lineRole, main: summary(base, text), ctes: [...ctes.values()].map((c) => ({ name: c.name, hue: c.hue, q: c.q ? summary(c.q, text) : null })), aliasHue, tables } };
  }

  // ---------- what a query does, in plain words ----------
  const itemText = (toks, text) => (toks.length ? text.slice(toks[0].s, toks[toks.length - 1].e).replace(/\s+/g, ' ').trim() : '');
  function splitTop(toks, isSep) {
    const items = []; let cur = [], d = 0;
    for (const tk of toks) {
      if (tk.t === 'punct' && tk.v === '(') d++;
      if (tk.t === 'punct' && tk.v === ')') d--;
      if (d === 0 && isSep(tk)) { if (cur.length) items.push(cur); cur = []; continue; }
      cur.push(tk);
    }
    if (cur.length) items.push(cur); return items;
  }
  const lw = (tk) => (tk && tk.t === 'word' ? tk.v.toLowerCase() : '');
  function summary(q, text) {
    const segs = (c) => q.segs.filter((s) => s.clause === c).flatMap((s) => s.toks);
    const returns = splitTop(segs('select').filter((tk) => !(lw(tk) === 'distinct' || lw(tk) === 'all')), (tk) => tk.t === 'punct' && tk.v === ',').map((it) => {
      const k = it.findLastIndex((tk) => lw(tk) === 'as');
      if (k >= 0 && it[k + 1]) return it[k + 1].v;
      const last = it[it.length - 1];
      if (last.t === 'op' && last.v === '*') return it.length >= 3 && it[it.length - 2].v === '.' ? `all columns of ${it[it.length - 3].v}` : 'all columns';
      if ((last.t === 'word' || last.t === 'qid') && !(it.length >= 2 && it[it.length - 2].t === 'punct' && it[it.length - 2].v === ')')) return last.v;
      const t = itemText(it, text); return t.length > 48 ? t.slice(0, 45) + '…' : t;
    });
    const conds = (c) => { const toks = segs(c); const items = splitTop(toks, (tk) => lw(tk) === 'and' || lw(tk) === 'or'); const ops = toks.filter((tk) => lw(tk) === 'and' || lw(tk) === 'or').map((tk) => lw(tk)); return { items: items.map((it) => itemText(it, text)), ops }; };
    const list = (c) => splitTop(segs(c).filter((tk, i) => !(i === 0 && lw(tk) === 'by')), (tk) => tk.t === 'punct' && tk.v === ',').map((it) => itemText(it, text)).filter(Boolean);
    const limit = itemText(segs('limit').concat(segs('offset')), text);
    return { reads: q.sources, keeps: conds('where'), having: conds('having'), returns, groups: list('group'), sorts: list('order'), limit,
      combine: q.combine ? { n: q.selects, kind: q.combineKind } : null, write: q.write, selects: q.selects };
  }
  const SHORT = (s, n = 70) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const ctesTip = (s) => (s ? [s.reads.length ? 'reads ' + s.reads.map((r) => r.table + (r.alias ? ` (${r.alias})` : '')).join(', ') : '', s.keeps.items.length ? plural(s.keeps.items.length, 'condition') : '', s.returns.length ? plural(s.returns.length, 'column') : '', s.combine ? `${s.combine.kind} of ${s.combine.n} queries` : ''].filter(Boolean).join(' · ') : '');
  // The summary rows for one statement: [role, label, nodes...]
  function shapeEl(a, text) {
    const m = a.main; const rows = [];
    const chip = (cls, txt, tip) => h('code', { class: cls, title: tip || null }, txt);
    const cx = (t) => h('span', { class: 'cx' }, t);
    const many = (arr, lim, mk, sep) => { const out = []; arr.slice(0, lim).forEach((x, i) => { if (i) out.push(sep(i)); out.push(mk(x, i)); }); if (arr.length > lim) out.push(cx(` +${arr.length - lim} more`)); return out; };
    if (a.ctes.length) rows.push(['define', 'Defines', many(a.ctes, 12, (c) => chip(`tk-cte tk-h${c.hue}`, c.name, ctesTip(c.q)), () => cx(', ')), cx(a.ctes.length > 1 ? `  — ${a.ctes.length} named sets, used below` : '  — a named set, used below')]);
    if (m.write && m.write.target) rows.push(['write', { insert: 'Writes into', create: 'Creates', update: 'Updates', delete: 'Deletes from', drop: 'Drops', alter: 'Alters', merge: 'Merges into', truncate: 'Empties', msck: 'Repairs', copy: 'Loads into', unload: 'Unloads from' }[m.write.kind] || 'Writes to', chip('tk-tbl', m.write.target)]);
    if (m.reads.length) rows.push(['source', 'Reads from', m.reads.flatMap((r, i) => {
      const join = i === 0 ? null : r.join && r.join !== 'join' && r.join !== 'inner' ? cx(` ${r.join}-joined with `) : r.join ? cx(' joined with ') : cx(', ');
      const hn = r.alias ? a.aliasHue.get(r.alias.toLowerCase()) : null; const c = r.cte ? a.ctes.find((x) => x.name.toLowerCase() === r.table.toLowerCase()) : null;
      return [join, chip(c ? `tk-cte tk-h${c.hue}` : 'tk-tbl', r.table, c ? ctesTip(c.q) : null), r.alias ? cx(' as ') : null, r.alias ? chip(`tk-al tk-h${hn}`, r.alias, `${r.alias} = ${r.table}`) : null];
    })]);
    const condRow = (label, c) => rows.push(['filter', label, many(c.items, 5, (t) => chip('', SHORT(t)), (i) => cx(` ${c.ops[i - 1] || 'and'} `))]);
    if (m.keeps.items.length) condRow('Keeps rows where', m.keeps);
    if (m.groups.length) rows.push(['shape', 'Groups by', many(m.groups, 8, (t) => chip('', SHORT(t, 40)), () => cx(', '))]);
    if (m.having.items.length) condRow('Keeps groups where', m.having);
    if (m.returns.length) rows.push(['output', `Returns ${plural(m.returns.length, 'column')}`, many(m.returns, 10, (t) => chip('tk-out', t), () => cx(', '))]);
    if (m.sorts.length) rows.push(['shape', 'Sorts by', many(m.sorts, 6, (t) => chip('', SHORT(t, 40)), () => cx(', '))]);
    if (m.limit) rows.push(['shape', 'Only', chip('', m.limit.replace(/^limit\s+/i, '') + ' rows')]);
    if (m.combine) rows.push(['combine', 'Combines', cx(`${m.combine.kind} of ${plural(m.combine.n, 'query').replace('querys', 'queries')}`)]);
    if (!rows.length) return null;
    return h('div', { class: 'sqlsum' }, ...rows.map(([role, label, ...nodes]) => h('div', { class: 'sr sr-' + role }, h('span', { class: 'sl' }, label), h('span', { class: 'sv' }, ...nodes))));
  }

  // ---------- tokens -> HTML (one inline <span class="line"> per source line, DOM text == source) ----------
  function linesHtml(toks, a, firstLine, stamp) {
    const lines = ['']; const roles = []; let ln = firstLine;
    roles[0] = a.lineRole.get(ln) || '';
    const push = (text, cls, tip) => {
      text.split('\n').forEach((part, k) => {
        if (k) { lines.push(''); ln++; roles.push(a.lineRole.get(ln) || ''); }
        if (!part) return;
        let inner = esc(part);
        if (cls === 'tk-c' && /^(--|#)/.test(part)) inner = `<span class="tk-cm">${esc(part.match(/^(--|#)/)[0])}</span>${esc(part.slice(part.match(/^(--|#)/)[0].length))}`;
        lines[lines.length - 1] += cls ? `<span class="${cls}"${tip ? ` title="${esc(tip)}"` : ''}>${inner}</span>` : inner;
      });
    };
    toks.forEach((tk) => push(tk.v, tk.t === 'ws' ? null : a.cls.get(tk) || (tk.t === 'cm' ? 'tk-c' : null), a.title.get(tk)));
    if (lines.length > 1 && lines[lines.length - 1] === '') { lines.pop(); roles.pop(); }
    return lines.map((l, i) => `<span class="line"${roles[i] ? ` data-role="${roles[i]}"` : ''}${stamp ? ` data-l0="${firstLine + i}" data-l1="${firstLine + i + 1}"` : ''}>${l}${i < lines.length - 1 ? '\n' : ''}</span>`).join('');
  }
  const merged = (p) => {
    const a = { cls: new Map(), title: new Map(), lineRole: new Map() };
    p.statements.forEach((st) => { st.a.cls.forEach((v, k) => a.cls.set(k, v)); st.a.title.forEach((v, k) => a.title.set(k, v)); st.a.lineRole.forEach((v, k) => a.lineRole.set(k, v)); });
    p.toks.forEach((tk) => { if (tk.t === 'cm') for (let l = tk.ln; l <= tk.ln2; l++) if (!a.lineRole.has(l)) a.lineRole.set(l, 'note'); });
    return a;
  };
  // For fenced ```sql blocks (hl.js delegates here): same shape as HL.highlight's result.
  function highlight(code) {
    const src = String(code).replace(/\r\n/g, '\n');
    const p = parse(src);
    return { html: linesHtml(p.toks, merged(p), 0, false), lang: 'sql', lines: src.replace(/\n$/, '').split('\n').length };
  }
  // An untitled paste is SQL when, after leading comments, it opens with a statement keyword and has the shape of one:
  // a statement terminator, or `from <table>` followed by a clause or a line end (prose like "Select the file from
  // the list." has neither).
  function looksLikeSql(text) {
    const t = String(text || '').replace(/^(?:\s|--[^\n]*|\/\*[\s\S]*?\*\/)+/, '');
    if (!/^(with|select|insert|update|delete|create|alter|drop|merge|explain|show|describe|msck|grant|truncate|unload|copy|vacuum|analyze)\b/i.test(t)) return false;
    const bare = t.slice(0, 6000).replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '').replace(/'(?:[^']|'')*'/g, "''");
    if (/;\s*$/m.test(bare)) return true;
    const prose = /[.:]\s*$/m.test(bare.split('\n').slice(0, 3).join('\n'));
    if (/^(insert|update|delete|create|alter|drop|merge|truncate|msck|grant|unload|copy|vacuum|analyze)\b/i.test(t)) return !prose && (/\b(into|table|view|set|values|schema|database|index)\b/i.test(bare) || /^delete\s+from\s+[\w".`]+/i.test(t));
    return !prose && /\bfrom\s+[\w".`]+(?:\s+(?:as\s+)?\w+)?\s*(?:\n|$|\b(?:where|join|left|right|inner|full|cross|group|order|limit|having|union|on|using)\b)/i.test(bare);
  }

  // ---------- document ----------
  // Same return shape as MD.renderDoc / JV.renderDoc: { headEl, sectionEls, toc, stats, sql: { statements, tables, ctes, lines } }.
  // One statement renders in the head; several render one section each, titled by the comment above them.
  function renderDoc(text, opts = {}) {
    const name = opts.name || 'SQL';
    const p = parse(text);
    const toc = []; const used = new Set();
    const uid = (t) => { let id = slug(t), n = 1; while (used.has(id)) id = slug(t) + '-' + (++n); used.add(id); return id; };
    const headEl = h('div', {});
    const h1 = h('h1', { id: uid(name) }, name); headEl.append(h1); toc.push({ lvl: 1, id: h1.id, text: name });
    const tables = new Set(); let ctes = 0;
    p.statements.forEach((st) => { st.a.tables.forEach((t) => tables.add(t.toLowerCase())); ctes += st.a.ctes.length; });
    const comments = p.toks.filter((tk) => tk.t === 'cm').length;
    headEl.append(h('p', { class: 'jmeta' }, `${plural(p.statements.length, 'statement')} · ${plural(p.lines, 'line')} · ${plural(tables.size, 'table')}${ctes ? ` · ${plural(ctes, 'named set')}` : ''}${comments ? ` · ${plural(comments, 'comment')}` : ''}`));
    const noteEl = (blk, cls) => { const el = h('p', { class: cls || 'slead', 'data-l0': blk.l0, 'data-l1': blk.l1 }, ...blk.lines.map((l, i) => [i ? h('br') : null, l])); return el; };
    if (p.header) headEl.append(noteEl(p.header, 'shdr'));
    const blockEl = (st, i, titled) => {
      const el = h('div', { class: 'sqlst' });
      const ttl = st.title || `Statement ${i + 1}`; const id = uid(ttl);
      if (titled) { toc.push({ lvl: 2, id, text: ttl }); el.append(h('h2', { id, 'data-l0': st.l0, 'data-l1': st.l0 + 1 }, h('span', { class: 'n' }, String(i + 1).padStart(2, '0')), h('span', { class: 't' }, ttl))); }
      else if (st.title) { toc.push({ lvl: 2, id, text: ttl }); el.append(h('h2', { id, 'data-l0': st.l0, 'data-l1': st.l0 + 1 }, h('span', { class: 't' }, ttl))); }
      if (st.desc.length) el.append(noteEl({ lines: st.desc, l0: st.lead.l0 + 1, l1: st.lead.l1 }));
      const sh = shapeEl(st.a, text); if (sh) el.append(sh);
      const first = st.code[0].ln, last = st.code[st.code.length - 1].ln2, n = last - first + 1;
      const wrap = h('div', { class: 'codeblock sqlb numbered', 'data-lang': 'sql', 'data-label': 'SQL', 'data-l0': first, 'data-l1': last + 1, style: `--gutter:${String(last + 1).length}ch` });
      wrap.append(h('div', { class: 'codebar', html: `<span class="lang">SQL</span><span class="lc">${n === 1 ? '1 line' : `lines ${first + 1}–${last + 1}`}</span><button type="button" class="copy" title="Copy statement">Copy</button>` }));
      const codeEl = h('code', { class: 'hl sqlc', style: `counter-reset:ln ${first}`, html: linesHtml(st.code, st.a, first, true) });
      wrap.append(h('pre', { class: 'code' }, codeEl));
      el.append(wrap);
      return { el, id, title: ttl };
    };
    const done = (sectionEls) => ({ headEl, sectionEls, toc, stats: { words: 0, minutes: 1, sections: sectionEls.length, tables: 0 }, sql: { statements: p.statements.length, tables: tables.size, ctes, lines: p.lines } });
    if (!p.statements.length) { headEl.append(h('p', { class: 'jmeta' }, 'No SQL statements found')); return done([]); }
    if (p.statements.length === 1) {
      headEl.append(blockEl(p.statements[0], 0, false).el);
      if (p.tailNote) headEl.append(noteEl(p.tailNote));
      return done([]);
    }
    const sectionEls = p.statements.map((st, i) => { const b = blockEl(st, i, true); return { el: b.el, title: b.title, index: i, id: b.id }; });
    if (p.tailNote) sectionEls[sectionEls.length - 1].el.append(noteEl(p.tailNote));
    return done(sectionEls);
  }
  // Source of the i-th statement (its comment title included), for a copy action.
  function sectionSource(text, i = 0) { const { statements } = parse(text); const st = statements[i] || statements[0]; return st ? text.slice(st.s, st.e) : text; }

  global.SQLV = { parse, analyse, summary, highlight, looksLikeSql, renderDoc, sectionSource };
})(window);
