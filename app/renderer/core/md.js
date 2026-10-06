// MdReader core renderer.
// Wraps `marked` (GFM) and adds the things that make tables and long docs readable:
//  - numeric-column detection (right-aligned, tabular mono digits)
//  - total-row detection (all-bold cells -> tinted band)
//  - stable heading ids + a TOC
//  - splitting a document into sections at each `## ` so themes can render cards
//    and the shell can edit one section at a time.
(function (global) {
  const marked = global.marked;
  marked.use({ gfm: true, breaks: false, mangle: false, headerIds: false });

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // Fenced code. marked keeps only the first word of the info string as the language, so a fence written as
  // "```WITH p AS (" (opening line glued to the fence -- easy to do when a doc is generated) loses its first line and
  // grows a bogus "WITH" badge. If the info string is not a plain language token, it is that first line: put it back.
  marked.use({
    renderer: {
      code({ text, lang }) {
        let info = (lang || '').trim(), code = text;
        if (info && (/\s|[^\w.+#-]/.test(info) || (global.HL && !HL.alias(info) && /[()=:;'"]/.test(info)))) { code = info + '\n' + code; info = ''; }
        const cls = info ? ` class="language-${esc(info)}"` : '';
        return `<pre><code${cls}>${esc(code)}\n</code></pre>\n`;
      },
    },
  });
  const slugify = (t) => t.toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '').replace(/[^a-z0-9\u00C0-\uFFFF]+/g, '-').replace(/(^-|-$)/g, '') || 'section';

  // Loose numeric test: "58.8 M", "+20–30", "0.16 %", "~1.3 s", "—", "1,935", "+400–600 ms"
  const NUM_RE = /^[\s$€£~≈+\-−–]*[\d.,]+(\s*[–\-−]\s*[\d.,]+)?\s*(%|ms|s|m|h|d|M|K|B|G|T|×|x|pts?|rps|tps|qps)?\s*$/i;
  const isNumeric = (t) => {
    const s = t.replace(/<[^>]+>/g, '').replace(/\*\*/g, '').trim();
    return s === '' ? null : (NUM_RE.test(s) || /^[—–-]$/.test(s));
  };

  // Post-process rendered tables in a detached DOM.
  function decorateTables(root) {
    root.querySelectorAll('table').forEach((table) => {
      const head = [...table.querySelectorAll('thead th')];
      const rows = [...table.querySelectorAll('tbody tr')];
      const cols = head.length;
      for (let c = 0; c < cols; c++) {
        const cells = rows.map((r) => r.children[c]).filter(Boolean);
        const judged = cells.map((td) => isNumeric(td.textContent)).filter((v) => v !== null);
        if (judged.length && judged.filter(Boolean).length / judged.length >= 0.6) {
          head[c].classList.add('num');
          cells.forEach((td) => td.classList.add('num'));
        }
        // marked emits inline style="text-align" for aligned columns; keep but map to a class.
        const align = head[c].getAttribute('align') || head[c].style.textAlign;
        if (align) { head[c].classList.add('align-' + align); cells.forEach((td) => td.classList.add('align-' + align)); }
      }
      rows.forEach((tr) => {
        const tds = [...tr.children];
        const filled = tds.filter((td) => td.textContent.trim() !== '');
        const allStrong = filled.length && filled.every((td) => {
          const kids = [...td.childNodes].filter((n) => !(n.nodeType === 3 && !n.textContent.trim()));
          return kids.length === 1 && kids[0].nodeName === 'STRONG';
        });
        if (allStrong) tr.classList.add('total');
      });
      // wrap for horizontal scroll
      if (!table.parentElement.classList.contains('table-wrap')) {
        const wrap = document.createElement('div');
        wrap.className = 'table-wrap';
        if (table.dataset.l0) { wrap.dataset.l0 = table.dataset.l0; wrap.dataset.l1 = table.dataset.l1; delete table.dataset.l0; delete table.dataset.l1; }
        table.replaceWith(wrap);
        wrap.appendChild(table);
      }
    });
  }

  function decorateHeadings(root, toc, used) {
    root.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((h) => {
      let id = slugify(h.textContent);
      let n = 1;
      while (used.has(id)) id = slugify(h.textContent) + '-' + ++n;
      used.add(id);
      h.id = id;
      toc.push({ lvl: +h.tagName[1], text: h.textContent, html: h.innerHTML, id });
    });
  }

  function decorateMisc(root, opts) {
    root.querySelectorAll('pre > code').forEach((code) => decorateCode(code.parentElement, code));
    root.querySelectorAll('input[type=checkbox]').forEach((cb) => { cb.disabled = true; cb.closest('li')?.classList.add('task'); });
    root.querySelectorAll('a[href^="http"]').forEach((a) => { a.target = '_blank'; a.rel = 'noopener'; });
    root.querySelectorAll('img[src]').forEach((img) => img.setAttribute('data-src-written', img.getAttribute('src')));
    rebaseImages(root, opts && opts.base, opts && opts.home);
    markMissingImages(root);
    linkifyPaths(root);
  }

  // A fenced block becomes <div class="codeblock" data-lang><div class="codebar">lang · Copy</div><pre class="code">
  // <code class="hl">…</code></pre></div>: tokens coloured by core/hl.js (language from the fence, or detected when the
  // fence has none), a header that stays put while the code scrolls sideways, and a line-number gutter once the block
  // is long enough for numbers to help (8+ lines). The source-line stamp moves from the <pre> onto the wrapper, like
  // .table-wrap, so the split view keeps locking to it. The <code>'s DOM text stays exactly the source (see hl.js).
  const LANG_LABEL = { javascript: 'JavaScript', typescript: 'TypeScript', python: 'Python', bash: 'Shell', sql: 'SQL', json: 'JSON', yaml: 'YAML', html: 'HTML', css: 'CSS', diff: 'Diff', markdown: 'Markdown', java: 'Java', ini: 'Config', http: 'HTTP' };
  function decorateCode(pre, code) {
    if (pre.parentElement && pre.parentElement.classList.contains('codeblock')) return;
    const src = code.textContent.replace(/\n$/, '');
    const langCls = [...code.classList].find((c) => c.startsWith('language-'));
    const asked = langCls ? langCls.slice(9) : '';
    // A ```mermaid fence (or an untagged fence that starts with a diagram word) is drawn, not shown as code: core/diagram.js
    // builds the card; the source-line stamp moves onto it so the split view locks to the picture.
    if (global.DG && (/^(mermaid|mmd)$/i.test(asked) || (!asked && DG.looksLike(src)))) {
      const card = DG.card(src);
      if (pre.dataset.l0) { card.dataset.l0 = pre.dataset.l0; card.dataset.l1 = pre.dataset.l1; }
      pre.replaceWith(card);
      return;
    }
    let lang = asked, html = null, lines = src.split('\n').length;
    if (global.HL) { const r = HL.highlight(src, asked); html = r.html; lang = r.lang || asked; lines = r.lines; }
    if (html !== null) code.innerHTML = html;
    code.classList.add('hl');
    pre.classList.add('code');
    const wrap = document.createElement('div');
    wrap.className = 'codeblock';
    if (lang) { wrap.dataset.lang = lang; wrap.dataset.label = LANG_LABEL[lang] || asked || lang; }
    if (lines >= 8) { wrap.classList.add('numbered'); wrap.style.setProperty('--gutter', String(lines).length + 'ch'); }
    if (pre.dataset.l0) { wrap.dataset.l0 = pre.dataset.l0; wrap.dataset.l1 = pre.dataset.l1; delete pre.dataset.l0; delete pre.dataset.l1; }
    const bar = document.createElement('div');
    bar.className = 'codebar';
    bar.innerHTML = `<span class="lang">${esc(wrap.dataset.label || '')}</span><span class="lc">${lines} line${lines === 1 ? '' : 's'}</span><button type="button" class="copy" title="Copy code">Copy</button>`;
    pre.replaceWith(wrap);
    wrap.append(bar, pre);
  }

  // `![x](diagrams/out/a.png)` is relative to the .md FILE, but the page rendering it lives elsewhere (the app bundle,
  // or the extension's viewer), so the browser would resolve it against the wrong folder and show nothing. Resolve
  // every image against `base` (the document's own URL/dir) at render time; `~/x.png` expands to the home folder.
  function rebaseImages(root, base, home) {
    if (!base) return;
    let baseUrl; try { baseUrl = new URL(base); } catch { return; }
    root.querySelectorAll('img[src]').forEach((img) => {
      let src = img.getAttribute('src') || '';
      if (!src || /^(data|blob|https?|file|chrome-extension):/i.test(src)) return;
      if (home && src.startsWith('~/')) src = home + src.slice(1);
      try {
        // A path is not a URL: percent-encode it segment-wise so spaces and '#' survive, but keep an existing "%20".
        const enc = /%[0-9a-f]{2}/i.test(src) ? src : src.split('/').map((s) => encodeURIComponent(s)).join('/');
        img.src = new URL(enc, baseUrl).href;
        img.loading = 'lazy';
      } catch { /* leave as written */ }
    });
  }

  // A picture whose file is not there would otherwise show as a tiny broken icon (or nothing), with no hint why.
  // Replace it with a quiet box that names the file and the folder it was looked for in.
  function markMissingImages(root) {
    root.querySelectorAll('img[src]').forEach((img) => {
      const miss = () => {
        if (img.dataset.missing || !img.parentNode) return;
        img.dataset.missing = '1';
        const written = img.getAttribute('data-src-written') || img.getAttribute('src') || '';
        let where = '';
        try { const u = new URL(img.src); if (u.protocol === 'file:') where = decodeURIComponent(u.pathname); else where = u.href; } catch { where = img.src; }
        const box = document.createElement('span');
        box.className = 'imgmissing';
        box.title = where;
        const t = document.createElement('b'); t.textContent = 'Picture not found';
        const f = document.createElement('code'); f.textContent = written.split('/').pop() || written;
        const w = document.createElement('span'); w.className = 'imgwhere';
        w.textContent = where ? 'looked for ' + where : '';
        box.append(t, ' · ', f, img.alt ? ' — ' + img.alt : '', document.createElement('br'), w);
        img.replaceWith(box);
      };
      if (img.complete && img.naturalWidth === 0 && img.src) miss();
      img.addEventListener('error', miss, { once: true });
    });
  }

  // Absolute file-system paths written as plain text (`/Users/me/notes/x.md`, `~/Documents/a.csv`, `/tmp/dir/`)
  // become <a class="path" data-path> links. The shell decides what a click does (open .md as a tab, hand other
  // files to the OS). Two or more segments are required so "/day" or "get / batch-get" never match; URLs are
  // skipped because their slashes follow ":" or "/", never a boundary character.
  const PATH_RE = /(?<![\w:/.~\-])(~?\/(?:[\w.@%+\-]+\/)+[\w.@%+\-]*)/g;
  const IS_PATH = /^~?\/(?:[\w.@%+\-]+\/)+[\w.@%+\-]*$/;
  const trimPath = (p) => p.replace(/[.,;:]+$/, ''); // "…/x.py." at a sentence end
  function pathLink(p) {
    const a = document.createElement('a');
    a.className = 'path'; a.href = '#'; a.dataset.path = p; a.textContent = p;
    a.title = /\.(md|markdown|mdown|mkd)$/i.test(p) ? 'Open in a new tab' : (p.endsWith('/') ? 'Show in Finder' : 'Open with its default app · ⌘-click to show in Finder');
    return a;
  }
  function linkifyPaths(root) {
    // Whole-content inline code chips: `/Users/me/x.py`
    root.querySelectorAll('code').forEach((code) => {
      if (code.closest('pre, a')) return;
      const t = code.textContent.trim();
      if (!IS_PATH.test(t)) return;
      const a = pathLink(t); a.textContent = ''; a.appendChild(code.cloneNode(true)); code.replaceWith(a);
    });
    // Plain text nodes
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement.closest('a, pre, code, script, style') ? NodeFilter.FILTER_REJECT : (n.nodeValue.includes('/') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP)) });
    const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach((n) => {
      const s = n.nodeValue; let last = 0, m; const frag = document.createDocumentFragment(); PATH_RE.lastIndex = 0;
      while ((m = PATH_RE.exec(s))) {
        const raw = m[1], p = trimPath(raw);
        if (p.split('/').length < 3) continue;
        frag.appendChild(document.createTextNode(s.slice(last, m.index)));
        frag.appendChild(pathLink(p));
        last = m.index + p.length;
      }
      if (!last) return;
      frag.appendChild(document.createTextNode(s.slice(last)));
      n.replaceWith(frag);
    });
  }

  // Render one chunk of markdown to an element; decorate; return toc entries.
  // Every block-level element is stamped with the source lines it came from (data-l0 inclusive, data-l1 exclusive,
  // counted from the start of the whole document via opts.lineOff): the shell uses them to lock the split view's
  // two panes together and to mirror a selection from one side onto the other. Blocks are rendered one token at a
  // time from the lexer, whose token.raw slices are contiguous in the source, so the stamps are exact.
  const countNl = (s) => { let n = 0, i = -1; while ((i = s.indexOf('\n', i + 1)) >= 0) n++; return n; };
  // Finer stamps inside a block, so a selection in one bullet or one table row maps to just its own lines:
  // each top-level <li> gets the lines of its item (the lexer's items[].raw are contiguous in the list's raw),
  // each <tr> its single source line. Nested lists inside an item stay covered by the item's range.
  function stampInner(el, tok, base) {
    if (tok.type === 'list' && el.tagName in { UL: 1, OL: 1 }) {
      const lis = [...el.children].filter((c) => c.tagName === 'LI');
      let cursor = 0, line = 0;
      tok.items.forEach((it, i) => {
        let at = tok.raw.indexOf(it.raw, cursor); if (at < 0) at = cursor;
        line += countNl(tok.raw.slice(cursor, at));
        const s = line; line += countNl(it.raw); cursor = at + it.raw.length;
        const e = line + (it.raw.endsWith('\n') ? 0 : 1);
        if (lis[i]) { lis[i].dataset.l0 = base + s; lis[i].dataset.l1 = base + Math.max(e, s + 1); }
      });
    } else if (tok.type === 'table' && el.tagName === 'TABLE') {
      const hr = el.querySelector('thead tr'); if (hr) { hr.dataset.l0 = base; hr.dataset.l1 = base + 1; }
      [...el.querySelectorAll('tbody tr')].forEach((tr, i) => { tr.dataset.l0 = base + 2 + i; tr.dataset.l1 = base + 3 + i; });
    }
  }
  function renderChunk(md, toc, used, opts) {
    const el = document.createElement('div');
    const off = (opts && opts.lineOff) || 0;
    const tokens = marked.lexer(md);
    let cursor = 0, line = 0;
    for (const tok of tokens) {
      let at = md.indexOf(tok.raw, cursor); if (at < 0) at = cursor;
      line += countNl(md.slice(cursor, at));
      const l0 = line, end = at + tok.raw.length;
      line += countNl(tok.raw); cursor = end;
      if (tok.type === 'space') continue;
      const l1 = line + (md[end - 1] === '\n' ? 0 : 1);
      const one = [tok]; one.links = tokens.links;
      const tmp = document.createElement('div');
      tmp.innerHTML = marked.parser(one);
      for (const c of [...tmp.childNodes]) {
        if (c.nodeType === 1) { c.dataset.l0 = off + l0; c.dataset.l1 = off + l1; stampInner(c, tok, off + l0); }
        el.append(c);
      }
    }
    decorateHeadings(el, toc, used);
    decorateTables(el);
    decorateMisc(el, opts);
    return el;
  }

  // Split at top-level `## ` headings (outside fenced code blocks).
  // Returns { head: string, sections: [{ title, src, start, end }] } with line offsets.
  function split(md) {
    const lines = md.replace(/\r\n/g, '\n').split('\n');
    const bounds = [];
    let fence = false;
    lines.forEach((l, i) => {
      if (/^\s*(```|~~~)/.test(l)) fence = !fence;
      if (!fence && /^## /.test(l)) bounds.push(i);
    });
    const head = lines.slice(0, bounds.length ? bounds[0] : lines.length).join('\n');
    const sections = bounds.map((b, k) => {
      const end = k + 1 < bounds.length ? bounds[k + 1] : lines.length;
      return { title: lines[b].replace(/^## /, '').trim(), src: lines.slice(b, end).join('\n'), start: b, end };
    });
    return { head, sections, lines };
  }

  // Full document render.
  // opts.base: URL of the document itself (relative image paths resolve against it); opts.home: the home folder.
  // Returns { headEl, sectionEls: [{el, title, index}], toc, stats }
  function renderDoc(md, opts) {
    const toc = [];
    const used = new Set();
    const { head, sections } = split(md);
    const headEl = renderChunk(head, toc, used, Object.assign({}, opts, { lineOff: 0 }));
    const sectionEls = sections.map((s, i) => {
      const el = renderChunk(s.src, toc, used, Object.assign({}, opts, { lineOff: s.start }));
      const h2 = el.querySelector('h2');
      const m = h2 && h2.textContent.match(/^\s*(\d+)[.)]\s+(.*)$/);
      if (h2 && m) h2.innerHTML = `<span class="n">${m[1].padStart(2, '0')}</span><span class="t">${h2.innerHTML.replace(/^\s*\d+[.)]\s+/, '')}</span>`;
      else if (h2) h2.innerHTML = `<span class="t">${h2.innerHTML}</span>`;
      return { el, title: s.title, index: i, id: h2 ? h2.id : `s${i}` };
    });
    const words = md.split(/\s+/).filter(Boolean).length;
    const stats = { words, minutes: Math.max(1, Math.round(words / 220)), sections: sections.length, tables: (md.match(/^\|.*\|\s*$/gm) || []).length ? [...headEl.querySelectorAll('table'), ...sectionEls.flatMap((s) => [...s.el.querySelectorAll('table')])].length : 0 };
    return { headEl, sectionEls, toc, stats };
  }

  global.MD = { renderDoc, renderChunk, split, slugify, esc };
})(window);
