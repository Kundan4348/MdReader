// MdReader shell: builds the UI, drives read/edit/split, sections, files, outline, themes.
// Host-agnostic: the host (Electron app or Chrome extension) supplies an adapter:
//   readFile(path)->Promise<string>, writeFile(path,text)->Promise<void>, canSave()->bool,
//   listDir(dir)->Promise<[{name,path,dir}]> (optional), openDialog()->Promise<path|null> (optional),
//   getPref(k)->Promise<any>, setPref(k,v), displayPath(path)->{crumbs:[],name},
//   onExternalChange(cb) (optional), onDirty(bool) (optional), openExternal(url) (optional)
(function (global) {
  const THEMES = [
    { id: 'paper', name: 'Paper', hint: 'warm, serif, one calm column' },
    { id: 'studio', name: 'Studio', hint: 'dark app, files + outline' },
    { id: 'sections', name: 'Sections', hint: 'light cards, one per section' },
    { id: 'mono', name: 'Mono', hint: 'monospace, typewriter calm' },
  ];
  const WIDTHS = ['auto', 'narrow', 'wide', 'full'];
  const ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.2, 1.35, 1.5, 1.7, 2];
  const $ = (sel, root = document) => root.querySelector(sel);
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v; else if (v !== null && v !== undefined) el.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k !== null && k !== undefined) el.append(k.nodeType ? k : document.createTextNode(k));
    return el;
  };
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  function mount(root, adapter) {
    const S = { path: null, text: '', saved: '', mode: 'read', theme: 'paper', files: true, outline: true, editingSec: null, tree: null, dirty: false, zoom: 1, autoZoom: 1, page: 1, width: 'auto', tabs: [], tab: -1, loading: new Map(), untitledSeq: 0 };
    // A tab = { path, text, saved, scroll }. The active tab's text/saved/path/dirty are mirrored into S while it is shown.
    // An untitled tab (⌘T / double-click on the strip) has { untitled: true, name: 'Untitled N' } and a virtual
    // 'untitled:N' path until it is saved, when it adopts the path the adapter wrote to.
    const isUntitled = (t) => !!(t && t.untitled);
    const dispOf = (t) => (isUntitled(t) ? { crumbs: [], crumbPaths: [], name: t.name, dir: null } : adapter.displayPath(t.path));
    const curTab = () => S.tabs[S.tab];
    const curDisp = () => (curTab() ? dispOf(curTab()) : { crumbs: [], name: 'MdReader', dir: null });
    const DEFAULT_THEME = 'mono';

    // ---------- DOM ----------
    root.innerHTML = '';
    root.className = 'app';
    const crumbs = h('div', { class: 'crumbs' });
    const seg = h('div', { class: 'seg' },
      ...['read', 'edit', 'split'].map((m) => h('button', { 'data-mode': m, onclick: () => setMode(m) }, m[0].toUpperCase() + m.slice(1))));
    const saveBtn = h('button', { class: 'save', onclick: save, title: 'Save (⌘S)' }, 'Save');
    const themeSel = h('select', { class: 'theme', title: 'Theme', onchange: (e) => setTheme(e.target.value) },
      ...THEMES.map((t) => h('option', { value: t.id }, t.name)));
    const openBtn = adapter.openDialog ? h('button', { class: 'icon', title: 'Open (⌘O)', onclick: openDialog, html: '&#x2197;' }) : null;
    const filesBtn = adapter.listDir ? h('button', { class: 'icon files-toggle', title: 'Files (⌘\\)', onclick: () => togglePanel('files'), html: '&#x2630;' }) : null;
    const outlineBtn = h('button', { class: 'icon outline-toggle', title: 'Outline (⌘/)', onclick: () => togglePanel('outline'), html: '&#x2261;' });
    const zoomOut = h('button', { class: 'icon zoom-out', title: 'Smaller (⌘−)', onclick: () => stepZoom(-1), html: 'A<sup>−</sup>' });
    const zoomPct = h('button', { class: 'icon zoom-pct', title: 'Reset zoom (⌘0)', onclick: () => resetZoom() }, '100%');
    const zoomIn = h('button', { class: 'icon zoom-in', title: 'Larger (⌘+)', onclick: () => stepZoom(1), html: 'A<sup>+</sup>' });
    const widthBtn = h('button', { class: 'icon width', title: 'Reading width (⌘⇧W)', onclick: () => cycleWidth(), html: '&#x2194;' });
    const view = h('div', { class: 'view' }, zoomOut, zoomPct, zoomIn, widthBtn);
    // JSON-only: pretty-print the source (⌥-click minifies). Hidden unless the open document is JSON (CSS on data-kind).
    const fmtBtn = h('button', { class: 'fmt', title: 'Format JSON (⌘⇧F) · ⌥-click to minify', onclick: (e) => formatJson(e.altKey) }, 'Format');
    const top = h('header', { class: 'top' }, filesBtn, crumbs, h('span', { class: 'spacer' }), seg, saveBtn, fmtBtn, view, themeSel, openBtn, outlineBtn);

    const tree = h('div', { class: 'tree' });
    const files = h('aside', { class: 'files' }, h('h6', {}, 'Files'), tree);

    const head = h('div', { class: 'head' });
    const secs = h('div', { class: 'secs' });
    const doc = h('article', { class: 'doc' }, head, secs);
    const ta = h('textarea', { class: 'src', spellcheck: 'false', oninput: onInput, onkeydown: onEditorKey });
    const editor = h('section', { class: 'editor' }, h('div', { class: 'gutter' }, h('span', {}, 'markdown'), h('span', { class: 'wc' })), ta);
    const tabsEl = h('nav', { class: 'tabs', role: 'tablist' });
    const content = h('main', { class: 'content', onscroll: debounce(spy, 40) }, doc, editor);
    const centre = h('div', { class: 'centre' }, tabsEl, content);

    const toc = h('nav', { class: 'toc' });
    const meta = h('div', { class: 'meta' });
    const outline = h('aside', { class: 'outline' }, h('h6', {}, 'Outline'), toc, meta);
    const toast = h('div', { class: 'toast' });
    const hint = h('div', { class: 'hint', html: 'Edit <kbd>⌘E</kbd> · Save <kbd>⌘S</kbd> · Text size <kbd>⌘+</kbd><kbd>⌘−</kbd> · Width <kbd>⌘⇧W</kbd> · Themes <kbd>⌘⇧T</kbd>' });
    root.append(top, files, centre, outline, toast, hint);
    setTimeout(() => hint.classList.add('gone'), 6000);

    // ---------- rendering ----------
    // URL the current document lives at, for resolving relative image paths. The app hands over absolute file-system
    // paths; the extension hands over the page's own URL (http(s)/file), which is already a URL.
    function docBase() {
      if (!S.path || isUntitled(curTab())) return null;
      if (/^[a-z][a-z0-9+.-]*:/i.test(S.path)) return S.path;
      return 'file://' + S.path.split('/').map((seg) => encodeURIComponent(seg)).join('/');
    }
    // ---------- document kind ----------
    // A .json file, or an untitled tab whose pasted text is valid JSON, renders through core/json.js instead of
    // marked: a summary head, one section per top-level key, tables for arrays of flat objects, trees elsewhere.
    const IS_JSON = (p) => /\.json$/i.test((p || '').split(/[?#]/)[0]);
    const docKind = () => (curTab() && (isUntitled(curTab()) ? (global.JV && JV.looksLikeJson(S.text)) : IS_JSON(curDisp().name)) ? 'json' : 'md');
    function formatJson(minify) {
      if (docKind() !== 'json' || !global.JV) return flash('Not a JSON document');
      try {
        const next = minify ? JV.minify(S.text) : JV.format(S.text);
        if (next === S.text) return flash(minify ? 'Already minified' : 'Already formatted');
        setText(next); const t = curTab(); if (t) t.text = next; paint(); flash(minify ? 'Minified' : 'Formatted');
      } catch (e) { flash('Cannot format: ' + (e && e.message || e), 4000); }
    }
    function paint() {
      const kind = docKind();
      root.dataset.kind = kind;
      $('.gutter span', editor).textContent = kind;
      const r = kind === 'json' ? JV.renderDoc(S.text, { name: curDisp().name }) : MD.renderDoc(S.text, { base: docBase(), home: adapter.home });
      head.replaceChildren(...r.headEl.childNodes);
      // chips (sections theme shows them; others hide via CSS)
      head.append(h('nav', { class: 'chips' }, ...r.sectionEls.map((s) => h('a', { href: '#' + s.id, onclick: (e) => { e.preventDefault(); scrollTo(s.id); }, html: (s.el.querySelector('h2 .t') || {}).innerHTML || MD.esc(s.title) }))));
      secs.replaceChildren(...r.sectionEls.map((s) => h('section', { class: 'sec', 'data-i': s.index, id: 'sec-' + s.index },
        h('div', { class: 'tools' },
          kind === 'json' ? null : h('button', { 'data-act': 'edit', onclick: () => editSection(s.index) }, 'Edit section'),
          h('button', { 'data-act': 'copy', onclick: () => (kind === 'json' ? copyJsonSection(s.title) : copySection(s.index)) }, kind === 'json' ? 'Copy JSON' : 'Copy')),
        h('div', { class: 'body' }, ...s.el.childNodes))));
      toc.replaceChildren(...r.toc.filter((t) => t.lvl <= 3).map((t) => h('a', { class: 'l' + t.lvl, href: '#' + t.id, onclick: (e) => { e.preventDefault(); scrollTo(t.id); } }, t.text.replace(/^\d+[.)]\s*/, ''))));
      if (kind === 'json') {
        const lines = S.text.split('\n').length;
        meta.replaceChildren(h('div', {}, `${r.stats.sections} sections · ${r.stats.tables} tables`), h('div', {}, r.json.error ? 'invalid JSON' : `${lines} lines · valid JSON`));
        $('.wc', editor).textContent = lines + ' lines';
      } else {
        meta.replaceChildren(h('div', {}, `${r.stats.sections} sections · ${r.stats.tables} tables`), h('div', {}, `~${r.stats.words} words · ${r.stats.minutes} min read`));
        $('.wc', editor).textContent = r.stats.words + ' words';
      }
      const t = $('h1', head);
      document.title = (S.dirty ? '• ' : '') + (t ? t.textContent : curDisp().name);
      spy();
      checkPathLinks();
      wireTables();
    }
    function copyJsonSection(title) { navigator.clipboard.writeText(JV.sectionSource(S.text, title)).then(() => flash('JSON copied')); }
    // ---------- table filters ----------
    // Every table gets a funnel in each header cell (shown when the header is hovered). Clicking one reveals a row of
    // filter boxes, one per column; rows that do not match every filled box are hidden and a caption reports
    // "n of m rows". Text columns: case-insensitive substring, `!x` excludes. Numeric columns (the ones md.js marked
    // `.num`) also take `>N`, `>=N`, `<N`, `<=N`, `=N` and `A-B` ranges, reading "58.8 M", "1,935", "0.16 %" and
    // "49 ms" as numbers. Filters are AND-ed across columns and kept per document, so they survive a re-render and a
    // tab switch; Escape in an empty box (or the caption's ✕) clears them and closes the row.
    const NUM_MULT = { k: 1e3, m: 1e6, b: 1e9, g: 1e9, t: 1e12 };
    function cellNumber(text) {
      const s = String(text).replace(/[,\s]/g, '').replace(/[−–]/g, '-');
      const m = /^[~≈$€£+]*(-?\d+(?:\.\d+)?)(?:-\d+(?:\.\d+)?)?([kmbgt])?(?![a-z])/i.exec(s);
      return m ? parseFloat(m[1]) * (m[2] ? NUM_MULT[m[2].toLowerCase()] : 1) : null;
    }
    const qNumber = (n, u) => parseFloat(n.replace(/,/g, '')) * (u ? NUM_MULT[u.toLowerCase()] : 1);
    function filterPred(q, numeric) {
      q = q.trim(); if (!q) return null;
      if (numeric) {
        let m = /^(>=|<=|>|<|=)\s*(-?[\d.,]+)\s*([kmbgt])?$/i.exec(q);
        if (m) {
          const op = m[1], v = qNumber(m[2], m[3]);
          return (t) => { const n = cellNumber(t); return n !== null && (op === '>' ? n > v : op === '<' ? n < v : op === '>=' ? n >= v : op === '<=' ? n <= v : n === v); };
        }
        m = /^([\d.,]+)\s*([kmbgt])?\s*(?:\.\.|–|-)\s*([\d.,]+)\s*([kmbgt])?$/i.exec(q);
        if (m) {
          const lo = qNumber(m[1], m[2]), hi = qNumber(m[3], m[4]);
          return (t) => { const n = cellNumber(t); return n !== null && n >= Math.min(lo, hi) && n <= Math.max(lo, hi); };
        }
      }
      const neg = q.startsWith('!'); const needle = (neg ? q.slice(1) : q).trim().toLowerCase();
      if (!needle) return null;
      return (t) => t.toLowerCase().includes(needle) !== neg;
    }
    const FUNNEL = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M1.5 2.5h13L9.5 8.6V14l-3-1.6V8.6z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    function wireTables() {
      S.filters = S.filters || {};
      [...doc.querySelectorAll('.table-wrap > table')].forEach((table, ti) => {
        const ths = [...table.querySelectorAll('thead th')];
        const rows = [...table.querySelectorAll('tbody > tr')];
        if (!ths.length || !rows.length) return;
        const wrap = table.parentElement; wrap.classList.add('filterable');
        const st = S.filters[ti] || (S.filters[ti] = { q: ths.map(() => ''), all: '', open: false, col: -1 });
        while (st.q.length < ths.length) st.q.push('');
        const isNum = (c) => ths[c].classList.contains('num');
        const onEsc = (e, clearOne) => { e.stopPropagation(); if (e.target.value) clearOne(); else close(); };
        const inputs = ths.map((th, c) => h('input', {
          type: 'text', class: 'tf' + (isNum(c) ? ' num' : ''), value: st.q[c] || '', spellcheck: 'false', autocomplete: 'off',
          placeholder: isNum(c) ? '> < = a-b …' : 'Filter…', 'aria-label': 'Filter ' + th.textContent.trim(),
          onfocus: () => { st.col = c; },
          oninput: (e) => { st.q[c] = e.target.value; apply(); },
          onkeydown: (e) => {
            if (e.key === 'Escape') onEsc(e, () => { e.target.value = ''; st.q[c] = ''; apply(); });
            else if (e.key === 'Enter') { e.preventDefault(); const nx = inputs[c + 1] || inputs[0]; nx.focus(); nx.select(); }
          },
        }));
        const frow = h('tr', { class: 'filters' }, ...inputs.map((inp, c) => h('td', { class: ths[c].className }, inp)));
        table.tHead.appendChild(frow);
        // Bar above the table: one box that searches every column at once (space-separated words all have to appear
        // somewhere in the row; `!word` excludes), the row count, and clear. Shown while the filter row is open.
        const all = h('input', { type: 'text', class: 'tf-all', value: st.all || '', spellcheck: 'false', autocomplete: 'off', placeholder: 'Search whole table…', 'aria-label': 'Search whole table',
          onfocus: () => { st.col = -1; },
          oninput: (e) => { st.all = e.target.value; apply(); },
          onkeydown: (e) => { if (e.key === 'Escape') onEsc(e, () => { e.target.value = ''; st.all = ''; apply(); }); else if (e.key === 'Enter') { e.preventDefault(); inputs[0].focus(); } } });
        const count = h('span', { class: 'tf-count' });
        const bar = h('div', { class: 'tf-bar' }, h('span', { class: 'tf-ico', html: FUNNEL }), all, count, h('button', { class: 'tf-clear', title: 'Clear filters and close (Esc)', onclick: close, html: '&#x2715; clear' }));
        wrap.prepend(bar);
        // A funnel opens the row and focuses its column; clicking the funnel of the column you are already in closes it.
        ths.forEach((th, c) => th.append(h('button', { class: 'tf-btn', title: 'Filter this column', 'aria-label': 'Filter ' + th.textContent.trim(), html: FUNNEL,
          onclick: (e) => { e.stopPropagation(); if (st.open && st.col === c) return close(); open(); st.col = c; inputs[c].focus(); inputs[c].select(); } })));
        function open() { st.open = true; wrap.classList.add('filtering'); }
        function close() { st.q.fill(''); st.all = ''; all.value = ''; inputs.forEach((i) => { i.value = ''; }); st.open = false; st.col = -1; wrap.classList.remove('filtering'); apply(); }
        function rowPred(q) {
          const terms = q.trim().toLowerCase().split(/\s+/).filter((t) => t && t !== '!');
          if (!terms.length) return null;
          return (tr) => { const t = tr.textContent.toLowerCase(); return terms.every((w) => (w.startsWith('!') ? !t.includes(w.slice(1)) : t.includes(w))); };
        }
        function apply() {
          const preds = st.q.map((q, c) => filterPred(q || '', isNum(c)));
          const whole = rowPred(st.all || '');
          const active = !!whole || preds.some(Boolean);
          let shown = 0;
          rows.forEach((tr) => {
            const ok = (!whole || whole(tr)) && preds.every((p, c) => !p || p((tr.children[c] || {}).textContent || ''));
            tr.classList.toggle('f-hide', !ok); if (ok) shown++;
          });
          inputs.forEach((inp, c) => inp.classList.toggle('on', !!preds[c]));
          all.classList.toggle('on', !!whole);
          ths.forEach((th, c) => th.classList.toggle('filtered', !!preds[c]));
          wrap.classList.toggle('filtered', active);
          wrap.classList.toggle('f-none', active && shown === 0);
          count.textContent = active ? `${shown} of ${rows.length} rows` : `${rows.length} rows`;
        }
        if (st.open) wrap.classList.add('filtering');
        apply();
      });
    }
    // ---------- absolute paths written in the text ----------
    const IS_MD = (p) => /\.(md|markdown|mdown|mkd|json)$/i.test(p);
    const expandPath = (p) => (p.startsWith('~/') && adapter.home ? adapter.home + p.slice(1) : p);
    // Paths that do not exist on disk are shown as plain text, not links (app only: the extension has no fs access).
    async function checkPathLinks() {
      if (!adapter.statPath) return;
      const links = [...doc.querySelectorAll('a.path')];
      const seen = new Map();
      for (const a of links) {
        const p = expandPath(a.dataset.path);
        if (!seen.has(p)) seen.set(p, adapter.statPath(p).catch(() => null));
        const st = await seen.get(p);
        if (!a.isConnected) continue;
        if (!st || !st.exists) { a.classList.add('missing'); a.title = 'Not found on disk'; }
        else if (st.dir) { if (!a.dataset.path.endsWith('/')) a.classList.add('dir'); a.title = 'Show in Finder'; }
      }
    }
    async function openPathLink(raw, reveal) {
      const p = expandPath(raw);
      const st = adapter.statPath ? await adapter.statPath(p).catch(() => null) : null;
      if (st && !st.exists) return flash('Not found: ' + raw);
      if (reveal && adapter.reveal) return adapter.reveal(p);
      if (IS_MD(p) && adapter.readFile && (!st || !st.dir)) return loadFile(p).catch(() => flash('Could not open ' + raw)); // new tab, or focus the existing one
      if (adapter.openPath) return adapter.openPath(p); // .py / .csv / .txt / folders: hand to the OS
      if (adapter.reveal) return adapter.reveal(p);
      flash('Cannot open ' + raw + ' from here');
    }
    const livePaint = debounce(() => { if (S.mode === 'split') paint(); }, 160);
    function onInput() { setText(ta.value, true); livePaint(); }
    function setText(text, fromEditor) {
      S.text = text;
      if (!fromEditor) ta.value = text;
      setDirty(S.text !== S.saved);
      $('.wc', editor).textContent = text.split(/\s+/).filter(Boolean).length + ' words';
    }
    function setDirty(d) {
      if (d === S.dirty) return;
      S.dirty = d; root.classList.toggle('dirty', d); saveBtn.disabled = !d;
      document.title = (d ? '• ' : '') + document.title.replace(/^• /, '');
      const tb = tabsEl.children[S.tab]; if (tb) tb.classList.toggle('dirty', d);
      adapter.onDirty && adapter.onDirty(S.tabs.some((t, i) => (i === S.tab ? d : t.text !== t.saved)));
      notifyTabs();
    }
    function scrollTo(id) {
      const el = document.getElementById(id) || document.getElementById('sec-' + id);
      if (!el) return;
      const y = el.getBoundingClientRect().top - content.getBoundingClientRect().top + content.scrollTop - 24;
      content.scrollTo({ top: y, behavior: 'smooth' });
    }
    function spy() {
      const hs = [...doc.querySelectorAll('h1,h2,h3')];
      let cur = hs[0];
      const topY = content.getBoundingClientRect().top + 110;
      for (const el of hs) if (el.getBoundingClientRect().top < topY) cur = el;
      toc.querySelectorAll('a').forEach((a) => a.classList.toggle('active', !!cur && a.getAttribute('href') === '#' + cur.id));
    }

    // ---------- modes / theme / panels ----------
    function setMode(m, quiet) {
      if (S.editingSec !== null) finishSection(S.editingSec, true);
      S.mode = m; root.dataset.mode = m;
      seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
      if (m === 'read') paint(); else if (m === 'split') paint();
      if (m !== 'read') setTimeout(() => ta.focus(), 0);
      if (!quiet) adapter.setPref && adapter.setPref('mode', m);
    }
    function setTheme(t) {
      if (!THEMES.some((x) => x.id === t)) t = DEFAULT_THEME;
      S.theme = t; document.documentElement.dataset.theme = t; themeSel.value = t;
      refreeze();
      adapter.setPref && adapter.setPref('theme', t);
    }
    // ---------- zoom / reading width ----------
    // Auto-zoom: on wide screens a fixed 16px column looks tiny, so the document scales with the
    // content pane (1.0 at <=1200px, up to 1.5 at 2400px+), then the user's A-/A+ steps multiply it.
    function applyZoom() { root.style.setProperty('--zoom', (S.zoom * S.autoZoom).toFixed(3)); root.style.setProperty('--ui-zoom', (1 + (S.autoZoom - 1) * 0.6).toFixed(3)); zoomPct.textContent = pct() + '%'; }
    // ---------- magnification ----------
    // One zoom model. --zoom is the base (auto-zoom for wide panes times any saved text-size preference); --page is
    // the live magnifier that BOTH the trackpad pinch and the A-/A+ buttons drive. Chromium delivers a macOS pinch as
    // a wheel event with ctrlKey set. The document is frozen at its laid-out width and scaled as a whole (text,
    // tables and images together), the pane pans over it, and the document point under the pointer stays fixed on
    // screen. Magnification is kept across tab switches; ⌘0 or the percent button resets it.
    const PAGE_MIN = 0.5, PAGE_MAX = 4;
    const pct = () => Math.round(S.zoom * S.page * 100);
    const settlePage = debounce(() => flash('Zoom ' + pct() + '%'), 250);
    function applyPage() {
      zoomPct.textContent = pct() + '%'; zoomPct.classList.toggle('on', S.page !== 1);
      if (S.page === 1) { root.classList.remove('paged'); doc.style.width = ''; root.style.setProperty('--page', '1'); return; }
      if (!root.classList.contains('paged')) { doc.style.width = doc.offsetWidth + 'px'; root.classList.add('paged'); } // offsetWidth is in the doc's own px, unaffected by CSS zoom
      root.style.setProperty('--page', S.page.toFixed(3));
    }
    // The frozen layout width must follow a new reading width or theme, otherwise the ↔ button (and a theme switch)
    // does nothing while the page is magnified. Thaw, let the column re-lay out at the new --measure, freeze again
    // at the same magnification, keeping the same document point at the pane's centre.
    function refreeze() {
      if (!root.classList.contains('paged')) return;
      const b = content.getBoundingClientRect(), cx = b.left + b.width / 2, cy = b.top + b.height / 2;
      const before = doc.getBoundingClientRect(), fx = (cx - before.left) / before.width, fy = (cy - before.top) / before.height;
      root.classList.remove('paged'); doc.style.width = '';
      doc.style.width = doc.offsetWidth + 'px'; root.classList.add('paged');
      const after = doc.getBoundingClientRect();
      content.scrollLeft += after.left + fx * after.width - cx;
      content.scrollTop += after.top + fy * after.height - cy;
      gesture = null;
    }
    // The anchor is the document point under the pointer when the gesture STARTS, kept as a fraction of the (never
    // reflowing) document box. Every step re-solves the scroll offset against that same point, so rounding of the
    // scroll position cannot accumulate across the dozens of wheel events one pinch produces.
    let gesture = null;
    function anchorFor(cx, cy) {
      const now = performance.now();
      if (gesture && now - gesture.t < 250 && Math.abs(cx - gesture.ax) < 4 && Math.abs(cy - gesture.ay) < 4) { gesture.t = now; return gesture; }
      const b = doc.getBoundingClientRect();
      gesture = { fx: (cx - b.left) / b.width, fy: (cy - b.top) / b.height, ax: cx, ay: cy, t: now };
      return gesture;
    }
    function setPage(k, cx, cy) {
      k = Math.round(Math.min(PAGE_MAX, Math.max(PAGE_MIN, k)) * 1000) / 1000;
      if (k === S.page) return;
      if (cx == null) { const b = content.getBoundingClientRect(); cx = b.left + b.width / 2; cy = b.top + b.height / 2; gesture = null; } // buttons / keys: zoom about the pane centre
      const a = anchorFor(cx, cy);
      S.page = k; applyPage();
      const after = doc.getBoundingClientRect(); // forces layout; the scaled doc may have re-centred
      content.scrollLeft += after.left + a.fx * after.width - a.ax;
      content.scrollTop += after.top + a.fy * after.height - a.ay;
      settlePage();
    }
    function stepZoom(dir) { setPage(S.page * (dir > 0 ? 1.1 : 1 / 1.1)); }
    function resetZoom() { if (S.page !== 1) { S.page = 1; applyPage(); } flash('Zoom ' + pct() + '%'); }
    content.addEventListener('wheel', (e) => {
      if (!e.ctrlKey || e.deltaY === 0) return;
      e.preventDefault(); // otherwise the pane scrolls while the gesture is in progress
      setPage(S.page * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
    }, { passive: false });
    function setWidth(w) {
      if (!WIDTHS.includes(w)) w = 'auto';
      S.width = w; root.dataset.width = w; widthBtn.dataset.w = w;
      refreeze();
      adapter.setPref && adapter.setPref('width', w);
    }
    function cycleWidth() { const w = WIDTHS[(WIDTHS.indexOf(S.width) + 1) % WIDTHS.length]; setWidth(w); flash('Width: ' + w); }
    if (global.ResizeObserver) {
      new ResizeObserver((es) => {
        const w = es[0].contentRect.width; const z = Math.min(1.5, Math.max(1, w / 1200));
        if (Math.abs(z - S.autoZoom) > 0.01) { S.autoZoom = z; applyZoom(); }
      }).observe(content);
    }
    function cycleTheme() { const i = THEMES.findIndex((t) => t.id === S.theme); setTheme(THEMES[(i + 1) % THEMES.length].id); flash('Theme: ' + THEMES[(i + 1) % THEMES.length].name); }
    function togglePanel(p, force) {
      if (p === 'files' && !adapter.listDir) force = false;
      S[p] = force === undefined ? !S[p] : force;
      root.classList.toggle('no-' + p, !S[p]);
      if (p === 'outline') outlineBtn.classList.toggle('off', !S[p]);
      if (p === 'files' && filesBtn) filesBtn.classList.toggle('off', !S[p]);
      if (!(p === 'files' && !adapter.listDir)) adapter.setPref && adapter.setPref(p, S[p]);
    }
    function flash(msg, ms = 1600) { toast.textContent = msg; toast.classList.add('show'); clearTimeout(flash.t); flash.t = setTimeout(() => toast.classList.remove('show'), ms); }

    // ---------- per-section editing ----------
    function editSection(i) {
      if (docKind() === 'json') return; // JSON has no markdown sections to splice; use Edit mode
      if (S.editingSec !== null && S.editingSec !== i) finishSection(S.editingSec, true);
      const { sections } = MD.split(S.text);
      const sec = secs.querySelector(`.sec[data-i="${i}"]`);
      if (!sec || !sections[i]) return;
      S.editingSec = i;
      sec.classList.add('editing');
      const t = h('textarea', { class: 'sec-src', spellcheck: 'false', onkeydown: (e) => { if (e.key === 'Escape') finishSection(i, false); if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') finishSection(i, true); } });
      t.value = sections[i].src;
      sec.append(t);
      t.style.height = Math.max(220, Math.min(innerHeight * 0.7, t.scrollHeight + 20)) + 'px';
      const b = sec.querySelector('[data-act=edit]'); b.textContent = 'Done'; b.onclick = () => finishSection(i, true);
      const c = sec.querySelector('[data-act=copy]'); c.textContent = 'Cancel'; c.onclick = () => finishSection(i, false);
      t.focus();
    }
    function finishSection(i, apply) {
      const sec = secs.querySelector(`.sec[data-i="${i}"]`);
      const t = sec && sec.querySelector('.sec-src');
      if (t && apply) {
        const { sections, lines } = MD.split(S.text);
        const s = sections[i];
        const next = [...lines.slice(0, s.start), ...t.value.replace(/\n$/, '').split('\n'), ...lines.slice(s.end)].join('\n');
        setText(next);
      }
      S.editingSec = null;
      paint();
    }
    function copySection(i) {
      const { sections } = MD.split(S.text);
      if (sections[i]) navigator.clipboard.writeText(sections[i].src).then(() => flash('Section copied'));
    }

    // ---------- files ----------
    // ---------- tabs ----------
    // loadFile(path) opens the file in a tab (focusing it if already open). Every open path -- file tree,
    // ⌘O, Finder, relative links -- goes through here, so a window never gets replaced, it gets a tab.
    async function loadFile(path) {
      const existing = S.tabs.findIndex((t) => t.path === path);
      if (existing >= 0) return showTab(existing);
      // Two opens for the same path can arrive before either finishes reading (a restored session, or Finder
      // sending several files at once), so reserve the tab before the await rather than after it.
      if (S.loading.has(path)) return S.loading.get(path);
      const p = (async () => {
        const text = await adapter.readFile(path);
        stashActive();
        S.tabs.push({ path, text, saved: text, scroll: 0 });
        renderTabs();
        await showTab(S.tabs.length - 1, true);
      })().finally(() => S.loading.delete(path));
      S.loading.set(path, p);
      return p;
    }
    // newTab() opens an empty untitled tab in edit mode with the editor focused, so a ⌘V lands straight in it.
    // The mode change is not persisted: the next launch should still open in the mode the user had chosen.
    async function newTab() {
      stashActive();
      const n = ++S.untitledSeq;
      S.tabs.push({ path: 'untitled:' + n, untitled: true, name: 'Untitled ' + n, text: '', saved: '', scroll: 0 });
      renderTabs();
      await showTab(S.tabs.length - 1, true);
      setMode('edit', true);
    }
    function stashActive() {
      const t = S.tabs[S.tab]; if (!t) return;
      if (S.editingSec !== null) finishSection(S.editingSec, true);
      t.text = S.text; t.saved = S.saved; t.scroll = content.scrollTop; t.filters = S.filters;
    }
    async function showTab(i, fresh) {
      if (i < 0 || i >= S.tabs.length) return;
      if (i !== S.tab) stashActive();
      S.tab = i; const t = S.tabs[i];
      S.path = t.path; S.saved = t.saved; S.filters = t.filters || {}; setText(t.text); setDirty(t.text !== t.saved);
      const d = dispOf(t);
      ta.placeholder = isUntitled(t) ? 'Paste or type Markdown or JSON here…' : '';
      renderCrumbs(d);
      paint();
      content.scrollTop = fresh ? 0 : t.scroll;
      [...tabsEl.querySelectorAll('.tab')].forEach((el, j) => { el.classList.toggle('on', j === i); el.setAttribute('aria-selected', j === i); });
      const on = tabsEl.children[i]; on && on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      if (adapter.listDir && d.dir) buildTree(d.dir);
      tree.querySelectorAll('.file').forEach((f) => f.classList.toggle('on', f.dataset.path === t.path));
      notifyTabs();
    }
    function renderTabs() {
      tabsEl.replaceChildren(...S.tabs.map((t, i) => {
        const d = dispOf(t);
        return h('div', { class: 'tab' + (i === S.tab ? ' on' : '') + (t.text !== t.saved ? ' dirty' : '') + (isUntitled(t) ? ' untitled' : ''), role: 'tab', title: isUntitled(t) ? 'Unsaved document' : t.path, 'data-path': t.path,
          onclick: (e) => { if (!e.target.closest('.x')) showTab(i); }, onauxclick: (e) => { if (e.button === 1) { e.preventDefault(); closeTab(i); } } },
          h('span', { class: 'name' }, d.name), h('span', { class: 'dot' }), h('button', { class: 'x', title: 'Close (⌘W)', onclick: (e) => { e.stopPropagation(); closeTab(i); }, html: '&#x2715;' }));
      }), h('button', { class: 'tab-new', title: 'New tab (⌘T)', onclick: () => newTab(), html: '+' }));
      root.classList.toggle('has-tabs', S.tabs.length > 0);
      root.classList.toggle('multi-tabs', S.tabs.length > 1);
    }
    // Writes a tab's text. An untitled tab has no path: the adapter asks where to save (hinted with the extension the
    // content calls for -- .json when the pasted text is JSON) and returns the path, which the tab then adopts (it
    // becomes an ordinary file tab). Throws if the user cancels.
    async function writeTab(t) {
      const ext = isUntitled(t) && global.JV && JV.looksLikeJson(t.text) ? 'json' : 'md';
      const p = await adapter.writeFile(isUntitled(t) ? null : t.path, t.text, { ext });
      t.saved = t.text;
      if (isUntitled(t) && typeof p === 'string' && p) {
        t.untitled = false; t.name = undefined; t.path = p;
        if (t === curTab()) { S.path = p; ta.placeholder = ''; renderCrumbs(dispOf(t)); if (adapter.listDir) buildTree(dispOf(t).dir); }
        renderTabs();
      }
      return p;
    }
    async function closeTab(i = S.tab) {
      const t = S.tabs[i]; if (!t) return false;
      if (i === S.tab) stashActive();
      if (t.text !== t.saved) {
        const d = dispOf(t);
        const r = adapter.confirmDiscard ? await adapter.confirmDiscard(d.name) : (confirm(`Discard unsaved changes to ${d.name}?`) ? 'discard' : 'cancel');
        if (r === 'cancel') return false;
        if (r === 'save') { try { await writeTab(t); } catch (e) { if (!/cancel/i.test(e && e.message || '')) flash('Save failed: ' + (e && e.message || e), 4000); return false; } }
      }
      S.tabs.splice(i, 1);
      if (!S.tabs.length) {
        S.tab = -1; S.path = null; S.text = ''; S.saved = ''; ta.value = ''; setDirty(false);
        head.replaceChildren(); secs.replaceChildren(); toc.replaceChildren(); meta.replaceChildren(); crumbs.replaceChildren();
        delete root.dataset.kind;
        renderTabs(); document.title = 'MdReader'; notifyTabs();
        adapter.onLastTabClosed && adapter.onLastTabClosed();
        return true;
      }
      const next = Math.min(i <= S.tab ? S.tab - (i < S.tab ? 1 : 0) : S.tab, S.tabs.length - 1);
      S.tab = -1; // force a full switch
      renderTabs();
      await showTab(Math.max(0, next));
      return true;
    }
    function nextTab(dir) { if (S.tabs.length > 1) showTab((S.tab + dir + S.tabs.length) % S.tabs.length); }
    // Untitled tabs are left out of the reported path set: the host has no file to watch or restore for them.
    function notifyTabs() { adapter.onTabsChanged && adapter.onTabsChanged({ paths: S.tabs.filter((t) => !isUntitled(t)).map((t) => t.path), active: isUntitled(curTab()) ? null : S.path, dirty: S.tabs.map((t, i) => (i === S.tab ? S.dirty : t.text !== t.saved)) }); }
    // Breadcrumbs. When the adapter supplies crumbPaths (one folder path per crumb), each crumb is a button that
    // re-roots the Files tree at that folder and expands it down to the open file; the file name locates the file
    // in the tree; ⌖ reveals it in Finder when the adapter can.
    function renderCrumbs(d) {
      const clickable = adapter.listDir && Array.isArray(d.crumbPaths) && d.crumbPaths.length === d.crumbs.length;
      const parts = d.crumbs.flatMap((c, i) => [
        clickable
          ? h('button', { class: 'c', title: 'Show this folder in Files', onclick: () => rootTreeAt(d.crumbPaths[i]) }, c)
          : h('span', { class: 'c' }, c),
        h('span', { class: 'sl' }, '/')]);
      const name = clickable
        ? h('b', { class: 'name', title: 'Locate in Files', onclick: () => rootTreeAt(d.crumbPaths[d.crumbPaths.length - 1] || d.dir), role: 'button', tabindex: 0 }, d.name)
        : h('b', {}, d.name);
      const reveal = adapter.reveal && d.dir ? h('button', { class: 'icon reveal', title: 'Show in Finder (⌘⇧R)', onclick: () => adapter.reveal(S.path), html: '&#x2316;' }) : null;
      crumbs.replaceChildren(...[...parts, name, h('span', { class: 'dot', title: 'unsaved changes' }), reveal].filter(Boolean));
    }
    async function rootTreeAt(dir) {
      if (!dir) return;
      togglePanel('files', true);
      await buildTree(dir);
      await expandTo(S.path);
    }
    // Open every folder between the tree root and the file's folder, then highlight the file and scroll it into view.
    async function expandTo(file) {
      if (!file || !S.tree) return;
      const fileDir = file.slice(0, file.lastIndexOf('/')) || '/';
      if (fileDir !== S.tree && !fileDir.startsWith(S.tree.replace(/\/$/, '') + '/')) return;
      let cur = S.tree.replace(/\/$/, '');
      const rest = fileDir.slice(cur.length).split('/').filter(Boolean);
      for (const seg of rest) {
        cur += '/' + seg;
        const node = tree.querySelector(`.folder[data-path="${CSS.escape(cur)}"]`);
        if (!node) break;
        const kids = node.querySelector(':scope > .kids');
        if (!node.classList.contains('open')) { node.classList.add('open'); if (!kids.childElementCount) await fillFolder(cur, kids); }
      }
      tree.querySelectorAll('.file').forEach((f) => f.classList.toggle('on', f.dataset.path === file));
      const on = tree.querySelector('.file.on'); on && on.scrollIntoView({ block: 'center' });
    }
    async function buildTree(dir) {
      if (S.tree === dir) return;
      S.tree = dir;
      tree.replaceChildren(await folderNode(dir, true));
    }
    async function folderNode(dir, open) {
      const name = dir.split('/').filter(Boolean).pop() || dir;
      const kids = h('div', { class: 'kids' });
      const node = h('div', { class: 'folder' + (open ? ' open' : ''), 'data-path': dir },
        h('div', { class: 'label', onclick: async () => { const o = node.classList.toggle('open'); if (o && !kids.childElementCount) await fillFolder(dir, kids); } }, h('span', { class: 'tri' }), name), kids);
      if (open) await fillFolder(dir, kids);
      return node;
    }
    async function fillFolder(dir, kids) {
      let entries = [];
      try { entries = await adapter.listDir(dir); } catch (e) { kids.append(h('div', { class: 'empty' }, 'not readable')); return; }
      const dirs = entries.filter((e) => e.dir && !e.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name));
      const mds = entries.filter((e) => !e.dir && /\.(md|markdown|mdown|txt|json)$/i.test(e.name)).sort((a, b) => a.name.localeCompare(b.name));
      for (const d of dirs) kids.append(await folderNode(d.path, false));
      for (const f of mds) kids.append(h('div', { class: 'file' + (f.path === S.path ? ' on' : ''), 'data-path': f.path, title: f.name, onclick: () => loadFile(f.path) }, f.name));
      if (!dirs.length && !mds.length) kids.append(h('div', { class: 'empty' }, 'no markdown here'));
    }
    async function openDialog() { const p = await adapter.openDialog(); if (p) loadFile(p); }

    // ---------- save ----------
    async function save() {
      const t = curTab();
      if (!t) return flash('Nothing to save');
      if (isUntitled(t) && !adapter.canSave()) return flash('Cannot save from here');
      if (S.editingSec !== null) finishSection(S.editingSec, true);
      t.text = S.text;
      try {
        await writeTab(t);
        S.saved = S.text; setDirty(false); notifyTabs();
        flash('Saved ' + dispOf(t).name);
      } catch (e) { if (!/cancel/i.test(e && e.message || '')) flash('Save failed: ' + (e && e.message || e), 4000); }
    }

    // ---------- keys ----------
    function onEditorKey(e) {
      if (e.key === 'Tab') { e.preventDefault(); const s = ta.selectionStart, en = ta.selectionEnd; ta.setRangeText('  ', s, en, 'end'); onInput(); }
    }
    addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key === 'Tab') { e.preventDefault(); return nextTab(e.shiftKey ? -1 : 1); }
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) { e.preventDefault(); return nextTab(e.key === 'ArrowRight' ? 1 : -1); }
      if (k === 'w' && !e.shiftKey && S.tabs.length) { e.preventDefault(); return closeTab(); }
      if (k === 't' && !e.shiftKey) { e.preventDefault(); return newTab(); }
      if (k === 's') { e.preventDefault(); save(); }
      else if (k === 'e' && !e.shiftKey) { e.preventDefault(); setMode(S.mode === 'read' ? 'edit' : 'read'); }
      else if (k === '1') { e.preventDefault(); setMode('read'); } else if (k === '2') { e.preventDefault(); setMode('edit'); } else if (k === '3') { e.preventDefault(); setMode('split'); }
      else if (k === '\\') { e.preventDefault(); adapter.listDir && togglePanel('files'); }
      else if (k === '/') { e.preventDefault(); togglePanel('outline'); }
      else if (k === 't' && e.shiftKey) { e.preventDefault(); cycleTheme(); }
      else if (k === 'f' && e.shiftKey) { e.preventDefault(); formatJson(e.altKey); }
      else if (k === 'w' && e.shiftKey) { e.preventDefault(); cycleWidth(); }
      else if (k === '=' || k === '+') { e.preventDefault(); stepZoom(1); }
      else if (k === '-' || k === '_') { e.preventDefault(); stepZoom(-1); }
      else if (k === '0') { e.preventDefault(); resetZoom(); }
      else if (k === 'o' && adapter.openDialog) { e.preventDefault(); openDialog(); }
    });
    // Double-click on the empty part of the tab strip opens a new untitled tab (like a browser).
    tabsEl.addEventListener('dblclick', (e) => { if (e.target === tabsEl) newTab(); });
    // Pasting onto an empty untitled tab while reading fills it, so ⌘T then ⌘V works in any mode.
    addEventListener('paste', (e) => {
      const t = curTab();
      if (!isUntitled(t) || S.mode !== 'read' || S.text.trim() || /^(TEXTAREA|INPUT)$/.test((e.target.tagName || '').toUpperCase())) return;
      const md = e.clipboardData && e.clipboardData.getData('text/plain'); if (!md) return;
      e.preventDefault(); setText(md); t.text = md; paint(); notifyTabs();
    });
    doc.addEventListener('click', (e) => {
      const a = e.target.closest('a[href]'); if (!a) return;
      if (a.dataset.path) { e.preventDefault(); openPathLink(a.dataset.path, e.metaKey || e.ctrlKey); return; }
      const href = a.getAttribute('href');
      if (href.startsWith('#')) { e.preventDefault(); scrollTo(href.slice(1)); }
      else if (/^https?:/.test(href)) { e.preventDefault(); adapter.openExternal && adapter.openExternal(href); }
      else if (/^[a-z]+:/i.test(href)) { e.preventDefault(); } // mailto:, file:, etc. -- never navigate the shell
      else {
        // Relative link: open sibling .md files in the reader; anything else is ignored rather than navigating away.
        e.preventDefault();
        if (/\.(md|markdown|mdown|mkd|json)(#.*)?$/i.test(href) && S.path && adapter.readFile) {
          const base = S.path.slice(0, S.path.lastIndexOf('/') + 1);
          const target = href.split('#')[0].split('/').reduce((acc, seg) => { if (seg === '..') acc.pop(); else if (seg && seg !== '.') acc.push(seg); return acc; }, base.split('/').filter(Boolean));
          loadFile('/' + target.join('/')).catch(() => flash('Could not open ' + href));
        }
      }
    });
    adapter.onExternalChange && adapter.onExternalChange(async (path) => {
      const i = S.tabs.findIndex((t) => t.path === path); if (i < 0) return;
      const text = await adapter.readFile(path);
      if (i === S.tab) { if (S.dirty) return; S.saved = text; setText(text); S.tabs[i].text = S.tabs[i].saved = text; paint(); flash('Reloaded (changed on disk)'); }
      else { const t = S.tabs[i]; if (t.text === t.saved) { t.text = t.saved = text; } }
    });

    // ---------- init ----------
    (async () => {
      const g = async (k, d) => { try { const v = adapter.getPref ? await adapter.getPref(k) : undefined; return v === undefined || v === null ? d : v; } catch { return d; } };
      setTheme(await g('theme', DEFAULT_THEME));
      togglePanel('files', adapter.listDir ? await g('files', true) : false);
      togglePanel('outline', await g('outline', true));
      { const z = +(await g('zoom', 1)); S.zoom = z >= ZOOM_STEPS[0] && z <= ZOOM_STEPS[ZOOM_STEPS.length - 1] ? Math.round(z * 100) / 100 : 1; } applyZoom();
      setWidth(await g('width', 'auto'));
      setMode('read');
      saveBtn.disabled = true;
    })();

    return { loadFile, newTab, closeTab, nextTab, showTab, setWidth, stepZoom, resetZoom, cycleWidth,
      saveAll: async () => { stashActive(); for (const t of S.tabs) if (t.text !== t.saved) await writeTab(t); if (S.tabs[S.tab]) { S.saved = S.tabs[S.tab].saved; S.path = S.tabs[S.tab].path; setDirty(false); } notifyTabs(); },
      setText: (t, path) => { S.path = path || S.path; S.saved = t; setText(t); setDirty(false); const tb = S.tabs[S.tab]; if (tb) { tb.text = tb.saved = t; } paint(); }, setTheme, setMode, save, get state() { return S; } };
  }

  global.MdShell = { mount, THEMES, WIDTHS };
})(window);
