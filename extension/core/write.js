// MdReader "Write" mode, serializer half: turns one edited rendered block back into markdown.
// The shell makes every block of the rendered page editable in place (paragraphs, headings, lists, quotes, tables,
// code). Only a block you actually changed is serialized; its source lines (data-l0 / data-l1, stamped by md.js) are
// replaced with the result and every other line of the file stays byte-for-byte as it was. Where the original lines
// carry choices the DOM cannot see (the bullet character, a table's alignment row and padding, a code fence and its
// language, a numbered heading's "1." vs "1)"), the original is passed in and reused.
(function (global) {
  const SKIP = 'button, .tf-bar, tr.filters, .tf-btn';

  // ---- inline ----
  function escText(s) {
    s = s.replace(/\u00a0/g, ' ').replace(/\u200b/g, '');
    s = s.replace(/\\/g, '\\\\').replace(/([*`~])/g, '\\$1');
    // `_` only matters at a word edge (GFM ignores it inside snake_case)
    s = s.replace(/_/g, (m, i, all) => (/\w/.test(all[i - 1] || '') && /\w/.test(all[i + 1] || '') ? '_' : '\\_'));
    s = s.replace(/\[(?=[^\]]*\]\()/g, '\\[');
    s = s.replace(/<(?=[A-Za-z/!?])/g, '&lt;');
    return s;
  }
  // `**  bold **` is not bold in markdown: keep the spaces outside the marks
  function wrap(mark, inner) {
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
    return m[2] ? m[1] + mark + m[2] + mark + m[3] : inner;
  }
  function codeSpan(t) {
    t = t.replace(/\n/g, ' ');
    const runs = t.match(/`+/g) || [];
    const n = runs.reduce((a, r) => Math.max(a, r.length), 0) + 1;
    const f = '`'.repeat(n), pad = /^`|`$/.test(t) ? ' ' : '';
    return f + pad + t + pad + f;
  }
  function inl(n) { let s = ''; for (const c of n.childNodes) s += node(c); return s; }
  function node(c) {
    if (c.nodeType === 3) return escText(c.nodeValue);
    if (c.nodeType !== 1 || c.matches(SKIP)) return '';
    const t = c.tagName;
    if (t === 'BR') return '\\\n';
    if (t === 'STRONG' || t === 'B') return wrap('**', inl(c));
    if (t === 'EM' || t === 'I') return wrap('*', inl(c));
    if (t === 'DEL' || t === 'S' || t === 'STRIKE') return wrap('~~', inl(c));
    if (t === 'CODE') return codeSpan(c.textContent);
    if (t === 'IMG') return `![${c.alt || ''}](${c.getAttribute('data-src-written') || c.getAttribute('src') || ''})`;
    if (t === 'INPUT') return '';
    if (c.classList.contains('imgmissing')) return `![${c.dataset.alt || ''}](${c.dataset.src || ''})`;
    if (t === 'A') {
      if (c.classList.contains('path')) return c.querySelector('code') ? codeSpan(c.textContent) : c.textContent; // written as plain text, md.js linkified it
      const href = c.getAttribute('href') || '', text = inl(c);
      if (!href) return text;
      if (text === escText(href) && /^https?:\/\//.test(href)) return href; // bare URL (GFM autolink)
      return `[${text}](${/[\s()]/.test(href) ? '<' + href + '>' : href})`;
    }
    if (/^(SUP|SUB|KBD|MARK|U|SMALL|ABBR)$/.test(t)) return `<${t.toLowerCase()}>${inl(c)}</${t.toLowerCase()}>`;
    if (t === 'DIV' || t === 'P') return '\n\n' + inl(c); // Enter inside a block (browser-made line)
    return inl(c); // span / font the browser added while editing, the numbered-heading spans, ...
  }
  const tidy = (s) => s.replace(/(?:\\\n)+$/, '').replace(/^(?:\\\n)+/, '').replace(/[ \t]+\n/g, '\n').trim();
  // a paragraph that starts with "# ", "> ", "- ", "1. " would turn into something else
  const guardStart = (s) => s.replace(/^(#{1,6}\s|>|[-+]\s|\d+[.)]\s)/, (m) => '\\' + m);

  // ---- blocks ----
  function para(el) {
    const parts = inl(el).split(/\n{2,}/).map(tidy).filter(Boolean);
    return parts.map((p) => p.split('\n').map((l, i) => (i ? l : guardStart(l))).join('\n')).join('\n\n');
  }
  function heading(el, orig) {
    const lvl = +el.tagName[1];
    const n = el.querySelector(':scope > .n'), t = el.querySelector(':scope > .t');
    let text = tidy(inl(t && n ? t : el).replace(/\\\n|\n+/g, ' ')).replace(/\s+/g, ' ');
    let num = '';
    if (n) {
      const m = /^#{1,6}\s+(\d+[.)]\s+)/.exec(orig || '');
      num = m ? m[1] : parseInt(n.textContent, 10) + '. ';
    }
    if (!text && !num) return '';
    return '#'.repeat(lvl) + ' ' + num + text;
  }
  function list(el, orig, indent = '') {
    const ordered = el.tagName === 'OL';
    const start = parseInt(el.getAttribute('start'), 10) || 1;
    const bm = /^\s*([-*+])\s/m.exec(orig || ''); const bullet = bm ? bm[1] : '-';
    const om = /^\s*\d+([.)])\s/m.exec(orig || ''); const odelim = om ? om[1] : '.';
    const loose = !![...el.children].find((li) => li.querySelector(':scope > p'));
    const items = [];
    [...el.children].filter((c) => c.tagName === 'LI').forEach((li, i) => {
      const mark = ordered ? `${start + i}${odelim} ` : `${bullet} `;
      const cb = li.querySelector(':scope > input[type=checkbox], :scope > p > input[type=checkbox]');
      const pad = indent + ' '.repeat(mark.length);
      const lines = []; let cur = '';
      const flush = () => { const t = tidy(cur); if (t) lines.push(...t.split('\n')); cur = ''; };
      for (const c of li.childNodes) {
        if (c.nodeType === 1 && (c.tagName === 'UL' || c.tagName === 'OL')) { flush(); const sub = list(c, orig, pad); if (sub) lines.push({ sub }); }
        else if (c.nodeType === 1 && (c.tagName === 'P' || c.tagName === 'DIV')) { flush(); cur = inl(c); flush(); if (loose) lines.push(''); }
        else cur += node(c);
      }
      flush();
      while (lines.length && lines[lines.length - 1] === '') lines.pop();
      const task = cb ? (cb.checked ? '[x] ' : '[ ] ') : '';
      const out = []; let first = true;
      for (const l of lines) {
        if (typeof l === 'object') { out.push(l.sub); continue; }
        if (first) { out.push(indent + mark + task + l); first = false; } else out.push(l ? pad + l : '');
      }
      if (first) { if (!task && !lines.some((l) => typeof l === 'object')) return; out.unshift(indent + mark + task.trimEnd()); }
      items.push(out.join('\n'));
    });
    return items.join(loose ? '\n\n' : '\n');
  }
  function quote(el) {
    const parts = [];
    let cur = '';
    const flush = () => { const s = tidy(cur); if (s) parts.push(guardStart(s)); cur = ''; };
    for (const c of el.childNodes) {
      if (c.nodeType === 1 && c.tagName === 'DIV') { flush(); cur = inl(c); flush(); continue; }
      const b = c.nodeType === 1 ? blockOf(c) : null;
      if (b !== null) { flush(); if (b) parts.push(b); } else cur += node(c);
    }
    flush();
    if (!parts.length) return '';
    return parts.join('\n\n').split('\n').map((l) => (l ? '> ' + l : '>')).join('\n');
  }
  const splitRow = (line) => line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim());
  function table(t, orig) {
    const ol = (orig || '').split('\n');
    const cell = (c) => tidy(inl(c).replace(/\\\n|\n+/g, ' ')).replace(/\|/g, '\\|') || ' ';
    const head = t.querySelector('thead tr:not(.filters)');
    const body = [...t.querySelectorAll('tbody > tr')];
    const hcells = head ? [...head.children].map(cell) : [];
    const row = (cells, i) => { const o = ol[i]; return o !== undefined && o.includes('|') && splitRow(o).join('\u0000') === cells.map((c) => c.trim()).join('\u0000') ? o : '| ' + cells.join(' | ') + ' |'; };
    let sep = ol[1];
    if (!sep || !/^[\s|:-]+$/.test(sep) || splitRow(sep).length !== hcells.length) {
      sep = '| ' + (head ? [...head.children] : []).map((th) => (th.classList.contains('align-center') ? ':---:' : th.classList.contains('align-right') ? '---:' : th.classList.contains('align-left') ? ':---' : '---')).join(' | ') + ' |';
    }
    const out = [row(hcells, 0), sep];
    body.forEach((tr, i) => { const cells = [...tr.children].map(cell); while (cells.length < hcells.length) cells.push(' '); if (cells.some((c) => c.trim())) out.push(row(cells, i + 2)); });
    return out.join('\n');
  }
  function code(wrapEl, orig) {
    const c = wrapEl.querySelector('pre > code');
    const text = c.textContent.replace(/\n$/, '');
    const ol = (orig || '').split('\n');
    const m = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(ol[0] || '');
    let fence, open;
    if (m) {
      fence = m[2]; let info = m[3];
      if (info.trim() && (/\s/.test(info.trim()) || /[()=:;'"]/.test(info))) info = ''; // glued first line: it is already in the text
      open = m[1] + fence + info;
    } else { fence = '```'; open = fence + (wrapEl.dataset.lang || ''); }
    const longest = (text.match(new RegExp('^\\s*' + (fence[0] === '`' ? '`' : '~') + '{3,}', 'gm')) || []).reduce((a, r) => Math.max(a, r.trim().length), 0);
    if (longest >= fence.length) { const f2 = fence[0].repeat(longest + 1); open = open.replace(fence, f2); fence = f2; }
    return open + '\n' + text + '\n' + (m ? m[1] : '') + fence;
  }

  // What can be edited in place. Anything else (diagrams, rules, raw HTML, <details>) keeps its source untouched.
  function kindOf(el) {
    if (!el || el.nodeType !== 1) return null;
    const t = el.tagName;
    if (t === 'P') return 'p';
    if (/^H[1-6]$/.test(t)) return 'h';
    if (t === 'UL' || t === 'OL') return 'list';
    if (t === 'BLOCKQUOTE') return 'quote';
    if (el.classList.contains('table-wrap') && el.querySelector('table')) return 'table';
    if (el.classList.contains('codeblock') && el.querySelector('pre > code')) return 'code';
    return null;
  }
  function blockOf(el, orig) {
    switch (kindOf(el)) {
      case 'p': return para(el);
      case 'h': return heading(el, orig);
      case 'list': return list(el, orig);
      case 'quote': return quote(el);
      case 'table': return table(el.querySelector('table'), orig);
      case 'code': return code(el, orig);
      default: return null;
    }
  }
  // Text typed at the start of a paragraph that means "make this a ...": "## ", "- ", "1. ", "> ", "[ ] "
  function shortcut(text) {
    let m;
    if ((m = /^(#{1,6}) /.exec(text))) return { tag: 'H' + m[1].length, cut: m[0].length };
    if ((m = /^[-*+] \[( |x)\] /i.exec(text))) return { tag: 'TASK', cut: m[0].length, checked: m[1] !== ' ' };
    if ((m = /^[-*+] /.exec(text))) return { tag: 'UL', cut: m[0].length };
    if ((m = /^1[.)] /.exec(text))) return { tag: 'OL', cut: m[0].length };
    if ((m = /^> /.exec(text))) return { tag: 'BLOCKQUOTE', cut: m[0].length };
    return null;
  }

  global.WR = { block: blockOf, kindOf, inline: inl, shortcut, escText };
})(window);
