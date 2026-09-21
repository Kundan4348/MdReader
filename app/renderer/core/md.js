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

  function decorateMisc(root) {
    root.querySelectorAll('pre > code').forEach((code) => {
      const lang = [...code.classList].find((c) => c.startsWith('language-'));
      if (lang) code.parentElement.dataset.lang = lang.slice(9);
      code.parentElement.classList.add('code');
    });
    root.querySelectorAll('input[type=checkbox]').forEach((cb) => { cb.disabled = true; cb.closest('li')?.classList.add('task'); });
    root.querySelectorAll('a[href^="http"]').forEach((a) => { a.target = '_blank'; a.rel = 'noopener'; });
  }

  // Render one chunk of markdown to an element; decorate; return toc entries.
  function renderChunk(md, toc, used) {
    const el = document.createElement('div');
    el.innerHTML = marked.parse(md);
    decorateHeadings(el, toc, used);
    decorateTables(el);
    decorateMisc(el);
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
  // Returns { headEl, sectionEls: [{el, title, index}], toc, stats }
  function renderDoc(md) {
    const toc = [];
    const used = new Set();
    const { head, sections } = split(md);
    const headEl = renderChunk(head, toc, used);
    const sectionEls = sections.map((s, i) => {
      const el = renderChunk(s.src, toc, used);
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
