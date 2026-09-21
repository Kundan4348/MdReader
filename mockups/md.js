// Minimal, dependency-free Markdown -> HTML renderer for the mockups.
// Handles: headings, paragraphs, tables (with numeric-column detection),
// bullet / numbered lists, blockquotes, fenced code, hr, bold/italic/code/links.
(function (global) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function inline(s) {
    s = esc(s);
    s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    return s;
  }

  const slug = (t) => t.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const isNumeric = (t) => /^[\s$€£~+\-−–]*[\d.,]+\s*(%|ms|s|M|K|B|×|x)?\s*$/i.test(t.replace(/\*\*/g, '')) || /^[—–-]$/.test(t.trim());

  function table(lines) {
    const rows = lines.map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
    const head = rows[0];
    const body = rows.slice(2);
    const cols = head.length;
    // A column is numeric if most body cells parse as numbers.
    const numeric = Array.from({ length: cols }, (_, i) => {
      const cells = body.map((r) => r[i] || '').filter((c) => c !== '');
      if (!cells.length) return false;
      return cells.filter(isNumeric).length / cells.length >= 0.6;
    });
    const th = head.map((c, i) => `<th class="${numeric[i] ? 'num' : ''}">${inline(c)}</th>`).join('');
    const tr = body
      .map((r) => {
        const strongRow = r.every((c) => c === '' || /^\*\*.*\*\*$/.test(c)) && r.some((c) => c !== '');
        return `<tr class="${strongRow ? 'total' : ''}">${r
          .map((c, i) => `<td class="${numeric[i] ? 'num' : ''}">${inline(c)}</td>`)
          .join('')}</tr>`;
      })
      .join('');
    return `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`;
  }

  function render(md) {
    const lines = md.replace(/\r\n/g, '\n').split('\n');
    const out = [];
    const toc = [];
    let i = 0;
    let para = [];
    const flush = () => {
      if (para.length) {
        out.push(`<p>${inline(para.join(' '))}</p>`);
        para = [];
      }
    };
    while (i < lines.length) {
      const l = lines[i];
      if (/^\s*$/.test(l)) { flush(); i++; continue; }
      let m;
      if ((m = l.match(/^(#{1,6})\s+(.*)$/))) {
        flush();
        const lvl = m[1].length; const txt = inline(m[2]); const id = slug(m[2]);
        toc.push({ lvl, txt, id });
        out.push(`<h${lvl} id="${id}">${txt}</h${lvl}>`);
        i++; continue;
      }
      if (/^```/.test(l)) {
        flush();
        const lang = l.slice(3).trim(); const buf = []; i++;
        while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
        i++;
        out.push(`<pre class="code" data-lang="${lang}"><code>${esc(buf.join('\n'))}</code></pre>`);
        continue;
      }
      if (/^\s*(---|\*\*\*|___)\s*$/.test(l)) { flush(); out.push('<hr>'); i++; continue; }
      if (/^\|/.test(l) && i + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[i + 1])) {
        flush();
        const buf = [];
        while (i < lines.length && /^\|/.test(lines[i])) buf.push(lines[i++]);
        out.push(table(buf));
        continue;
      }
      if (/^>\s?/.test(l)) {
        flush();
        const buf = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
        out.push(`<blockquote>${render(buf.join('\n')).html}</blockquote>`);
        continue;
      }
      if (/^\s*[-*+]\s+/.test(l) || /^\s*\d+[.)]\s+/.test(l)) {
        flush();
        const ordered = /^\s*\d+[.)]\s+/.test(l);
        const items = [];
        while (i < lines.length && (/^\s*[-*+]\s+/.test(lines[i]) || /^\s*\d+[.)]\s+/.test(lines[i]) || /^\s{2,}\S/.test(lines[i]))) {
          if (/^\s{2,}\S/.test(lines[i]) && items.length) items[items.length - 1] += ' ' + lines[i].trim();
          else items.push(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ''));
          i++;
        }
        const tag = ordered ? 'ol' : 'ul';
        out.push(`<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${tag}>`);
        continue;
      }
      para.push(l.trim());
      i++;
    }
    flush();
    return { html: out.join('\n'), toc };
  }

  global.MD = { render };
})(window);
