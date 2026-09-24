// JSON documents. A .json file (or an untitled tab holding JSON) is parsed and rendered as a readable document with
// the same shape md.js produces, so the shell, the outline, the section cards and the table filters all keep working:
//  - head: file name + a summary line (kind, size, keys/items) or, for broken JSON, the error with line:column and
//    the offending line shown
//  - one section per top-level key of an object (top-level scalars are gathered into a leading "Properties" table);
//    a top-level array becomes one "Items" section
//  - arrays of flat objects render as a real table (union of keys as columns, numeric columns right-aligned), so
//    the per-column filters apply to them
//  - everything else is a collapsible tree (<details>), open two levels deep, with typed value colouring
// Also: format()/minify() rewrite the source text, and looksLikeJson() lets an untitled paste be recognised.
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

  // Parse with a useful error. V8's message sometimes carries a position, but often only a snippet, so on failure a
  // small validating scanner walks the text and reports where it first goes wrong.
  function locate(text) {
    let i = 0; const n = text.length;
    const ws = () => { while (i < n && /[ \t\n\r]/.test(text[i])) i++; };
    const fail = (why) => { throw { pos: i, why }; };
    const str = () => {
      if (text[i] !== '"') fail('expected a string');
      for (i++; i < n; i++) { const c = text[i]; if (c === '"') { i++; return; } if (c === '\\') { i++; if (text[i] === 'u') { if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 1, i + 5))) fail('bad \\u escape'); i += 4; } else if (!/["\\/bfnrt]/.test(text[i] || '')) fail('bad escape'); } else if (c < ' ') fail('control character in string'); }
      fail('unterminated string');
    };
    const val = () => {
      ws();
      const c = text[i];
      if (c === undefined) fail('unexpected end of input');
      if (c === '{') { i++; ws(); if (text[i] === '}') { i++; return; } for (;;) { ws(); str(); ws(); if (text[i] !== ':') fail("expected ':'"); i++; val(); ws(); if (text[i] === ',') { i++; ws(); if (text[i] === '}') fail('trailing comma'); continue; } if (text[i] === '}') { i++; return; } fail(text[i] === undefined ? 'unexpected end of input' : "expected ',' or '}'"); } }
      if (c === '[') { i++; ws(); if (text[i] === ']') { i++; return; } for (;;) { val(); ws(); if (text[i] === ',') { i++; ws(); if (text[i] === ']') fail('trailing comma'); continue; } if (text[i] === ']') { i++; return; } fail(text[i] === undefined ? 'unexpected end of input' : "expected ',' or ']'"); } }
      if (c === '"') return str();
      const m = /^(-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 64));
      if (m) { i += m[0].length; return; }
      if (c === "'") fail('single quotes are not JSON');
      fail(`unexpected '${c}'`);
    };
    try { val(); ws(); if (i < n) fail('unexpected text after the value'); return null; } catch (e) { return e && typeof e.pos === 'number' ? e : null; }
  }
  function parse(text) {
    try { return { value: JSON.parse(text), error: null }; } catch (e) {
      let msg = String(e && e.message || e).replace(/^JSON\.parse:\s*/, '');
      let pos = null, line = null, col = null;
      let m = /line (\d+) column (\d+)/i.exec(msg);
      if (m) { line = +m[1]; col = +m[2]; }
      else if ((m = /position (\d+)/i.exec(msg))) pos = +m[1];
      else { const loc = locate(text); if (loc) { pos = loc.pos; msg = loc.why; } }
      if (pos !== null) { const before = text.slice(0, pos); line = before.split('\n').length; col = pos - before.lastIndexOf('\n'); }
      const lines = text.split('\n');
      return { value: undefined, error: { message: msg, line, col, excerpt: line ? lines[line - 1] : null } };
    }
  }
  const looksLikeJson = (text) => { const t = (text || '').trim(); return /^[\[{]/.test(t) && /[\]}]$/.test(t) && !parse(t).error; };
  function format(text, indent = 2) { const { value, error } = parse(text); if (error) throw new Error(error.message); return JSON.stringify(value, null, indent) + '\n'; }
  function minify(text) { const { value, error } = parse(text); if (error) throw new Error(error.message); return JSON.stringify(value); }

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
  // Collapsible tree. `open` levels are expanded by default; beyond that nodes start collapsed but can be toggled.
  // An array of flat objects is shown as a table inside its node (with a fold to see it as a tree instead).
  // `ids` (top level only) gives each key line an id so the outline can jump to it.
  function treeEl(v, depth, open, ids) {
    if (isScalar(v)) return h('div', { class: 'jl' }, scalarEl(v));
    const entries = Array.isArray(v) ? v.map((x, i) => [i, x]) : Object.entries(v);
    if (!entries.length) return h('div', { class: 'jl' }, h('span', { class: 'jv jempty' }, Array.isArray(v) ? '[ ]' : '{ }'));
    const kids = entries.map(([k, x]) => {
      const key = h('span', { class: Array.isArray(v) ? 'jk jidx' : 'jk' }, Array.isArray(v) ? String(k) : JSON.stringify(k));
      const id = ids ? ids(k) : null;
      if (isScalar(x)) return h('div', { class: 'jl', id }, key, h('span', { class: 'jc' }, ': '), scalarEl(x));
      const empty = Array.isArray(x) ? !x.length : !Object.keys(x).length;
      if (empty) return h('div', { class: 'jl', id }, key, h('span', { class: 'jc' }, ': '), h('span', { class: 'jv jempty' }, Array.isArray(x) ? '[ ]' : '{ }'));
      return h('details', { class: 'jn', id, open: depth + 1 < open ? '' : null }, h('summary', {}, key, h('span', { class: 'jc' }, ': '), h('span', { class: 'jsum' }, summaryOf(x))), ...valueBody(x, depth + 1, open));
    });
    return h('div', { class: 'jt' }, ...kids);
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
  function valueBody(v, depth, open, ids) {
    const cols = tabular(v);
    if (cols) return [tableEl(v, cols), h('details', { class: 'jn jraw' }, h('summary', {}, h('span', { class: 'jsum' }, 'as tree')), treeEl(v, depth, 1))];
    return [treeEl(v, depth, open, ids)];
  }
  const slug = (t) => String(t).toLowerCase().replace(/[^a-z0-9\u00C0-\uFFFF]+/g, '-').replace(/(^-|-$)/g, '') || 'key';

  // Same return shape as MD.renderDoc: { headEl, sectionEls, toc, stats, json: {value,error} }. A JSON document is ONE
  // structure, so it is never split into sections: everything renders in the head as a single tree (the top-level
  // keys get ids and outline entries so you can still jump to them).
  function renderDoc(text, opts = {}) {
    const name = opts.name || 'JSON';
    const { value, error } = parse(text);
    const toc = []; const used = new Set();
    const uid = (t) => { let id = slug(t), n = 1; while (used.has(id)) id = slug(t) + '-' + (++n); used.add(id); return id; };
    const headEl = h('div', {});
    const h1 = h('h1', { id: uid(name) }, name); headEl.append(h1); toc.push({ lvl: 1, id: h1.id, text: name });
    const bytes = new TextEncoder().encode(text).length, lines = text.split('\n').length;
    const done = (tables) => ({ headEl, sectionEls: [], toc, stats: { words: 0, minutes: 1, sections: 0, tables }, json: { value, error } });
    if (error) {
      const where = error.line ? ` at line ${error.line}${error.col ? `, column ${error.col}` : ''}` : '';
      headEl.append(h('p', { class: 'jerr' }, h('strong', {}, 'Invalid JSON'), `${where}: ${error.message}`));
      if (error.excerpt !== null && error.excerpt !== undefined) {
        const caret = error.col ? ' '.repeat(Math.max(0, error.col - 1)) + '^' : '';
        headEl.append(h('pre', { class: 'jexcerpt' }, h('code', {}, `${error.line}: ${error.excerpt}\n${' '.repeat(String(error.line).length + 2)}${caret}`)));
      }
      headEl.append(h('p', { class: 'jmeta' }, `${fmtSize(bytes)} · ${plural(lines, 'line')} · fix it in Edit mode (⌘E)`));
      headEl.append(h('pre', { class: 'jsource' }, h('code', {}, text)));
      return done(0);
    }
    const open = opts.open || 3;
    const summary = isObj(value) ? `Object · ${plural(Object.keys(value).length, 'key')}` : Array.isArray(value) ? `Array · ${plural(value.length, 'item')}` : `${kindOf(value)} value`;
    const minified = text.trim().split('\n').length === 1 && bytes > 200;
    const nested = !isScalar(value) && (Array.isArray(value) ? value : Object.values(value)).some((x) => !isScalar(x));
    headEl.append(h('p', { class: 'jmeta' }, `${summary} · ${fmtSize(bytes)} · ${plural(lines, 'line')}${minified ? ' · minified — use Format to pretty-print' : ''}`,
      nested ? h('span', { class: 'jtools' }, ' · ', h('button', { class: 'jx', 'data-act': 'expand' }, 'Expand all'), ' · ', h('button', { class: 'jx', 'data-act': 'collapse' }, 'Collapse all')) : null));
    const ids = isObj(value) ? (k) => { const id = uid(k); toc.push({ lvl: 2, id, text: String(k) }); return id; } : null;
    const body = h('div', { class: 'jroot' }, ...(isScalar(value) ? [h('div', { class: 'jt' }, h('div', { class: 'jl' }, scalarEl(value)))] : valueBody(value, 0, open, ids)));
    headEl.append(body);
    return done(body.querySelectorAll('table').length);
  }
  // The pretty-printed JSON text, for a copy action.
  function sectionSource(text) { const { value, error } = parse(text); return error ? text : JSON.stringify(value, null, 2); }

  global.JV = { parse, looksLikeJson, format, minify, renderDoc, sectionSource };
})(window);
