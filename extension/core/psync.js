// Text sync between a Markdown file and its Pippin doc (shared core; used by the desktop app).
// The two copies are never byte-equal: Pippin stores tables as HTML with ids on every cell, marks commented words
// with <!-- comment:ID --> markers, and re-writes some Markdown (`*x*` -> `_x_`, `@` -> `\@`, `---` -> `***`).
// So sync works paragraph by paragraph (a "block": a paragraph, list, heading, code fence or table), as a
// three-way merge against the last synced state of both copies (base = {local, remote}):
//   - blocks changed only here are sent to Pippin as targeted edits (comment markers and table cell ids kept),
//   - blocks changed only on Pippin are written into the file (tables come back as Markdown tables),
//   - a block changed on both sides is a conflict: nothing is applied until the user picks a side for it.
// Without a base (an existing doc linked for the first time) every block whose words differ is a conflict.
// plan() is pure: it returns the edits; the caller performs them.
(function (global) {
  'use strict';
  const MARK = /<!--\s*\/?comment:[\w-]+\s*-->/g;
  const strip = (s) => String(s || '').replace(MARK, '');
  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e.toLowerCase()] ?? m);

  // ---- blocks: [{s, e, raw}] with offsets into the text; blank lines separate blocks ----
  function blocks(text) {
    const out = [], lines = String(text).split('\n'); let off = 0; const starts = [];
    for (const l of lines) { starts.push(off); off += l.length + 1; }
    const end = (i) => starts[i] + lines[i].length;
    const fence = (l) => /^\s{0,3}(`{3,}|~{3,})/.exec(l);
    const isTable = (l) => /^\s*<table\b/i.test(l);
    for (let i = 0; i < lines.length;) {
      const l = lines[i];
      if (!l.trim()) { i++; continue; }
      let j = i; const f = fence(l);
      if (f) { j = i + 1; while (j < lines.length && !lines[j].trim().startsWith(f[1])) j++; if (j >= lines.length) j = lines.length - 1; }
      else if (isTable(l)) { while (j < lines.length - 1 && !/<\/table>/i.test(lines[j])) j++; }
      else { while (j + 1 < lines.length && lines[j + 1].trim() && !fence(lines[j + 1]) && !isTable(lines[j + 1])) j++; }
      // MdReader's hidden colour line sits directly under its table: keep it with the table
      out.push({ s: starts[i], e: end(j), raw: String(text).slice(starts[i], end(j)) });
      i = j + 1;
    }
    return out;
  }
  // the words of a block, for matching a block here with the same block on Pippin
  function key(raw) {
    const s = decode(strip(raw).replace(/<[^>]+>/g, ' ')).replace(/\\(.)/g, '$1');
    if (/^\s*([-*_]\s*){3,}$/.test(s)) return '<hr>';
    const k = s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    return k || s.replace(/\s+/g, '');
  }
  const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); };

  // longest common subsequence of two lists -> matched index pairs
  function lcs(a, b, eq) {
    const n = a.length, m = b.length; let p = 0; while (p < n && p < m && eq(a[p], b[p])) p++;
    let q = 0; while (q < n - p && q < m - p && eq(a[n - 1 - q], b[m - 1 - q])) q++;
    const A = a.slice(p, n - q), B = b.slice(p, m - q), N = A.length, M = B.length;
    const pairs = []; for (let i = 0; i < p; i++) pairs.push([i, i]);
    if (N && M) {
      const T = new Uint32Array((N + 1) * (M + 1));
      for (let i = N - 1; i >= 0; i--) for (let j = M - 1; j >= 0; j--) T[i * (M + 1) + j] = eq(A[i], B[j]) ? T[(i + 1) * (M + 1) + j + 1] + 1 : Math.max(T[(i + 1) * (M + 1) + j], T[i * (M + 1) + j + 1]);
      let i = 0, j = 0;
      while (i < N && j < M) { if (eq(A[i], B[j])) { pairs.push([p + i, p + j]); i++; j++; } else if (T[(i + 1) * (M + 1) + j] >= T[i * (M + 1) + j + 1]) i++; else j++; }
    }
    for (let i = 0; i < q; i++) pairs.push([n - q + i, m - q + i]);
    return pairs;
  }
  // what changed from a to b: hunks {a0,a1,b0,b1} plus, for every kept item of a, its index in b (-1 = changed)
  function hunks(a, b) {
    const pairs = lcs(a, b, (x, y) => x === y), map = new Array(a.length).fill(-1), out = [];
    let pa = 0, pb = 0;
    for (const [i, j] of [...pairs, [a.length, b.length]]) {
      if (i > pa || j > pb) out.push({ a0: pa, a1: i, b0: pb, b1: j });
      if (i < a.length) map[i] = j;
      pa = i + 1; pb = j + 1;
    }
    return { hunks: out, map };
  }
  // pair the base blocks of both sides: matched words make a unit; unmatched runs between two matches make one unit
  function units(lk, rk) {
    const pairs = lcs(lk, rk, (x, y) => x === y), U = [];
    let pl = 0, pr = 0;
    for (const [i, j] of [...pairs, [lk.length, rk.length]]) {
      if (i > pl || j > pr) U.push({ l: range(pl, i), r: range(pr, j), same: false });
      if (i < lk.length) U.push({ l: [i], r: [j], same: true });
      pl = i + 1; pr = j + 1;
    }
    for (const u of U) if (!u.same) u.same = u.l.map((i) => lk[i]).join('') === u.r.map((j) => rk[j]).join('');
    return U;
  }
  const range = (a, b) => { const r = []; for (let i = a; i < b; i++) r.push(i); return r; };

  // ---- Pippin -> Markdown ----
  function inlineToMd(html) {
    let s = strip(html).replace(/\s*\n\s*/g, ' ');
    s = s.replace(/<br\s*\/?>/gi, '<br>')
      .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**').replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*')
      .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (m, c) => '`' + decode(c) + '`').replace(/<(s|del|strike)\b[^>]*>([\s\S]*?)<\/\1>/gi, '~~$2~~')
      .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (m, u, t) => `[${t}](${decode(u)})`)
      .replace(/<\/?(p|div)\b[^>]*>/gi, ' ');
    s = s.replace(/(`[^`]*`)|&(#x[0-9a-f]+|#\d+|amp|quot|apos|nbsp);/gi, (m, code) => (code ? m : decode(m)));
    return s.replace(/\|/g, '\\|').trim();
  }
  function htmlTableToMd(t) {
    const rows = []; let m; const reR = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    while ((m = reR.exec(t))) { const cells = []; let c; const reC = /<(t[hd])\b[^>]*>([\s\S]*?)<\/\1>/gi; while ((c = reC.exec(m[1]))) cells.push(inlineToMd(c[2])); rows.push(cells); }
    if (!rows.length) return '';
    const n = Math.max(...rows.map((r) => r.length)); const line = (r) => '| ' + range(0, n).map((i) => r[i] ?? '').join(' | ') + ' |';
    return [line(rows[0]), '|' + '---|'.repeat(n), ...rows.slice(1).map(line)].join('\n');
  }
  function fromPippin(raw) {
    let s = strip(raw).replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, htmlTableToMd);
    const out = [];
    for (const b of blocks(s)) {
      let t = b.raw;
      if (/^\s{0,3}(`{3,}|~{3,})/.test(t)) { out.push(t); continue; }
      if (/^\s*\*\s*\*\s*\*[\s*]*$/.test(t)) t = '---';
      t = t.replace(/\\@/g, '@').replace(/(\w)\\_(?=\w)/g, '$1_').replace(/(^|\s)\\\*(?=\s)/g, '$1*');
      out.push(t);
    }
    return out.join('\n\n');
  }

  // ---- Markdown -> Pippin (keeping comment markers and table cell ids from the copy it replaces) ----
  const TAGS = /^<\/?(br|span|u|sup|sub|strong|em|code|a|s|mark)\b/i;
  function mdInlineToHtml(md) {
    const keep = [];
    let s = md.replace(/\\\|/g, '|').replace(/`([^`]+)`/g, (m, c) => { keep.push('<code>' + c.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</code>'); return '\u0001' + (keep.length - 1) + '\u0001'; });
    s = s.replace(/&(?!#?\w+;)/g, '&amp;').replace(/</g, (m, o, str) => (TAGS.test(str.slice(o)) ? '<' : '&lt;'));
    s = s.replace(/\[([^\]]*)\]\(([^)\s]*)\)/g, '<a href="$2">$1</a>').replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '<strong>$2</strong>')
      .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\*)/g, '$1<em>$2</em>').replace(/(^|\W)_(?=\S)([^_]*?\S)_(?!\w)/g, '$1<em>$2</em>').replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<s>$1</s>');
    return s.replace(/\u0001(\d+)\u0001/g, (m, i) => keep[+i]);
  }
  const isMdTable = (raw) => { const ls = raw.split('\n').filter((l) => l.trim() && !/^\s*<!--\s*mdr-colours/.test(l)); return ls.length >= 2 && ls.every((l) => l.trim().startsWith('|')) && /^\s*\|?\s*:?-{2,}/.test(ls[1]); };
  function mdRows(raw) {
    const ls = raw.split('\n').filter((l) => l.trim().startsWith('|'));
    const cells = (l) => { const c = []; let cur = '', t = l.trim().replace(/^\|/, '').replace(/\|$/, ''); for (let i = 0; i < t.length; i++) { if (t[i] === '\\' && t[i + 1] === '|') { cur += '\\|'; i++; } else if (t[i] === '|') { c.push(cur.trim()); cur = ''; } else cur += t[i]; } c.push(cur.trim()); return c; };
    return ls.filter((l, i) => !(i === 1 && /^\s*\|?\s*:?-{2,}/.test(l))).map(cells);
  }
  function parseHtmlTable(t) {
    const open = /<table\b[^>]*>/i.exec(t)[0], rows = []; let m; const reR = /(<tr\b[^>]*>)([\s\S]*?)<\/tr>/gi;
    while ((m = reR.exec(t))) { const cells = []; let c; const reC = /(<(t[hd])\b[^>]*>)([\s\S]*?)<\/\2>/gi; while ((c = reC.exec(m[2]))) cells.push({ open: c[1], tag: c[2].toLowerCase(), inner: c[3] }); rows.push({ open: m[1], cells }); }
    return { open, rows };
  }
  // keep each marker whose words are still in the new cell text
  function rewrap(html, oldInner) {
    let out = html; const re = /<!--\s*comment:([\w-]+)\s*-->([\s\S]*?)<!--\s*\/comment:\1\s*-->/g; let m, lost = 0;
    while ((m = re.exec(oldInner))) { const w = m[2]; const i = w ? out.indexOf(w) : -1; if (i < 0 || /<!--\s*comment/.test(out.slice(Math.max(0, i - 40), i))) { lost++; continue; } out = out.slice(0, i) + m[0] + out.slice(i + w.length); }
    return { html: out, lost };
  }
  function rebuildTable(mdRaw, oldHtml) {
    const old = parseHtmlTable(oldHtml), rows = mdRows(mdRaw), n = Math.max(...rows.map((r) => r.length));
    const oldKey = old.rows.map((r) => key(r.cells.map((c) => c.inner).join(' '))), newKey = rows.map((r) => key(r.join(' ')));
    // rows with the same words keep their ids; an edited row between two kept rows takes the ids of the old row there
    const pairs = lcs(oldKey, newKey, (x, y) => x === y), match = new Array(rows.length).fill(-1);
    let po = 0, pn = 0;
    for (const [i, j] of [...pairs, [old.rows.length, rows.length]]) {
      for (let k = 0; pn + k < j && po + k < i; k++) match[pn + k] = po + k;
      if (j < rows.length) match[j] = i;
      po = i + 1; pn = j + 1;
    }
    let lost = 0; const oldN = Math.max(0, ...old.rows.map((r) => r.cells.length));
    const open = n === oldN ? old.open : old.open.replace(/\s*data-col-sizes="[^"]*"/, '');
    const out = [open];
    rows.forEach((r, ri) => {
      const o = match[ri] >= 0 ? old.rows[match[ri]] : null, tag = ri === 0 ? 'th' : 'td';
      out.push('  ' + (o ? o.open : '<tr>'));
      for (let ci = 0; ci < n; ci++) {
        const md = r[ci] ?? '', oc = o && o.cells[ci];
        let inner;
        if (oc && inlineToMd(oc.inner) === md.trim()) inner = oc.inner;
        else { inner = mdInlineToHtml(md); if (oc) { const w = rewrap(inner, oc.inner); inner = w.html; lost += w.lost; } }
        const op = oc ? oc.open.replace(/^<t[hd]/i, '<' + tag) : `<${tag}>`;
        out.push(`    ${op}${inner}</${tag}>`);
      }
      out.push('  </tr>');
    });
    if (old.rows.length > rows.length) for (const [i, r] of old.rows.entries()) if (!match.includes(i)) lost += r.cells.reduce((k, c) => k + (c.inner.match(/<!--\s*comment:/g) || []).length, 0);
    out.push('</table>');
    return { html: out.join('\n'), lost };
  }
  function toPippin(md, oldRaw) {
    const oldTables = (String(oldRaw).match(/<table\b[^>]*>[\s\S]*?<\/table>/gi) || []);
    const bl = blocks(md), tbl = bl.filter((b) => isMdTable(b.raw));
    const reuse = tbl.length && tbl.length === oldTables.length;
    let lost = 0, s = '', at = 0; const tables = [];
    bl.forEach((b) => { if (!isMdTable(b.raw)) return; s += md.slice(at, b.s) + '\u0002' + tables.length + '\u0002'; tables.push(b.raw.split('\n').filter((l) => !/^\s*<!--\s*mdr-colours/.test(l)).join('\n')); at = b.e; });
    s += md.slice(at);
    // comment markers outside tables: wrap the same words again, in order
    const prose = String(oldRaw).replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, ''); const re = /<!--\s*comment:([\w-]+)\s*-->([\s\S]*?)<!--\s*\/comment:\1\s*-->/g; let m, from = 0;
    while ((m = re.exec(prose))) {
      const w = m[2]; if (!w) continue;
      let i = s.indexOf(w, from); if (i < 0) i = s.indexOf(w);
      const inside = (k) => { const before = s.slice(0, k); return (before.match(/<!--\s*comment:/g) || []).length > (before.match(/<!--\s*\/comment:/g) || []).length || /\u0002\d*$/.test(before); };
      if (i < 0 || inside(i)) { lost++; continue; }
      s = s.slice(0, i) + m[0] + s.slice(i + w.length); from = i + m[0].length;
    }
    s = s.replace(/\u0002(\d+)\u0002/g, (x, k) => { if (!reuse) return tables[+k]; const r = rebuildTable(tables[+k], oldTables[+k]); lost += r.lost; return r.html; });
    if (!reuse) for (const t of oldTables) lost += (strip(t) === t ? 0 : (t.match(/<!--\s*comment:/g) || []).length);
    return { text: s, lost };
  }

  // ---- the plan ----
  // o = { local (the file's text), remote (Pippin's content, with markers), base: {local, remote} | null,
  //       clean(text) -> text without MdReader-only markup, choices: { conflictId: 'mine' | 'theirs' } }
  function plan(o) {
    const clean = o.clean || ((t) => t), choices = o.choices || {};
    // compare blocks without MdReader-only markup here and without comment markers there, so a new comment on
    // Pippin or a colour picked here is not a text change
    const lb = (t) => blocks(t).map((b) => ({ ...b, cmp: clean(b.raw).trim() })).filter((b) => b.cmp);
    const rb = (t) => blocks(t).map((b) => ({ ...b, cmp: strip(b.raw).trim() })).filter((b) => b.cmp);
    const L = lb(o.local), R = rb(o.remote);
    const noBase = !o.base;
    const B0L = (noBase ? L : lb(o.base.local)).map((b) => b.cmp);
    const B0Rb = noBase ? R : rb(o.base.remote);
    const B0R = B0Rb.map((b) => b.cmp), baseRemote = noBase ? o.remote : o.base.remote;
    const U = units(B0L.map(key), B0R.map(key)), N = U.length;
    const uL = [], uR = []; U.forEach((u, k) => { for (const i of u.l) uL[i] = k; for (const j of u.r) uR[j] = k; });
    const lh = hunks(B0L, L.map((b) => b.cmp)), rh = hunks(B0R, R.map((b) => b.cmp));
    // a hunk over base blocks -> a range of units [a, b) (a === b: an insertion between units)
    const toUnits = (h, uOf, len) => {
      if (h.a1 > h.a0) return { a: uOf[h.a0], b: uOf[h.a1 - 1] + 1 };
      if (h.a0 === 0) return { a: 0, b: 0 }; if (h.a0 >= len) return { a: N, b: N };
      const x = uOf[h.a0 - 1], y = uOf[h.a0]; return x === y ? { a: x, b: x + 1 } : { a: y, b: y };
    };
    let iv = [...lh.hunks.map((h) => ({ ...toUnits(h, uL, B0L.length), sides: new Set(['L']) })), ...rh.hunks.map((h) => ({ ...toUnits(h, uR, B0R.length), sides: new Set(['R']) }))];
    if (noBase) U.forEach((u, k) => { if (!u.same) iv.push({ a: k, b: k + 1, sides: new Set(['L', 'R']) }); });
    const cross = (x, c) => { if (x.a === x.b && c.a === c.b) return x.a === c.a; if (x.a === x.b) return c.a < x.a && x.a < c.b; if (c.a === c.b) return x.a < c.a && c.a < x.b; return x.a < c.b && c.a < x.b; };
    // where unit boundary p falls in the current blocks of one side: a cluster's start is placed just after the
    // kept unit before it, its end just before the kept unit after it (null: that neighbour changed too -> widen)
    const pos = (p, side, end) => {
      const map = side === 'L' ? lh.map : rh.map, len = side === 'L' ? L.length : R.length, idx = (u) => (side === 'L' ? u.l : u.r);
      if (!end) { for (let q = p - 1; q >= 0; q--) { const ix = idx(U[q]); if (!ix.length) continue; const v = map[ix[ix.length - 1]]; return v >= 0 ? v + 1 : null; } return 0; }
      for (let q = p; q < N; q++) { const ix = idx(U[q]); if (!ix.length) continue; const v = map[ix[0]]; return v >= 0 ? v : null; }
      return len;
    };
    const merge = (list) => {
      list.sort((x, y) => x.a - y.a || x.b - y.b); const out = [];
      for (const x of list) {
        const c = out[out.length - 1];
        if (c && (cross(x, c) || (x.a <= c.b && [...x.sides].every((s) => c.sides.has(s)) && [...c.sides].every((s) => x.sides.has(s))))) { c.b = Math.max(c.b, x.b); for (const s of x.sides) c.sides.add(s); }
        else out.push({ a: x.a, b: x.b, sides: new Set(x.sides) });
      }
      return out;
    };
    let cl = merge(iv);
    for (let guard = 0; guard < 50; guard++) { // widen any cluster whose edges cannot be placed, then merge again
      let moved = false;
      for (const c of cl) for (const s of ['L', 'R']) { while (c.a > 0 && pos(c.a, s) === null) { c.a--; moved = true; } while (c.b < N && pos(c.b, s, true) === null) { c.b++; moved = true; } }
      if (!moved) break; cl = merge(cl);
    }
    const span = (B, a, b) => (b > a ? { s: B[a].s, e: B[b - 1].e } : null);
    const pushes = [], pulls = [], conflicts = []; let lost = 0;
    for (const c of cl) {
      const la = pos(c.a, 'L'), lb = pos(c.b, 'L', true), ra = pos(c.a, 'R'), rb = pos(c.b, 'R', true);
      const ls = span(L, la, lb), rs = span(R, ra, rb);
      const localText = ls ? o.local.slice(ls.s, ls.e) : '', remoteRaw = rs ? o.remote.slice(rs.s, rs.e) : '';
      let dir = c.sides.has('L') && c.sides.has('R') ? 'both' : c.sides.has('L') ? 'push' : 'pull';
      if (dir === 'pull') { // a remote change that does not show in Markdown (cell ids, column widths, markers)
        const r0 = []; for (let u = c.a; u < c.b; u++) for (const j of U[u].r) r0.push(B0Rb[j]);
        const was = r0.length ? baseRemote.slice(r0[0].s, r0[r0.length - 1].e) : '';
        if (fromPippin(was) === fromPippin(remoteRaw)) continue;
      }
      if (dir === 'both') {
        const mine = clean(localText).trim(), theirs = fromPippin(remoteRaw).trim();
        if (blocks(mine).map((b) => key(b.raw)).join('') === blocks(theirs).map((b) => key(b.raw)).join('')) continue; // same words on both sides
        const id = hash(key(mine) + '|' + key(theirs));
        if (choices[id] === 'mine') dir = 'push'; else if (choices[id] === 'theirs') dir = 'pull';
        else { conflicts.push({ id, mine, theirs }); continue; }
      }
      if (dir === 'push') {
        const t = toPippin(clean(localText).trim(), remoteRaw); lost += t.lost;
        if (rs) pushes.push({ type: 'string_replace', search: remoteRaw, content: t.text, at: rs.s });
        else if (!t.text) continue;
        else if (ra > 0) pushes.push({ type: 'insert_after_string', search: R[ra - 1].raw, content: '\n\n' + t.text, at: R[ra - 1].s });
        else if (R.length) pushes.push({ type: 'insert_before_string', search: R[0].raw, content: t.text + '\n\n', at: R[0].s });
        else pushes.push({ type: 'append', content: t.text, at: 0 });
      } else {
        const text = fromPippin(remoteRaw).trim();
        if (ls) {
          const tail = (/\n[ \t]*<!--\s*mdr-colours\s+\{.*\}\s*-->[ \t]*$/.exec(localText) || [''])[0]; // the colour line under a table stays
          let e = ls.e; if (!text) { while (o.local[e] === '\n') e++; }
          pulls.push({ s: ls.s, e, text: text ? text + tail : '' });
        } else if (text) pulls.push(la > 0 ? { s: L[la - 1].e, e: L[la - 1].e, text: '\n\n' + text } : { s: 0, e: 0, text: text + '\n\n' });
      }
    }
    if (conflicts.length) return { conflicts, pushes: [], newLocal: null, pushed: 0, pulled: 0, lost: 0 };
    for (const p of pushes) { if (!p.search) continue; let k = 0, i = -1; while ((i = o.remote.indexOf(p.search, i + 1)) >= 0 && i < p.at) k++; p.occurrence = k + 1; }
    pushes.sort((x, y) => y.at - x.at);
    let newLocal = null;
    if (pulls.length) { newLocal = o.local; for (const p of pulls.sort((x, y) => y.s - x.s)) newLocal = newLocal.slice(0, p.s) + p.text + newLocal.slice(p.e); }
    return { conflicts: [], pushes, newLocal, pushed: pushes.length, pulled: pulls.length, lost };
  }

  global.PSYNC = { plan, blocks, key, strip, fromPippin, toPippin, units, hunks };
})(typeof window !== 'undefined' ? window : globalThis);
