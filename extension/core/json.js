// JSON documents. A .json file (or an untitled tab holding JSON) is parsed and rendered as a readable document with
// the same shape md.js produces, so the shell, the outline, the section cards and the table filters all keep working:
//  - head: file name + a summary line (kind, size, keys/items) or, for broken JSON, the error with line:column and
//    the offending line shown
//  - ONE document renders as one continuous tree (a JSON value is one structure; it is never split into cards);
//    SEVERAL top-level values in one file ("// before {...} // after {...}", NDJSON) render as one section each,
//    titled by the comment above them
//  - comments (// and /* */) and same-line notes ("nextToken": null,  ← same) are kept and shown where they were
//  - arrays of flat objects render as a real table (union of keys as columns, numeric columns right-aligned), so
//    the per-column filters apply to them
//  - everything else is a collapsible tree (<details>), open three levels deep, with typed value colouring
// Also: format()/minify() rewrite the source text (keeping the comments), and looksLikeJson() lets an untitled paste
// be recognised.
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
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isScalar = (v) => v === null || typeof v !== 'object';
  const kindOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
  const fmtSize = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
  const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;

  // ---------- parsing ----------
  // Strict JSON.parse first (the common case, and fast). When that fails, a tolerant scanner accepts what people
  // actually paste into a reader:
  //  - `//` line comments and `/* */` block comments anywhere between tokens
  //  - a free-text note after a member on the same line: `"nextToken": null,   ← same` -- anything that starts with
  //    a character no JSON token can start with (arrows, dashes, #, (, *, ...) runs to the end of the line
  //  - several top-level values one after another (a "before" and an "after" payload; NDJSON), optionally separated
  //    by a comma
  // Comments are kept, attached to where they sat: on the same line as a member -> a note on that member; on their
  // own line -> the member that follows them (or, above a top-level value, that document's title); after the last
  // member of a container -> the end of that container. Nothing else is relaxed: trailing commas, single quotes and
  // unquoted keys still fail, with a line and column.
  // Annotations are keyed by the member's path, rooted at its document: pathKey([docKey(i), 'a', 0, 'b']) for members,
  // docKey(i) for the i-th document itself.
  const docKey = (i) => 'doc#' + i;
  const pathKey = (p) => JSON.stringify(p);
  const NOTE_START = /[^\sA-Za-z0-9"{}[\],:\-./]/;
  const emptyAnn = () => ({ notes: new Map(), before: new Map(), after: new Map(), any: false });
  function scan(text) {
    let i = 0; const n = text.length;
    const ann = emptyAnn(); const docs = [];
    let pending = [];           // own-line comments not attached yet
    let last = null, lastEnd = 0; // the member that most recently completed (or opened), for same-line attachment
    const fail = (why) => { throw { pos: i, why }; };
    const push = (map, k, s) => { ann.any = true; if (!map.has(k)) map.set(k, []); map.get(k).push(s); };
    const sameLine = () => last !== null && !text.slice(lastEnd, i).includes('\n');
    const comment = (raw) => {
      const lines = raw.split('\n').map((t) => t.replace(/^\s*\*\s?/, '').trim()).filter(Boolean);
      if (!lines.length) return;
      if (sameLine()) push(ann.notes, last, lines.join(' ')); else { ann.any = true; pending.push(...lines); }
    };
    const skip = () => {
      for (;;) {
        while (i < n && /[ \t\n\r]/.test(text[i])) i++;
        if (text[i] === '/' && text[i + 1] === '/') { const e = text.indexOf('\n', i); const end = e < 0 ? n : e; comment(text.slice(i + 2, end)); i = end; continue; }
        if (text[i] === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); if (e < 0) fail('unterminated comment'); comment(text.slice(i + 2, e)); i = e + 2; continue; }
        break;
      }
    };
    // `1,   ← same`: free text after a member on its line, starting with a character no JSON token starts with.
    const trailing = () => {
      let j = i; while (j < n && (text[j] === ' ' || text[j] === '\t')) j++;
      if (j < n && text[j] !== '\n' && text[j] !== '\r' && NOTE_START.test(text[j])) { const e = text.indexOf('\n', j); const end = e < 0 ? n : e; push(ann.notes, last, text.slice(j, end).trim()); i = end; }
    };
    const done = (pk) => { last = pk; lastEnd = i; trailing(); };
    const flushAfter = (pk) => { if (pending.length) { ann.any = true; ann.after.set(pk, (ann.after.get(pk) || []).concat(pending)); pending = []; } };
    const lead = (pk) => { if (pending.length) { ann.any = true; ann.before.set(pk, (ann.before.get(pk) || []).concat(pending)); pending = []; } };
    const str = () => {
      const s = i;
      if (text[i] !== '"') fail(text[i] === "'" ? 'single quotes are not JSON' : 'expected a string');
      for (i++; i < n; i++) {
        const c = text[i];
        if (c === '"') { i++; return JSON.parse(text.slice(s, i)); }
        if (c === '\\') { i++; if (text[i] === 'u') { if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 1, i + 5))) fail('bad \\u escape'); i += 4; } else if (!/["\\/bfnrt]/.test(text[i] || '')) fail('bad escape'); }
        else if (c < ' ') fail('control character in string');
      }
      fail('unterminated string');
    };
    const val = (path, pk) => {
      skip();
      const c = text[i];
      if (c === undefined) fail('unexpected end of input');
      if (c === '{') {
        i++; last = pk; lastEnd = i; const obj = {}; skip();
        if (text[i] === '}') { i++; flushAfter(pk); return obj; }
        for (;;) {
          skip();
          const k = str(); const p = path.concat(k), kp = pathKey(p); lead(kp);
          skip(); if (text[i] !== ':') fail("expected ':'"); i++;
          const v = val(p, kp); Object.defineProperty(obj, k, { value: v, enumerable: true, writable: true, configurable: true });
          done(kp); skip();
          if (text[i] === ',') { i++; done(kp); skip(); if (text[i] === '}') fail('trailing comma'); continue; }
          if (text[i] === '}') { i++; flushAfter(pk); return obj; }
          fail(text[i] === undefined ? 'unexpected end of input' : "expected ',' or '}'");
        }
      }
      if (c === '[') {
        i++; last = pk; lastEnd = i; const arr = []; skip();
        if (text[i] === ']') { i++; flushAfter(pk); return arr; }
        for (;;) {
          skip();
          const p = path.concat(arr.length), kp = pathKey(p); lead(kp);
          arr.push(val(p, kp)); done(kp); skip();
          if (text[i] === ',') { i++; done(kp); skip(); if (text[i] === ']') fail('trailing comma'); continue; }
          if (text[i] === ']') { i++; flushAfter(pk); return arr; }
          fail(text[i] === undefined ? 'unexpected end of input' : "expected ',' or ']'");
        }
      }
      if (c === '"') return str();
      const m = /^(-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?|true|false|null)(?![\w.])/.exec(text.slice(i, i + 64));
      if (m) { i += m[0].length; return JSON.parse(m[0]); }
      if (c === "'") fail('single quotes are not JSON');
      fail(`unexpected '${c}'`);
    };
    for (;;) {
      skip(); if (i >= n) break;
      if (text[i] === ',' && docs.length) { i++; continue; } // tolerate a comma between two top-level values
      const idx = docs.length, pk = docKey(idx);
      const leadLines = pending; pending = [];
      const value = val([pk], pk); done(pk);
      docs.push({ value, lead: leadLines, tail: [] });
    }
    if (!docs.length) { i = 0; fail(pending.length ? 'only comments, no JSON value' : 'unexpected end of input'); }
    if (pending.length) { docs[docs.length - 1].tail = pending; pending = []; }
    return { docs, ann };
  }
  function parse(text) {
    try { const value = JSON.parse(text); return { value, error: null, docs: [{ value, lead: [], tail: [] }], ann: emptyAnn() }; } catch (e0) {
      try { const { docs, ann } = scan(text); return { value: docs[0].value, error: null, docs, ann }; } catch (e) {
        if (!e || typeof e.pos !== 'number') return { value: undefined, error: { message: String(e && e.message || e), line: null, col: null, excerpt: null }, docs: [], ann: emptyAnn() };
        const before = text.slice(0, e.pos); const line = before.split('\n').length, col = e.pos - before.lastIndexOf('\n');
        return { value: undefined, error: { message: e.why, line, col, excerpt: text.split('\n')[line - 1] }, docs: [], ann: emptyAnn() };
      }
    }
  }
  // An untitled paste is JSON when every top-level value is an object or an array (comments allowed around them).
  const looksLikeJson = (text) => { const t = (text || '').trim(); if (!/^[[{/]/.test(t)) return false; const r = parse(t); return !r.error && r.docs.length > 0 && r.docs.every((d) => d.value !== null && typeof d.value === 'object'); };

  // Pretty text. With no annotations this is byte-for-byte JSON.stringify(value, null, indent); comments come back as
  // `// ...` lines where they sat and same-line notes as `// note` at the end of their member's first line.
  const noteTag = (ann, pk) => { const nt = ann.notes.get(pk); return nt && nt.length ? ' // ' + nt.join(' · ') : ''; };
  function emit(v, path, pk, lvl, ann, indent) {
    if (isScalar(v)) return JSON.stringify(v);
    const arr = Array.isArray(v); const entries = arr ? v.map((x, i) => [i, x]) : Object.entries(v);
    const pad = ' '.repeat(indent * (lvl + 1)), end = ' '.repeat(indent * lvl);
    const lines = [];
    entries.forEach(([k, x], idx) => {
      const p = path.concat(k), kp = pathKey(p);
      (ann.before.get(kp) || []).forEach((c) => lines.push(pad + '// ' + c));
      let body = emit(x, p, kp, lvl + 1, ann, indent); const tag = noteTag(ann, kp); const nl = body.indexOf('\n');
      if (tag && nl > 0) body = body.slice(0, nl) + tag + body.slice(nl); // container: note on its opening line
      lines.push(pad + (arr ? '' : JSON.stringify(k) + ': ') + body + (idx < entries.length - 1 ? ',' : '') + (tag && nl < 0 ? tag : ''));
    });
    (ann.after.get(pk) || []).forEach((c) => lines.push(pad + '// ' + c));
    if (!lines.length) return arr ? '[]' : '{}';
    return (arr ? '[' : '{') + '\n' + lines.join('\n') + '\n' + end + (arr ? ']' : '}');
  }
  function docText(d, i, ann, indent) {
    const pk = docKey(i); const out = d.lead.map((c) => '// ' + c);
    let body = emit(d.value, [pk], pk, 0, ann, indent); const tag = noteTag(ann, pk); const nl = body.indexOf('\n');
    out.push(tag && nl > 0 ? body.slice(0, nl) + tag + body.slice(nl) : body + tag);
    d.tail.forEach((c) => out.push('// ' + c));
    return out.join('\n') + '\n';
  }
  function format(text, indent = 2) { const r = parse(text); if (r.error) throw new Error(r.error.message); return r.docs.map((d, i) => docText(d, i, r.ann, indent)).join('\n'); }
  // One line per document. Comments above a document survive as `// ...` lines; notes inside a value cannot live on
  // one line without losing their place, so minify refuses rather than silently dropping them.
  function minify(text) {
    const r = parse(text); if (r.error) throw new Error(r.error.message);
    if (r.ann.notes.size || r.ann.before.size || r.ann.after.size) throw new Error('inline comments would be lost — use Format instead');
    return r.docs.map((d) => [...d.lead.map((c) => '// ' + c), JSON.stringify(d.value), ...d.tail.map((c) => '// ' + c)].join('\n')).join('\n');
  }

  // ---------- rendering ----------
  const URL_RE = /^https?:\/\/\S+$/i;
  const PATH_RE = /^(?:~|\/[A-Za-z0-9._-]+)(?:\/[^\s/]+)+\/?$/;
  function scalarEl(v) {
    if (v === null) return h('span', { class: 'jv jnull' }, 'null');
    if (typeof v === 'boolean') return h('span', { class: 'jv jbool' }, String(v));
    if (typeof v === 'number') return h('span', { class: 'jv jnum' }, Number.isInteger(v) ? v.toLocaleString() : String(v));
    const s = String(v);
    if (URL_RE.test(s)) return h('span', { class: 'jv jstr' }, '"', h('a', { href: s, target: '_blank', rel: 'noopener' }, s), '"');
    if (PATH_RE.test(s)) return h('span', { class: 'jv jstr' }, '"', h('a', { href: '#', class: 'path', 'data-path': s }, s), '"');
    return h('span', { class: 'jv jstr' }, JSON.stringify(s));
  }
  const summaryOf = (v) => (Array.isArray(v) ? `[ ${plural(v.length, 'item')} ]` : `{ ${plural(Object.keys(v).length, 'key')} }`);
  const noteEl = (ann, pk) => { const nt = ann.notes.get(pk); return nt && nt.length ? h('span', { class: 'jnote' }, nt.join(' · ')) : null; };
  const cmLines = (arr) => (arr || []).map((c) => h('div', { class: 'jl jcm' }, h('span', { class: 'jcmt' }, '// ' + c)));
  // Is anything annotated inside this container? (then it must render as a tree, a table has nowhere to show it)
  function annUnder(ann, path) {
    if (!ann.any) return false;
    const pre = pathKey(path).slice(0, -1) + ',';
    return [ann.notes, ann.before, ann.after].some((m) => [...m.keys()].some((k) => k.startsWith(pre)));
  }
  // Collapsible tree. `open` levels are expanded by default; beyond that nodes start collapsed but can be toggled.
  // An array of flat objects is shown as a table inside its node (with a fold to see it as a tree instead).
  // `ids` (top level only) gives each key line an id so the outline can jump to it. Comments above a member render
  // as dim `// ...` lines before it; a same-line note sits at the end of the member's line.
  function treeEl(v, depth, open, ids, path, pk, ann) {
    if (isScalar(v)) return h('div', { class: 'jl' }, scalarEl(v));
    const entries = Array.isArray(v) ? v.map((x, i) => [i, x]) : Object.entries(v);
    if (!entries.length) return h('div', { class: 'jl' }, h('span', { class: 'jv jempty' }, Array.isArray(v) ? '[ ]' : '{ }'));
    const kids = entries.map(([k, x]) => {
      const p = path.concat(k), kp = pathKey(p);
      const key = h('span', { class: Array.isArray(v) ? 'jk jidx' : 'jk' }, Array.isArray(v) ? String(k) : JSON.stringify(k));
      const id = ids ? ids(k) : null;
      const before = cmLines(ann.before.get(kp));
      if (isScalar(x)) return [...before, h('div', { class: 'jl', id }, key, h('span', { class: 'jc' }, ': '), scalarEl(x), noteEl(ann, kp))];
      const empty = Array.isArray(x) ? !x.length : !Object.keys(x).length;
      if (empty) return [...before, h('div', { class: 'jl', id }, key, h('span', { class: 'jc' }, ': '), h('span', { class: 'jv jempty' }, Array.isArray(x) ? '[ ]' : '{ }'), noteEl(ann, kp)), ...cmLines(ann.after.get(kp))];
      return [...before, h('details', { class: 'jn', id, open: depth + 1 < open ? '' : null }, h('summary', {}, key, h('span', { class: 'jc' }, ': '), h('span', { class: 'jsum' }, summaryOf(x)), noteEl(ann, kp)), ...valueBody(x, depth + 1, open, null, p, kp, ann))];
    });
    return h('div', { class: 'jt' }, ...kids.flat(), ...cmLines(ann.after.get(pk)));
  }
  // An array of objects whose values are all scalars (or short arrays of scalars) reads better as a table.
  function tabular(arr) {
    if (!Array.isArray(arr) || arr.length < 2 || arr.length > 5000) return null;
    if (!arr.every((x) => isObj(x) && Object.values(x).every((v) => isScalar(v) || (Array.isArray(v) && v.length <= 8 && v.every(isScalar))))) return null;
    const cols = []; const seen = new Set();
    arr.forEach((o) => Object.keys(o).forEach((k) => { if (!seen.has(k)) { seen.add(k); cols.push(k); } }));
    return cols.length && cols.length <= 40 ? cols : null;
  }
  const cellText = (v) => (v === undefined ? '' : v === null ? 'null' : Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(', ') : typeof v === 'string' ? v : String(v));
  function tableEl(arr, cols) {
    const table = h('table', { class: 'jtable' },
      h('thead', {}, h('tr', {}, h('th', { class: 'num jidxcol' }, '#'), ...cols.map((c) => h('th', {}, c)))),
      h('tbody', {}, ...arr.map((o, i) => h('tr', {}, h('td', { class: 'num jidxcol' }, String(i)), ...cols.map((c) => {
        const v = o[c];
        const td = h('td', {}, cellText(v));
        if (typeof v === 'number') td.classList.add('num');
        if (v === undefined) td.classList.add('jundef');
        return td;
      })))));
    // Column numeric if most present values are numbers (same 60% rule md.js uses).
    cols.forEach((c, ci) => {
      const vals = arr.map((o) => o[c]).filter((v) => v !== undefined && v !== null && v !== '');
      if (vals.length && vals.filter((v) => typeof v === 'number').length / vals.length >= 0.6) {
        table.tHead.rows[0].cells[ci + 1].classList.add('num');
        [...table.tBodies[0].rows].forEach((r) => r.cells[ci + 1].classList.add('num'));
      }
    });
    return h('div', { class: 'table-wrap' }, table);
  }
  function valueBody(v, depth, open, ids, path, pk, ann) {
    const cols = annUnder(ann, path) ? null : tabular(v);
    if (cols) return [tableEl(v, cols), h('details', { class: 'jn jraw' }, h('summary', {}, h('span', { class: 'jsum' }, 'as tree')), treeEl(v, depth, 1, null, path, pk, ann))];
    return [treeEl(v, depth, open, ids, path, pk, ann)];
  }
  const slug = (t) => String(t).toLowerCase().replace(/[^a-z0-9\u00C0-\uFFFF]+/g, '-').replace(/(^-|-$)/g, '') || 'key';
  const summaryLine = (v) => (isObj(v) ? `Object · ${plural(Object.keys(v).length, 'key')}` : Array.isArray(v) ? `Array · ${plural(v.length, 'item')}` : `${kindOf(v)} value`);
  const hasNested = (v) => !isScalar(v) && (Array.isArray(v) ? v : Object.values(v)).some((x) => !isScalar(x));

  // Same return shape as MD.renderDoc: { headEl, sectionEls, toc, stats, json: {value,error,docs} }. One JSON value is
  // ONE structure and renders as a single tree in the head (its top-level keys get ids and outline entries). A file
  // holding several top-level values renders one section per value, titled by the comment above it.
  function renderDoc(text, opts = {}) {
    const name = opts.name || 'JSON';
    const { value, error, docs, ann } = parse(text);
    const toc = []; const used = new Set();
    const uid = (t) => { let id = slug(t), n = 1; while (used.has(id)) id = slug(t) + '-' + (++n); used.add(id); return id; };
    const headEl = h('div', {});
    const h1 = h('h1', { id: uid(name) }, name); headEl.append(h1); toc.push({ lvl: 1, id: h1.id, text: name });
    const bytes = new TextEncoder().encode(text).length, lines = text.split('\n').length;
    const done = (sectionEls) => ({ headEl, sectionEls, toc, stats: { words: 0, minutes: 1, sections: sectionEls.length, tables: [headEl, ...sectionEls.map((s) => s.el)].reduce((n, el) => n + el.querySelectorAll('table').length, 0) }, json: { value, error, docs } });
    if (error) {
      const where = error.line ? ` at line ${error.line}${error.col ? `, column ${error.col}` : ''}` : '';
      headEl.append(h('p', { class: 'jerr' }, h('strong', {}, 'Invalid JSON'), `${where}: ${error.message}`));
      if (error.excerpt !== null && error.excerpt !== undefined) {
        const caret = error.col ? ' '.repeat(Math.max(0, error.col - 1)) + '^' : '';
        headEl.append(h('pre', { class: 'jexcerpt' }, h('code', {}, `${error.line}: ${error.excerpt}\n${' '.repeat(String(error.line).length + 2)}${caret}`)));
      }
      headEl.append(h('p', { class: 'jmeta' }, `${fmtSize(bytes)} · ${plural(lines, 'line')} · fix it in Edit mode (⌘E)`));
      headEl.append(h('pre', { class: 'jsource' }, h('code', {}, text)));
      return done([]);
    }
    const open = opts.open || 3;
    const nested = docs.some((d) => hasNested(d.value));
    const tools = () => (nested ? h('span', { class: 'jtools' }, ' · ', h('button', { class: 'jx', 'data-act': 'expand' }, 'Expand all'), ' · ', h('button', { class: 'jx', 'data-act': 'collapse' }, 'Collapse all')) : null);
    const comments = [...ann.notes.values(), ...ann.before.values(), ...ann.after.values()].reduce((n, a) => n + a.length, 0) + docs.reduce((n, d) => n + d.lead.length + d.tail.length, 0);
    const leadEl = (arr) => (arr.length ? h('p', { class: 'jlead' }, ...arr.map((c, i) => [i ? h('br') : null, c])) : null);
    const rootEl = (d, i, ids) => h('div', { class: 'jroot' }, ...(isScalar(d.value) ? [h('div', { class: 'jt' }, h('div', { class: 'jl' }, scalarEl(d.value), noteEl(ann, docKey(i))))] : valueBody(d.value, 0, open, ids, [docKey(i)], docKey(i), ann)), ...(d.tail.length ? [h('div', { class: 'jt' }, ...cmLines(d.tail))] : []));
    if (docs.length === 1) {
      const d = docs[0];
      const minified = text.trim().split('\n').length === 1 && bytes > 200;
      headEl.append(h('p', { class: 'jmeta' }, `${summaryLine(d.value)} · ${fmtSize(bytes)} · ${plural(lines, 'line')}${minified ? ' · minified — use Format to pretty-print' : ''}${comments ? ` · ${plural(comments, 'comment')}` : ''}`, isScalar(d.value) ? null : noteEl(ann, docKey(0)) && [' ', noteEl(ann, docKey(0))], tools()));
      if (d.lead.length) headEl.append(leadEl(d.lead));
      const ids = isObj(d.value) ? (k) => { const id = uid(k); toc.push({ lvl: 2, id, text: String(k) }); return id; } : null;
      headEl.append(rootEl(d, 0, ids));
      return done([]);
    }
    // several documents -> one section each, titled by the comment above it
    headEl.append(h('p', { class: 'jmeta' }, `${plural(docs.length, 'document')} · ${fmtSize(bytes)} · ${plural(lines, 'line')}${comments ? ` · ${plural(comments, 'comment')}` : ''}`, tools()));
    const sectionEls = docs.map((d, i) => {
      const title = d.lead[0] || `Document ${i + 1}`;
      const id = uid(title); toc.push({ lvl: 2, id, text: title });
      const el = h('div', {}, h('h2', { id }, h('span', { class: 'n' }, String(i + 1).padStart(2, '0')), h('span', { class: 't' }, title)));
      if (d.lead.length > 1) el.append(leadEl(d.lead.slice(1)));
      el.append(h('p', { class: 'jmeta' }, summaryLine(d.value), isScalar(d.value) ? null : noteEl(ann, docKey(i)) && [' ', noteEl(ann, docKey(i))]));
      const ids = isObj(d.value) && Object.keys(d.value).length <= 20 ? (k) => { const kid = uid(k); toc.push({ lvl: 3, id: kid, text: String(k) }); return kid; } : null;
      el.append(rootEl(d, i, ids));
      return { el, title, index: i, id };
    });
    return done(sectionEls);
  }
  // Strict, pretty-printed JSON of one document (the i-th; the only one by default), for a copy action.
  function sectionSource(text, i = 0) { const { docs, error } = parse(text); const d = docs[i] || docs[0]; return error || !d ? text : JSON.stringify(d.value, null, 2); }

  global.JV = { parse, looksLikeJson, format, minify, renderDoc, sectionSource };
})(window);
