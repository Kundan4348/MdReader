// JSON comparison (shared by the app and the extension).
// diff(a, b) walks two parsed JSON values and returns one tree of differences:
//   node = { st: 'same' | 'changed' | 'added' | 'removed' | 'inner', k (key or index), a, b, kids?, n: {changed, added, removed},
//            moved?: [fromIndex, toIndex], by?: the key list items were matched by, ia/ib: indexes on each side }
// 'inner' is a container with differences somewhere inside it; 'changed' is a value that is different (a different
// scalar, or a different kind of value: a number became text, an object became a list).
// Lists are matched sensibly rather than position by position, so one inserted item is reported as one addition and
// not as every later item "changed":
//   - a list of objects that all carry a unique id-like field (id, key, name, *Id, *_id ...) is matched by that field,
//     and an item that only changed place is reported as moved
//   - any other list is matched by a longest-common-subsequence of the items (or, with ignoreOrder, by equal values
//     regardless of place); what is left over is paired up in order as "changed" items
// Also: render(...) builds the comparison view, and report(...) the plain-text summary that Copy puts on the clipboard.
(function (global) {
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isCont = (v) => v !== null && typeof v === 'object';
  const kindOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'list' : typeof v === 'object' ? 'object' : typeof v === 'string' ? 'text' : typeof v);
  // canonical text of a value: object keys sorted, so {a,b} and {b,a} compare equal
  const canon = (v) => (Array.isArray(v) ? '[' + v.map(canon).join(',') + ']' : isObj(v) ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}' : JSON.stringify(v));
  const zero = () => ({ changed: 0, added: 0, removed: 0 });
  const add = (n, m) => { n.changed += m.changed; n.added += m.added; n.removed += m.removed; return n; };
  const total = (n) => n.changed + n.added + n.removed;

  // fields that can name a list item, best first
  const ID_RE = [/^id$/i, /^(uuid|guid|key|_id)$/i, /(^|_)id$|Id$|ID$/, /^(name|code|slug|sku|arn|email|login|alias|title)$/i];
  function idKey(a, b, want) {
    const items = a.concat(b);
    if (!items.length || !items.every(isObj)) return null;
    const ok = (k) => [a, b].every((arr) => { const seen = new Set(); for (const o of arr) { const v = o[k]; if (v === undefined || v === null || isCont(v)) return false; const s = JSON.stringify(v); if (seen.has(s)) return false; seen.add(s); } return true; });
    if (want) return ok(want) ? want : null;
    const keys = [...new Set(items.flatMap(Object.keys))];
    for (const re of ID_RE) { const k = keys.find((x) => re.test(x) && ok(x)); if (k) return k; }
    return null;
  }

  function diff(a, b, opts = {}, k = null) {
    if (a === undefined) return { st: 'added', k, b, n: { changed: 0, added: 1, removed: 0 } };
    if (b === undefined) return { st: 'removed', k, a, n: { changed: 0, added: 0, removed: 1 } };
    const ka = kindOf(a), kb = kindOf(b);
    if (ka !== kb || !isCont(a)) {
      if (ka === kb && a === b) return { st: 'same', k, a, b, n: zero() };
      return { st: 'changed', k, a, b, n: { changed: 1, added: 0, removed: 0 } };
    }
    const kids = ka === 'object' ? diffObject(a, b, opts) : diffList(a, b, opts);
    const node = { st: 'inner', k, a, b, kids: kids.list, n: kids.list.reduce((n, x) => add(n, x.n), zero()) };
    if (kids.by) node.by = kids.by;
    if (!total(node.n)) node.st = 'same';
    return node;
  }
  function diffObject(a, b, opts) {
    const skip = opts.ignoreKeys && opts.ignoreKeys.size ? (k) => opts.ignoreKeys.has(k.toLowerCase()) : () => false; // keys left out of the comparison everywhere (timestamps, request ids)
    const keys = Object.keys(a).concat(Object.keys(b).filter((k) => !Object.prototype.hasOwnProperty.call(a, k))).filter((k) => !skip(k));
    return { list: keys.map((k) => diff(own(a, k), own(b, k), opts, k)) };
  }
  const own = (o, k) => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
  function diffList(a, b, opts) {
    const by = opts.match === 'position' ? null : idKey(a, b, opts.match && opts.match !== 'auto' ? opts.match : null);
    if (by) {
      const ib = new Map(b.map((o, i) => [JSON.stringify(o[by]), i])), used = new Set(), list = [];
      // the items both sides share keep their order except the moved ones: the shared items outside the longest
      // common order are the ones that moved (moving one item does not make its neighbours "moved")
      const ia0 = new Set(a.map((o) => JSON.stringify(o[by])));
      const sa = a.map((o) => JSON.stringify(o[by])).filter((x) => ib.has(x)), sb = b.map((o) => JSON.stringify(o[by])).filter((x) => ia0.has(x));
      const still = new Set(lcs(sa, sb).map(([i]) => sa[i]));
      a.forEach((o, i) => {
        const j = ib.get(JSON.stringify(o[by]));
        if (j === undefined) { list.push(Object.assign(diff(o, undefined, opts, i), { ia: i })); return; }
        used.add(j);
        const d = Object.assign(diff(o, b[j], opts, j), { ia: i, ib: j });
        if (!opts.ignoreOrder && !still.has(JSON.stringify(o[by]))) d.moved = [i, j];
        list.push(d);
      });
      b.forEach((o, j) => { if (!used.has(j)) list.push(Object.assign(diff(undefined, o, opts, j), { ib: j })); });
      list.forEach((d) => { const o = d.b !== undefined ? d.b : d.a; d.label = { by, v: o[by] }; }); // a path names the item: items[sku="SW-48P"]
      // show them in the right-hand order, removed items where they used to be
      return { list: order(list), by };
    }
    if (opts.match === 'position') {
      const list = [];
      for (let i = 0; i < Math.max(a.length, b.length); i++) list.push(Object.assign(diff(a[i], b[i], opts, i), i < a.length ? { ia: i } : {}, i < b.length ? { ib: i } : {}));
      return { list };
    }
    const ca = a.map(canon), cb = b.map(canon);
    if (opts.ignoreOrder) { // equal values pair up wherever they are; the rest is added / removed
      const pool = new Map(); cb.forEach((c, j) => { if (!pool.has(c)) pool.set(c, []); pool.get(c).push(j); });
      const list = [], used = new Set();
      ca.forEach((c, i) => { const p = pool.get(c); if (p && p.length) { const j = p.shift(); used.add(j); list.push({ st: 'same', k: j, a: a[i], b: b[j], n: zero(), ia: i, ib: j }); } else list.push(Object.assign(diff(a[i], undefined, opts, i), { ia: i })); });
      b.forEach((x, j) => { if (!used.has(j)) list.push(Object.assign(diff(undefined, x, opts, j), { ib: j })); });
      return { list: order(list) };
    }
    const pairs = lcs(ca, cb); // [i, j] matched as equal
    const list = [];
    let i = 0, j = 0;
    const gap = (i1, j1) => { // the stretch between two matched items: pair up in order, the rest added / removed
      const ra = [], rb = []; for (; i < i1; i++) ra.push(i); for (; j < j1; j++) rb.push(j);
      const m = Math.min(ra.length, rb.length);
      for (let t = 0; t < m; t++) list.push(Object.assign(diff(a[ra[t]], b[rb[t]], opts, rb[t]), { ia: ra[t], ib: rb[t] }));
      ra.slice(m).forEach((x) => list.push(Object.assign(diff(a[x], undefined, opts, x), { ia: x })));
      rb.slice(m).forEach((y) => list.push(Object.assign(diff(undefined, b[y], opts, y), { ib: y })));
    };
    for (const [pi, pj] of pairs) { gap(pi, pj); list.push({ st: 'same', k: pj, a: a[pi], b: b[pj], n: zero(), ia: pi, ib: pj }); i = pi + 1; j = pj + 1; }
    gap(a.length, b.length);
    return { list };
  }
  function order(list) {
    // right-hand order; a removed item sits after the item that preceded it on the left
    const out = list.filter((x) => x.ib !== undefined).sort((x, y) => x.ib - y.ib);
    list.filter((x) => x.ib === undefined).sort((x, y) => x.ia - y.ia).forEach((r) => {
      let at = 0; for (let t = 0; t < out.length; t++) if (out[t].ia !== undefined && out[t].ia < r.ia) at = t + 1;
      out.splice(at, 0, r);
    });
    return out;
  }
  // longest common subsequence of two string lists; large lists fall back to a greedy match to stay fast
  function lcs(x, y) {
    let s = 0; while (s < x.length && s < y.length && x[s] === y[s]) s++;
    let e = 0; while (e < x.length - s && e < y.length - s && x[x.length - 1 - e] === y[y.length - 1 - e]) e++;
    const head = [...Array(s).keys()].map((t) => [t, t]), tail = [...Array(e).keys()].reverse().map((t) => [x.length - 1 - t, y.length - 1 - t]);
    const X = x.slice(s, x.length - e), Y = y.slice(s, y.length - e);
    let mid = [];
    if (X.length && Y.length) {
      if (X.length * Y.length <= 4e6) {
        const n = X.length, m = Y.length, L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
        for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = X[i] === Y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
        let i = 0, j = 0; while (i < n && j < m) { if (X[i] === Y[j]) { mid.push([i + s, j + s]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) i++; else j++; }
      } else {
        const pos = new Map(); Y.forEach((c, j) => { if (!pos.has(c)) pos.set(c, []); pos.get(c).push(j); });
        let last = -1; X.forEach((c, i) => { const p = pos.get(c); if (!p) return; const j = p.find((q) => q > last); if (j !== undefined) { mid.push([i + s, j + s]); last = j; } });
      }
    }
    return head.concat(mid, tail);
  }

  // ---------- text ----------
  // a path step is a key, an index, { by, v } (a list item named by its id field) or { was } (a removed item's old index)
  const pathStr = (p) => '$' + p.map((k) => (typeof k === 'number' ? `[${k}]` : k && typeof k === 'object' ? (k.by ? `[${k.by}=${JSON.stringify(k.v)}]` : `[was ${k.was}]`) : /^[A-Za-z_$][\w$]*$/.test(k) ? '.' + k : `[${JSON.stringify(k)}]`)).join('');
  const step = (c) => (c.label ? c.label : c.st === 'removed' && typeof c.k === 'number' ? { was: c.ia } : c.k);
  const short = (v, max = 80) => { const j = isCont(v) ? (JSON.stringify(v)) : null; if (j && j.length <= max) return j; const s = isCont(v) ? (Array.isArray(v) ? `[ ${v.length} item${v.length === 1 ? '' : 's'} ]` : `{ ${Object.keys(v).length} key${Object.keys(v).length === 1 ? '' : 's'} }`) : JSON.stringify(v); return s.length > max ? s.slice(0, max - 1) + '…' : s; };
  // every difference in reading order (moved-only items included)
  function changes(root) {
    const out = [];
    (function walk(node, path) {
      for (const c of node.kids || []) {
        const p = path.concat(step(c));
        if (c.moved && (c.st === 'same' || c.st === 'inner')) out.push({ path: p, st: 'moved', a: c.a, b: c.b, moved: c.moved });
        if (c.st === 'inner') walk(c, p);
        else if (c.st !== 'same') out.push({ path: p, st: c.st, a: c.a, b: c.b, moved: c.moved, kindChange: c.st === 'changed' && kindOf(c.a) !== kindOf(c.b) ? [kindOf(c.a), kindOf(c.b)] : null });
      }
    })(root, []);
    if (root.st === 'changed') out.push({ path: [], st: 'changed', a: root.a, b: root.b, kindChange: kindOf(root.a) !== kindOf(root.b) ? [kindOf(root.a), kindOf(root.b)] : null });
    return out;
  }
  function report(root, names = ['left', 'right']) {
    const cs = changes(root);
    if (!cs.length) return `No differences between ${names[0]} and ${names[1]}.`;
    const n = root.n, mv = cs.filter((c) => c.st === 'moved').length;
    const lines = [`${names[0]} → ${names[1]}: ${plural(total(n) + mv, 'difference')} (${n.changed} changed, ${n.added} added, ${n.removed} removed${mv ? `, ${mv} moved` : ''})`, ''];
    for (const c of cs) {
      const p = pathStr(c.path);
      if (c.st === 'changed') lines.push(`~ ${p}: ${short(c.a, 200)} → ${short(c.b, 200)}`);
      else if (c.st === 'added') lines.push(`+ ${p}: ${short(c.b, 200)}`);
      else if (c.st === 'removed') lines.push(`- ${p}: ${short(c.a, 200)}`);
      else lines.push(`↕ ${p}: moved from position ${c.moved[0]} to ${c.moved[1]}`);
    }
    return lines.join('\n');
  }
  const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;

  // ---------- the view ----------
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) { if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (v !== null && v !== undefined) el.setAttribute(k, v); }
    for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) el.append(k.nodeType ? k : document.createTextNode(k));
    return el;
  };
  const scal = (v) => h('span', { class: 'jv ' + (v === null ? 'jnull' : typeof v === 'boolean' ? 'jbool' : typeof v === 'number' ? 'jnum' : 'jstr') }, v === null ? 'null' : typeof v === 'string' ? JSON.stringify(v) : String(v));
  // a whole value: a scalar as itself, a container as its size with the full JSON under a fold
  function valEl(v, open) {
    if (!isCont(v)) return scal(v);
    const s = JSON.stringify(v, null, 2);
    if (s.length <= 60 && !s.includes('\n  {')) return h('span', { class: 'jv jd-inline' }, spaced(JSON.stringify(v)));
    return h('details', { class: 'jd-val', open: open ? '' : null }, h('summary', {}, h('span', { class: 'jsum' }, short(v))), h('pre', {}, s));
  }
  // one-line JSON with a space after each , and : -- but never inside a string ("16:05:00Z" stays as it is)
  function spaced(j) {
    let out = '', str = false;
    for (let i = 0; i < j.length; i++) {
      const c = j[i]; out += c;
      if (str) { if (c === '\\') { out += j[++i]; } else if (c === '"') str = false; }
      else if (c === '"') str = true; else if (c === ',' || c === ':') out += ' ';
    }
    return out;
  }
  // two texts with what differs between them marked (common start and end left plain)
  function strPair(a, b) {
    const x = JSON.stringify(a), y = JSON.stringify(b);
    let p = 0; while (p < x.length && p < y.length && x[p] === y[p]) p++;
    let e = 0; while (e < x.length - p && e < y.length - p && x[x.length - 1 - e] === y[y.length - 1 - e]) e++;
    const part = (t) => [t.slice(0, p), h('mark', {}, t.slice(p, t.length - e)), t.slice(t.length - e)];
    const long = Math.max(x.length, y.length) > 70;
    return [h('del', { class: 'jv jstr' }, ...part(x)), h('span', { class: 'jd-arrow' }, long ? '↓' : '→'), long ? h('br') : null, h('ins', { class: 'jv jstr' }, ...part(y))];
  }
  const KIND = { text: 'text', number: 'number', boolean: 'true/false', null: 'empty (null)', object: 'object', list: 'list' };
  function counts(n, extra) {
    const out = [];
    if (n.changed) out.push(h('span', { class: 'jd-b jd-b-chg' }, `${n.changed} changed`));
    if (n.added) out.push(h('span', { class: 'jd-b jd-b-add' }, `${n.added} added`));
    if (n.removed) out.push(h('span', { class: 'jd-b jd-b-del' }, `${n.removed} removed`));
    if (extra) out.push(h('span', { class: 'jd-b jd-b-mv' }, `${extra} moved`));
    return out;
  }
  const movedIn = (node) => (node.kids || []).reduce((n, c) => n + (c.moved ? 1 : 0) + movedIn(c), 0);
  // the key / index part of a line: list items show their position and, when matched by a field, that field's value
  function keyEl(c, parent) {
    if (typeof c.k !== 'number') return [h('span', { class: 'jk' }, JSON.stringify(c.k)), h('span', { class: 'jc' }, ': ')];
    const idx = c.ib !== undefined ? c.ib : c.ia, by = parent && parent.by, item = c.b !== undefined ? c.b : c.a;
    return [h('span', { class: 'jk jidx' }, String(idx)), by && isObj(item) && item[by] !== undefined ? h('span', { class: 'jd-id', title: `Matched by "${by}"` }, `${by}=${short(item[by], 40)}`) : null, h('span', { class: 'jc' }, ': ')];
  }
  // render(root, {onlyChanges}) -> the tree element. Every difference line carries .jd-c and data-path.
  function render(root, opts = {}) {
    const box = h('div', { class: 'jd-tree jt' });
    if (!isCont(root.a) || !isCont(root.b) || kindOf(root.a) !== kindOf(root.b)) { box.append(...lines([Object.assign({}, root, { k: '(the whole value)' })], [], null, opts)); return box; }
    box.append(...lines(root.kids, [], root, opts));
    return box;
  }
  function lines(kids, path, parent, opts) {
    const out = []; let run = [];
    const flush = () => {
      if (!run.length) return;
      if (opts.onlyChanges && run.length > 1) {
        const r = run; const n = r.length, list = typeof r[0].k === 'number';
        const gap = h('button', { type: 'button', class: 'jd-gap', title: 'Show them' }, `··· ${n} unchanged ${list ? 'item' : 'key'}${n === 1 ? '' : 's'}`);
        gap.addEventListener('click', () => gap.replaceWith(...r.flatMap((c) => one(c, path, parent, opts))));
        out.push(gap);
      } else run.forEach((c) => out.push(...one(c, path, parent, opts)));
      run = [];
    };
    for (const c of kids) { if (c.st === 'same' && !c.moved) run.push(c); else { flush(); out.push(...one(c, path, parent, opts)); } }
    flush();
    return out;
  }
  function one(c, path, parent, opts) {
    const p = c.k === '(the whole value)' ? path : path.concat(step(c)), ps = pathStr(p), k = keyEl(c, parent);
    const mv = c.moved ? h('span', { class: 'jd-mv', title: 'Same item, in a different place' }, `↕ was ${c.moved[0]}`) : null;
    const line = (cls, sign, ...body) => h('div', { class: 'jl jd-l ' + cls + (cls === 'jd-same' && !mv ? '' : ' jd-c') + (mv ? ' jd-moved' : ''), 'data-path': ps, title: ps }, h('span', { class: 'jd-s' }, sign), ...k, ...body, mv);
    if (c.st === 'same') {
      if (!isCont(c.a)) return [line('jd-same', '', scal(c.b))];
      const one = spaced(JSON.stringify(c.b)); // an unchanged object or list: one quiet line, shortened
      return [line('jd-same', '', h('span', { class: 'jv jd-one', title: one.length > 90 ? one.slice(0, 2000) : null }, one.length > 90 ? one.slice(0, 89) + '…' : one))];
    }
    if (c.st === 'added') return [line('jd-add', '+', valEl(c.b, true))];
    if (c.st === 'removed') return [line('jd-del', '−', valEl(c.a, true))];
    if (c.st === 'changed') {
      const ka = kindOf(c.a), kb = kindOf(c.b);
      if (ka === 'text' && kb === 'text') return [line('jd-chg', '~', ...strPair(c.a, c.b))];
      return [line('jd-chg', '~', h('del', {}, valEl(c.a)), h('span', { class: 'jd-arrow' }, '→'), h('ins', {}, valEl(c.b)), ka !== kb ? h('span', { class: 'jd-kind' }, `${KIND[ka]} → ${KIND[kb]}`) : null)];
    }
    // inner: a fold with what changed inside it
    const by = c.by ? h('span', { class: 'jd-by', title: `List items were matched by their "${c.by}" field, not by position` }, `matched by ${c.by}`) : null;
    const sum = h('summary', { class: 'jd-l jd-in' + (mv ? ' jd-c jd-moved' : ''), 'data-path': ps, title: ps }, h('span', { class: 'jd-s' }, ''), ...k, h('span', { class: 'jsum' }, Array.isArray(c.b) ? `[ ${c.a.length} → ${c.b.length} items ]` : `{ ${Object.keys(c.b).length} keys }`), ' ', ...counts(c.n, movedIn(c)), by, mv);
    const d = h('details', { class: 'jn jd-n', open: '' }, sum, h('div', { class: 'jt' }, ...lines(c.kids, p, c, opts)));
    return [d];
  }
  // the list view: one row per difference
  function table(root, names) {
    const rows = changes(root);
    const t = h('table', { class: 'jd-table' }, h('thead', {}, h('tr', {}, h('th', {}, 'Where'), h('th', {}, 'What'), h('th', {}, names[0]), h('th', {}, names[1]))));
    const body = h('tbody', {});
    const WHAT = { changed: 'changed', added: 'added', removed: 'removed', moved: 'moved' };
    for (const c of rows) {
      const cell = (v, has) => h('td', { class: 'jd-v' }, has ? valEl(v) : h('span', { class: 'jd-none' }, '—'));
      body.append(h('tr', { class: 'jd-c jd-r-' + c.st, 'data-path': pathStr(c.path) }, h('td', { class: 'jd-p' }, pathStr(c.path)),
        h('td', {}, h('span', { class: 'jd-b jd-b-' + { changed: 'chg', added: 'add', removed: 'del', moved: 'mv' }[c.st] }, c.st === 'moved' ? `moved ${c.moved[0]} → ${c.moved[1]}` : WHAT[c.st]), c.kindChange ? h('span', { class: 'jd-kind' }, `${KIND[c.kindChange[0]]} → ${KIND[c.kindChange[1]]}`) : null),
        cell(c.a, c.st !== 'added'), cell(c.b, c.st !== 'removed')));
    }
    t.append(body);
    return h('div', { class: 'table-wrap jd-tw' }, t);
  }
  // the summary: one plain sentence, then a tile per kind of difference (the shell makes a tile hide / show that kind)
  function summary(root, names, opts = {}) {
    const cs = changes(root), mv = cs.filter((c) => c.st === 'moved').length, n = root.n, all = total(n) + mv;
    const byKeys = []; (function walk(x) { if (x.by && !byKeys.includes(x.by)) byKeys.push(x.by); (x.kids || []).forEach(walk); })(root);
    const ign = opts.ignored && opts.ignored.length ? h('div', { class: 'jd-note' }, `Leaving out ${opts.ignored.map((k) => `"${k}"`).join(', ')} wherever it appears.`) : null;
    const nm = (x) => h('b', {}, x);
    if (!all) {
      const order = canon(root.a) === canon(root.b) && JSON.stringify(root.a) !== JSON.stringify(root.b);
      return h('div', { class: 'jd-sum jd-equal' }, h('div', { class: 'jd-head' }, h('span', { class: 'jd-big' }, '='), h('div', {}, h('div', { class: 'jd-line' }, 'No differences'),
        h('div', { class: 'jd-sub' }, nm(names[1]), ' holds exactly the same data as ', nm(names[0]), order ? ' -- only the order of keys differs.' : '.'))), ign);
    }
    const tile = (k, label, count, tip) => h('button', { type: 'button', class: `jd-tile jd-t-${k}`, 'data-k': k, 'aria-pressed': 'true', disabled: count ? null : '', title: count ? `${tip} -- click to hide or show them` : tip },
      h('span', { class: 'jd-tn' }, String(count)), h('span', { class: 'jd-tl' }, label));
    const where = new Set(cs.map((c) => (c.path.length ? pathStr(c.path.slice(0, 1)) : '$'))).size;
    return h('div', { class: 'jd-sum' },
      h('div', { class: 'jd-head' }, h('span', { class: 'jd-big' }, String(all)), h('div', {}, h('div', { class: 'jd-line' }, all === 1 ? 'difference' : 'differences'),
        h('div', { class: 'jd-sub' }, 'from ', nm(names[0]), ' to ', nm(names[1]), where > 1 ? ` · in ${where} top-level parts` : ''))),
      h('div', { class: 'jd-tiles' }, tile('chg', 'changed', n.changed, 'Values that are different'), tile('add', 'added', n.added, `Only in ${names[1]}`),
        tile('del', 'removed', n.removed, `Only in ${names[0]}`), tile('mv', 'moved', mv, 'The same list item, in a different place')),
      byKeys.length ? h('div', { class: 'jd-note' }, `List items are paired by ${byKeys.map((k) => `"${k}"`).join(', ')}, so an added or moved item does not make everything after it look changed.`) : null, ign);
  }

  // ---------- side by side ----------
  // Both JSONs pretty-printed in two columns, lined up: a line that is the same sits beside itself, a changed value
  // beside its new value (the characters that differ marked), and an added or removed part faces an empty, hatched
  // space on the other side. Built from the same diff tree, so list items line up by id exactly as in the tree.
  const IND = '  ';
  const prettyLines = (v) => JSON.stringify(v, null, 2).split('\n');
  function sbsRows(root) {
    const rows = [];
    const push = (l, r, st, mark) => rows.push({ l, r, st, mark: !!mark });
    const keyTxt = (c) => (typeof c.k === 'number' ? '' : JSON.stringify(c.k) + ': ');
    // the lines of one value, the first one carrying the key, the last one the comma
    const valueLines = (v, pad, key, comma) => { const ls = prettyLines(v); return ls.map((x, i) => (i ? pad + x : pad + key + x) + (i === ls.length - 1 ? comma : '')); };
    function node(c, pad, cl, cr) {
      const key = keyTxt(c);
      if (c.st === 'same') { const L = valueLines(c.a, pad, key, cl), R = valueLines(c.b, pad, key, cr); L.forEach((x, i) => push(x, R[i], c.moved ? 'mv' : 'same', c.moved && !i)); return; }
      if (c.st === 'added') { valueLines(c.b, pad, key, cr).forEach((x, i) => push(null, x, 'add', !i)); return; }
      if (c.st === 'removed') { valueLines(c.a, pad, key, cl).forEach((x, i) => push(x, null, 'del', !i)); return; }
      if (c.st === 'changed') { const L = valueLines(c.a, pad, key, cl), R = valueLines(c.b, pad, key, cr); for (let i = 0; i < Math.max(L.length, R.length); i++) push(i < L.length ? L[i] : null, i < R.length ? R[i] : null, 'chg', !i); return; }
      // inner: the container's own brackets on both sides, its members lined up between them
      const arr = Array.isArray(c.b), o = arr ? '[' : '{', e = arr ? ']' : '}';
      push(pad + key + o, pad + key + o, c.moved ? 'mv' : 'same', !!c.moved);
      kids(c.kids, pad + IND);
      push(pad + e + cl, pad + e + cr, 'same');
    }
    function kids(list, pad) {
      const lastL = list.map((x) => x.st !== 'added').lastIndexOf(true), lastR = list.map((x) => x.st !== 'removed').lastIndexOf(true);
      list.forEach((c, i) => node(c, pad, i < lastL ? ',' : '', i < lastR ? ',' : ''));
    }
    if (root.st === 'inner') { const arr = Array.isArray(root.b); push(arr ? '[' : '{', arr ? '[' : '{', 'same'); kids(root.kids, IND); push(arr ? ']' : '}', arr ? ']' : '}', 'same'); }
    else node(Object.assign({}, root, { k: 0 }), '', '', '');
    return rows;
  }
  // what differs between two lines of a changed value: common start and end stay plain
  function linePair(l, r) {
    let p = 0; while (p < l.length && p < r.length && l[p] === r[p]) p++;
    let e = 0; while (e < l.length - p && e < r.length - p && l[l.length - 1 - e] === r[r.length - 1 - e]) e++;
    const part = (t) => (p + e >= t.length ? [t] : [t.slice(0, p), h('mark', {}, t.slice(p, t.length - e)), t.slice(t.length - e)]);
    return [part(l), part(r)];
  }
  // colour a JSON line lightly: keys, strings, numbers, true/false/null
  function tint(t) {
    const out = []; const re = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g; let m, last = 0;
    while ((m = re.exec(t))) {
      if (m.index > last) out.push(t.slice(last, m.index));
      if (m[1]) { out.push(h('span', { class: m[2] ? 'jk' : 'jv jstr' }, m[1])); if (m[2]) out.push(m[2]); }
      else if (m[3]) out.push(h('span', { class: 'jv jnum' }, m[3]));
      else out.push(h('span', { class: 'jv ' + (m[4] === 'null' ? 'jnull' : 'jbool') }, m[4]));
      last = re.lastIndex;
    }
    if (last < t.length) out.push(t.slice(last));
    return out;
  }
  function sideBySide(root, names, opts = {}) {
    const rows = sbsRows(root);
    let ln = 0, rn = 0;
    rows.forEach((x) => { x.ln = x.l === null ? null : ++ln; x.rn = x.r === null ? null : ++rn; });
    const t = h('table', { class: 'jd-sbs' }, h('colgroup', {}, h('col', { class: 'n' }), h('col', {}), h('col', { class: 'n' }), h('col', {})),
      h('thead', {}, h('tr', {}, h('th', { colspan: '2' }, names[0]), h('th', { colspan: '2' }, names[1]))));
    const body = h('tbody', {});
    const rowEl = (x) => {
      const cell = (txt, mine, other) => {
        if (txt === null) return h('td', { class: 'tx jd-fill' });
        if (x.st === 'chg' && other !== null) { const [a, b] = linePair(mine === 'l' ? txt : other, mine === 'l' ? other : txt); return h('td', { class: 'tx' }, ...(mine === 'l' ? a : b)); }
        return h('td', { class: 'tx' }, ...tint(txt));
      };
      return h('tr', { class: 'jd-r jd-r-' + x.st + (x.mark ? ' jd-c' : '') },
        h('td', { class: 'ln' }, x.ln === null ? '' : String(x.ln)), cell(x.l, 'l', x.r), h('td', { class: 'ln' }, x.rn === null ? '' : String(x.rn)), cell(x.r, 'r', x.l));
    };
    // with "only differences", long runs of identical lines fold to a few lines of context around each change
    const CTX = 3;
    let i = 0;
    while (i < rows.length) {
      if (!opts.onlyChanges || rows[i].st !== 'same') { body.append(rowEl(rows[i])); i++; continue; }
      let j = i; while (j < rows.length && rows[j].st === 'same') j++;
      const head = i === 0 ? 0 : CTX, tail = j === rows.length ? 0 : CTX;
      if (j - i <= head + tail + 1) { for (let k = i; k < j; k++) body.append(rowEl(rows[k])); }
      else {
        for (let k = i; k < i + head; k++) body.append(rowEl(rows[k]));
        const hidden = rows.slice(i + head, j - tail);
        const btn = h('button', { type: 'button', class: 'jd-gap' }, `··· ${hidden.length} unchanged line${hidden.length === 1 ? '' : 's'}`);
        const gapRow = h('tr', { class: 'jd-gaprow' }, h('td', { colspan: '4' }, btn));
        btn.addEventListener('click', () => gapRow.replaceWith(...hidden.map(rowEl)));
        body.append(gapRow);
        for (let k = j - tail; k < j; k++) body.append(rowEl(rows[k]));
      }
      i = j;
    }
    t.append(body);
    return h('div', { class: 'jd-sbsw' }, t);
  }

  // When two sides share (almost) no top-level keys -- an event envelope against the entity it carries -- the real
  // comparison is between parts further down. Finds the pair of objects, one on each side, whose keys overlap most.
  // Returns { a: path, b: path, score } or null. Paths are lists of keys / indexes.
  function bestPair(a, b, depth = 4) {
    const objs = (v, path, out, d) => { if (!isObj(v) || d > depth) return out; if (Object.keys(v).length >= 2) out.push({ path, keys: new Set(Object.keys(v)), v }); for (const [k, x] of Object.entries(v)) if (isObj(x)) objs(x, path.concat(k), out, d + 1); return out; };
    const A = objs(a, [], [], 0), B = objs(b, [], [], 0);
    let best = null;
    for (const x of A) for (const y of B) {
      if (!x.path.length && !y.path.length) continue;
      let common = 0; for (const k of x.keys) if (y.keys.has(k)) common++;
      if (common < 2) continue;
      const score = common / (x.keys.size + y.keys.size - common);
      if (!best || score > best.score || (score === best.score && x.path.length + y.path.length < best.a.length + best.b.length)) best = { a: x.path, b: y.path, score };
    }
    return best && best.score >= 0.5 ? best : null;
  }
  const at = (v, path) => path.reduce((x, k) => (x === null || x === undefined ? undefined : x[k]), v);
  // share of the top-level keys the two sides have in common (1 = all, 0 = none)
  const overlap = (a, b) => { if (!isObj(a) || !isObj(b)) return 1; const ka = Object.keys(a), kb = new Set(Object.keys(b)); const c = ka.filter((k) => kb.has(k)).length; return ka.length + kb.size ? c / (ka.length + kb.size - c) : 1; };

  global.JD = { diff, changes, report, pathStr, short, kindOf, canon, total, plural, idKey, render, table, summary, sideBySide, sbsRows, bestPair, at, overlap };
})(typeof window !== 'undefined' ? window : globalThis);
