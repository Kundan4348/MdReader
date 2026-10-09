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
    { id: 'lumen', name: 'Lumen', hint: 'airy page, a colour per section' },
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
    const DEFAULT_MODE = 'write';
    const srcShown = () => S.mode === 'edit' || S.mode === 'split'; // the source pane is on screen (not Read / Write)

    // ---------- DOM ----------
    root.innerHTML = '';
    root.className = 'app';
    const crumbs = h('div', { class: 'crumbs' });
    const seg = h('div', { class: 'seg' },
      ...['read', 'write', 'edit', 'split'].map((m) => h('button', { 'data-mode': m, onclick: () => setMode(m), title: { read: 'Read (⌘1)', write: 'Write: edit the page as you read it (⌘4)', edit: 'Edit the source (⌘2)', split: 'Source and page side by side (⌘3)' }[m] }, m[0].toUpperCase() + m.slice(1))));
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
    // JSON / SQL only: pretty-print JSON (⌥-click minifies) or re-indent SQL. Hidden for markdown (CSS on data-kind).
    const fmtBtn = h('button', { class: 'fmt', title: 'Format JSON (⌘⇧F) · ⌥-click to minify', onclick: (e) => formatDoc(e.altKey) }, 'Format');
    const top = h('header', { class: 'top' }, filesBtn, crumbs, h('span', { class: 'spacer' }), seg, saveBtn, fmtBtn, view, themeSel, openBtn, outlineBtn);

    const tree = h('div', { class: 'tree' });
    // Files pane header: ↑ re-roots the tree one folder up (so there is always a way back), ⌂ returns to the home
    // folder, Recent swaps the tree for the recently opened files / last session (closes with the same button).
    const upBtn = h('button', { class: 'fup', title: 'Up one folder', onclick: () => treeUp() }, '↑');
    const homeBtn = h('button', { class: 'fhome', title: 'Home folder', onclick: () => rootTreeAt(adapter.home) }, '⌂');
    const recentBtn = h('button', { class: 'frecent', title: 'Recently opened files', 'aria-pressed': 'false', onclick: () => toggleRecent() }, 'Recent');
    const rootLbl = h('div', { class: 'froot', title: 'Folder shown in the tree' });
    const recentEl = h('div', { class: 'recent', hidden: '' });
    const files = h('aside', { class: 'files' }, h('h6', {}, h('span', {}, 'Files'), h('span', { class: 'fctl' }, upBtn, homeBtn, recentBtn)), rootLbl, tree, recentEl);
    const closedStack = []; // file paths of closed tabs, newest last (⌘⇧T reopens)
    if (!adapter.recent) recentBtn.hidden = true; // the extension host keeps no recent list

    const head = h('div', { class: 'head' });
    const secs = h('div', { class: 'secs' });
    const doc = h('article', { class: 'doc' }, head, secs);
    const ta = h('textarea', { class: 'src', spellcheck: 'false', oninput: onInput, onkeydown: onEditorKey, onscroll: onSrcScroll });
    // .srchl mirrors the textarea's text line by line (transparent, laid over it) -- see "split sync" below.
    const hl = h('div', { class: 'srchl', 'aria-hidden': 'true' });
    const editor = h('section', { class: 'editor' }, h('div', { class: 'gutter' }, h('span', {}, 'markdown'), h('span', { class: 'wc' })), h('div', { class: 'srcwrap' }, ta, hl));
    const tabsEl = h('nav', { class: 'tabs', role: 'tablist' });
    const content = h('main', { class: 'content', onscroll: onContentScroll }, doc, editor);
    const centre = h('div', { class: 'centre' }, tabsEl, content);

    const toc = h('nav', { class: 'toc' });
    const meta = h('div', { class: 'meta' });
    const outline = h('aside', { class: 'outline' }, h('h6', {}, 'Outline'), toc, meta);
    const toast = h('div', { class: 'toast' });
    const hint = h('div', { class: 'hint', html: 'Find <kbd>⌘F</kbd> · Edit <kbd>⌘E</kbd> · Save <kbd>⌘S</kbd> · Text size <kbd>⌘+</kbd><kbd>⌘−</kbd> · Width <kbd>⌘⇧W</kbd> · Themes <kbd>⌘⇧Y</kbd> · Reopen closed tab <kbd>⌘⇧T</kbd>' });
    const wbar = h('div', { class: 'wbar', role: 'toolbar', 'aria-label': 'Formatting' });
    root.append(top, files, centre, outline, toast, hint, wbar);
    setTimeout(() => hint.classList.add('gone'), 6000);

    // ---------- Write mode ----------
    // Read's page, editable in place (core/write.js turns a block back into markdown). Every top-level block keeps the
    // source lines it came from (md.js stamps). Typing marks that block; ~0.4 s later, or when you leave it, only that
    // block is serialized and spliced into the text, and the blocks after it have their line stamps shifted. A block
    // you did not touch is never rewritten, so the file keeps its own layout everywhere else.
    const W = (() => {
      const dirty = new Set();
      let timer = 0, built = false, busy = 0; // busy: our own DOM surgery is moving focus around, focusout must not tidy
      const ok = () => S.mode === 'write' && docKind() === 'md' && !!global.WR;
      const hostOf = (b) => { const k = WR.kindOf(b); return k === 'table' ? b.querySelector('table') : k === 'code' ? b.querySelector('pre > code') : b; };
      const blockOf = (n) => { const el = n && (n.nodeType === 1 ? n : n.parentElement); return el && doc.contains(el) ? el.closest('.wblock') : null; };
      const isTask = (b) => WR.kindOf(b) === 'list' && !!b.querySelector(':scope > li > input[type=checkbox], :scope > li > p > input[type=checkbox]');
      function makeEditable(b) {
        const k = WR.kindOf(b); if (!k) return false;
        b.classList.add('wblock'); b.classList.remove('w-locked');
        if (k === 'code') hostOf(b).spellcheck = false;
        b.querySelectorAll('button, .tf-bar, tr.filters, .imgmissing, h1 > .n, h2 > .n, .codebar').forEach((x) => { x.contentEditable = 'false'; });
        b.querySelectorAll('input[type=checkbox]').forEach((cb) => { cb.disabled = false; cb.contentEditable = 'false'; });
        return true;
      }
      // The whole page is ONE editing host, so a selection can run across paragraphs, sections and table rows (separate
      // hosts would clamp it to one block). Everything that is not a block -- section tools, chips, diagrams -- is an
      // island marked contenteditable=false, and every edit the browser would make across blocks is done here instead.
      function enable() {
        root.classList.toggle('writing', ok());
        if (!ok()) { doc.removeAttribute('contenteditable'); hideMenu(); return; }
        doc.contentEditable = 'true'; doc.spellcheck = true;
        doc.querySelectorAll('.sec > .tools, .head > nav.chips, .head > :not([data-l0]), .sec > .body > :not([data-l0])').forEach((x) => { x.contentEditable = 'false'; });
        for (const b of doc.querySelectorAll('.head > [data-l0], .sec > .body > [data-l0]')) {
          if (!makeEditable(b)) { b.classList.add('w-locked'); b.contentEditable = 'false'; if (!b.title) b.title = 'Edited as source: use Edit section (top right of the section) or Edit mode'; }
        }
        if (!doc.querySelector('.wblock')) { // nothing to type into (empty document): one empty paragraph at the end
          const p = h('p', {}, h('br')); p.dataset.l0 = p.dataset.l1 = String(S.text ? S.text.split('\n').length : 0);
          (secs.lastElementChild ? secs.lastElementChild.querySelector('.body') : head).append(p); makeEditable(p);
        }
        buildBar();
      }
      function reset() { dirty.clear(); clearTimeout(timer); cur = null; hideMenu(); clearWhole(); if (typeof endDrag === 'function') { endDrag(false); endCdrag(false); } }
      function mark(b) { dirty.add(b); clearTimeout(timer); timer = setTimeout(commitAll, 400); }
      function commitAll() { clearTimeout(timer); for (const b of [...dirty]) commit(b); }
      function commit(b) {
        dirty.delete(b);
        if (!b.isConnected || b.dataset.l0 === undefined || !global.WR) return;
        const l0 = +b.dataset.l0, l1 = +b.dataset.l1;
        const lines = S.text.split('\n');
        const old = lines.slice(l0, l1);
        let trail = 0; while (trail < old.length && !old[old.length - 1 - trail].trim()) trail++;
        const md = WR.block(b, old.slice(0, old.length - trail).join('\n'));
        if (md === null) return;
        let rep, at = l0, len;
        if (!md.trim()) { rep = []; len = 0; } // emptied: its lines go (blank lines after it included)
        else if (l0 === l1) { // a new block: keep exactly one blank line on each side of it
          const body = md.split('\n'), pre = l0 > 0 && (lines[l0 - 1] || '').trim() ? [''] : [], post = l0 < lines.length && (lines[l0] || '').trim() ? [''] : [];
          rep = [...pre, ...body, ...post]; at = l0 + pre.length; len = body.length + post.length;
        } else { rep = [...md.split('\n'), ...old.slice(old.length - trail)]; len = rep.length; }
        if (rep.length === old.length && rep.every((x, i) => x === old[i])) return;
        lines.splice(l0, l1 - l0, ...rep);
        const delta = rep.length - (l1 - l0);
        if (delta) for (const x of doc.querySelectorAll('[data-l0]')) {
          if (x !== b && !b.contains(x) && (b.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING)) { x.dataset.l0 = +x.dataset.l0 + delta; x.dataset.l1 = +x.dataset.l1 + delta; }
        }
        b.dataset.l0 = at; b.dataset.l1 = at + len;
        b.querySelectorAll('[data-l0]').forEach((x) => { delete x.dataset.l0; delete x.dataset.l1; });
        setText(lines.join('\n'));
        const t = curTab(); if (t) t.text = S.text;
        notifyTabs();
      }
      function caretTo(b, atEnd) {
        const host = textHost(b); doc.focus({ preventScroll: true });
        const r = document.createRange(); r.selectNodeContents(host); r.collapse(!atEnd);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
        const br = host.getBoundingClientRect(), cr = content.getBoundingClientRect();
        if (br.bottom > cr.bottom - 60 || br.top < cr.top) content.scrollTop += br.top - cr.top - content.clientHeight / 3;
      }
      // a new paragraph right after block b (Enter at the end of a heading / paragraph, Enter on an empty last bullet)
      function newParaAfter(b, frag) {
        const p = h('p'); if (frag) p.append(frag);
        p.querySelectorAll('.n').forEach((x) => x.remove());
        if (!p.textContent.trim() && !p.querySelector('img')) p.replaceChildren(h('br'));
        b.after(p); makeEditable(p);
        dirty.add(b); commit(b); // shifts nothing that is not stamped yet
        p.dataset.l0 = p.dataset.l1 = b.dataset.l1;
        if (p.textContent.trim()) { dirty.add(p); commit(p); }
        return p;
      }
      function splitAtCaret(b) { busy++; try { splitNow(b); } finally { busy--; } }
      function splitNow(b) {
        const host = hostOf(b), sel = getSelection(); if (!sel.rangeCount) return;
        const r = sel.getRangeAt(0); r.deleteContents();
        const tail = document.createRange(); tail.setStart(r.startContainer, r.startOffset); tail.setEnd(host, host.childNodes.length);
        const frag = tail.extractContents();
        if (!host.textContent.trim() && WR.kindOf(b) === 'p' && !host.querySelector('img')) host.replaceChildren(h('br'));
        caretTo(newParaAfter(b, frag), false);
      }
      function atStart(host) {
        const s = getSelection(); if (!s.rangeCount || !s.isCollapsed) return false;
        const r = document.createRange(); r.setStart(host, 0); r.setEnd(s.anchorNode, s.anchorOffset);
        return !r.toString().length;
      }
      function removeBlock(b, focusPrev) {
        const all = [...doc.querySelectorAll('.wblock')], prev = all[all.indexOf(b) - 1];
        busy++;
        try { hostOf(b).replaceChildren(); dirty.add(b); commit(b); if (all.length > 1) b.remove(); else hostOf(b).replaceChildren(h('br')); } finally { busy--; }
        if (focusPrev && prev) caretTo(prev, true);
      }
      // the inline content of a block, one fragment per item (a list gives one per bullet, nested ones flattened)
      function itemsOf(b) {
        const k = WR.kindOf(b), frag = (nodes) => { const f = document.createDocumentFragment(); f.append(...nodes); return f; };
        if (k === 'list') {
          const out = [];
          const walk = (list) => [...list.children].filter((c) => c.tagName === 'LI').forEach((li) => {
            const own = [], subs = [];
            for (const c of [...li.childNodes]) {
              if (c.nodeType === 1 && (c.tagName === 'UL' || c.tagName === 'OL')) subs.push(c);
              else if (c.nodeType === 1 && c.tagName === 'INPUT') continue;
              else if (c.nodeType === 1 && c.tagName === 'P') own.push(...c.childNodes);
              else own.push(c);
            }
            out.push(frag(own)); subs.forEach(walk);
          });
          walk(b); return out;
        }
        if (k === 'quote') { const ps = [...b.children].filter((c) => /^(P|H\d|DIV)$/.test(c.tagName)); return ps.length ? ps.map((c) => frag([...c.childNodes])) : [frag([...b.childNodes])]; }
        const own = [];
        for (const c of [...b.childNodes]) { if (c.nodeType === 1 && c.classList.contains('n')) continue; if (c.nodeType === 1 && c.classList.contains('t')) own.push(...c.childNodes); else own.push(c); }
        return [frag(own)];
      }
      // turn block b into another kind: 'P', 'H1'..'H6', 'UL', 'OL', 'TASK', 'BLOCKQUOTE'
      function convert(b, to, checked) {
        const k = WR.kindOf(b); if (!k || k === 'table' || k === 'code') return null;
        busy++; try { return convertNow(b, to, checked); } finally { busy--; }
      }
      function convertNow(b, to, checked) {
        const items = itemsOf(b);
        let els;
        if (to === 'UL' || to === 'OL' || to === 'TASK') {
          const list = h(to === 'OL' ? 'ol' : 'ul');
          items.forEach((f) => { const li = h('li'); if (to === 'TASK') { const cb = h('input', { type: 'checkbox' }); cb.checked = !!checked; li.classList.add('task'); li.append(cb, ' '); } li.append(f); list.append(li); });
          els = [list];
        } else if (to === 'BLOCKQUOTE') { const q = h('blockquote'); items.forEach((f) => { const p = h('p'); p.append(f); q.append(p); }); els = [q]; }
        else els = items.map((f) => { const x = h(to.toLowerCase()); x.append(f); return x; });
        for (const x of els) { const leaf = x.querySelector('li:last-child, p:last-child') || x; if (!leaf.textContent.trim() && !leaf.querySelector('img')) leaf.append(h('br')); }
        els[0].dataset.l0 = b.dataset.l0; els[0].dataset.l1 = b.dataset.l1;
        dirty.delete(b); b.replaceWith(...els);
        els.forEach(makeEditable);
        dirty.add(els[0]); commit(els[0]);
        for (let i = 1; i < els.length; i++) { els[i].dataset.l0 = els[i].dataset.l1 = els[i - 1].dataset.l1; dirty.add(els[i]); commit(els[i]); }
        return els[0];
      }
      function inlineCode(b) {
        const s = getSelection(); if (!s.rangeCount) return;
        const at = s.anchorNode && (s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement);
        const c = at && at.closest('code');
        if (c && hostOf(b).contains(c)) { c.replaceWith(document.createTextNode(c.textContent)); mark(b); return; }
        if (s.isCollapsed) return flash('Select the words to mark as code');
        const r = s.getRangeAt(0), t = r.toString(); r.deleteContents();
        const el = h('code', {}, t); r.insertNode(el);
        s.removeAllRanges(); const r2 = document.createRange(); r2.selectNodeContents(el); s.addRange(r2);
        mark(b);
      }
      const linkIn = h('input', { class: 'wlink', type: 'text', spellcheck: 'false', placeholder: 'Paste a link, Enter to apply (empty removes it)', hidden: '' });
      function linkAsk() {
        const s = getSelection(); const b = s.rangeCount && blockOf(s.anchorNode); if (!b) return flash('Select the words to link first');
        const at = s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement, a = at.closest('a');
        const r = s.getRangeAt(0).cloneRange();
        if (r.collapsed && !a) return flash('Select the words to link first');
        const back = () => { linkIn.hidden = true; doc.focus({ preventScroll: true }); const s2 = getSelection(); s2.removeAllRanges(); s2.addRange(r); };
        linkIn.hidden = false; linkIn.value = a ? a.getAttribute('href') || '' : ''; linkIn.focus(); linkIn.select();
        linkIn.onkeydown = (e) => {
          if (e.key === 'Escape') { e.preventDefault(); back(); }
          else if (e.key === 'Enter') {
            e.preventDefault(); const url = linkIn.value.trim(); back();
            if (a) { if (url) a.setAttribute('href', url); else a.replaceWith(...a.childNodes); mark(b); }
            else if (url) document.execCommand('createLink', false, url);
          }
        };
        linkIn.onblur = () => { linkIn.hidden = true; };
      }
      const ACTS = [['P', '¶', 'Plain paragraph'], ['H2', 'H2', 'Heading'], ['H3', 'H3', 'Sub-heading'], null,
        ['bold', '<b>B</b>', 'Bold (⌘B)'], ['italic', '<i>I</i>', 'Italic (⌘I)'], ['strike', '<s>S</s>', 'Strikethrough'], ['code', '&lt;/&gt;', 'Inline code'], ['link', 'Link', 'Link (⌘K) · ⌥-click a link to edit its text'], null,
        ['UL', '• List', 'Bulleted list (or type "- ")'], ['OL', '1. List', 'Numbered list (or type "1. ")'], ['TASK', '☐ Tasks', 'Checklist (or type "[ ] ")'], ['BLOCKQUOTE', '❝ Quote', 'Quote (or type "> ")']];
      // ---- the table group of the toolbar, and its full menu (also on right-click in a cell) ----
      const TBL = [['menu', 'Table ▾', 'Rows, columns, colours and more (or right-click a cell; click a row or column grip to select it whole)']];
      function buildBar() {
        if (built) return; built = true;
        const btn = (a, cls) => h('button', { type: 'button', class: cls || '', 'data-act': a[0], title: a[2], html: a[1],
          onmousedown: (e) => e.preventDefault(), onclick: (e) => act(a[0], e) });
        wbar.append(h('span', { class: 'wtag' }, 'Writing'), ...ACTS.map((a) => (a ? btn(a) : h('span', { class: 'wsep' }))),
          h('span', { class: 'wsep' }), btn(['table', '⊞ Table', 'Insert a table below this block']),
          h('span', { class: 'wtbl' }, h('span', { class: 'wsep' }), ...TBL.map((a) => btn(a, 'tb'))), linkIn,
          h('span', { class: 'whelp', title: 'Changes go into the file text as you type; ⌘S saves; ⌘Z undoes a table or multi-block change. Diagrams and raw HTML are edited with Edit section.' }, '⌘S saves'));
      }
      function act(name, e) {
        const b = selBlock();
        if (name === 'table') return insertTable(b);
        if (TBL.some((a) => a[0] === name)) {
          if (!b || WR.kindOf(b) !== 'table') return flash('Click into a table first');
          const sel = tableSel(b);
          if (name === 'menu') { const r = e.currentTarget.getBoundingClientRect(); return showMenu(r.left, r.top, b, sel, true); }
          return tableOp(b, name === 'hdr' ? (sel.r === 0 ? 'headerToRow' : 'makeHeader') : name, sel);
        }
        if (!b) return flash('Click into the text first');
        const k = WR.kindOf(b);
        if (name === 'bold' || name === 'italic' || name === 'strike') { if (k !== 'code') document.execCommand(name === 'strike' ? 'strikeThrough' : name); return; }
        if (name === 'code') return k === 'code' ? null : inlineCode(b);
        if (name === 'link') return k === 'code' ? null : linkAsk();
        if (k === 'table' || k === 'code') return flash('Tables and code blocks keep their shape -- edit inside them');
        const cur = isTask(b) ? 'TASK' : b.tagName;
        const to = name === cur ? 'P' : name;
        if (to === cur) return;
        const x = convert(b, to); if (x) caretTo(x, true);
        barState();
      }
      function barState() {
        if (!ok()) return;
        const b = selBlock();
        const cur = b ? (isTask(b) ? 'TASK' : b.tagName) : '';
        root.classList.toggle('w-intable', !!b && WR.kindOf(b) === 'table');
        wbar.querySelectorAll('button[data-act]').forEach((x) => {
          const a = x.dataset.act;
          x.classList.toggle('on', !!b && (a === cur || (['bold', 'italic', 'strike'].includes(a) && document.queryCommandState(a === 'strike' ? 'strikeThrough' : a))));
          x.disabled = !b && a !== 'table';
          if (a === 'hdr') { const c = b && WR.kindOf(b) === 'table' && cellOf(getSelection().anchorNode); x.classList.toggle('on', !!c && c.tagName === 'TH'); }
        });
      }

      // ---- helpers over the one editing host ----
      const TOP = '.head > [data-l0], .sec > .body > [data-l0]';
      const MK = '\u2063'; // invisible: marks where the caret goes back after a re-render, removed straight after
      const topBlocks = () => [...doc.querySelectorAll(TOP)];
      const blockAt = (l0) => doc.querySelector(`.head > [data-l0="${l0}"], .sec > .body > [data-l0="${l0}"]`);
      const selBlock = () => { const s = getSelection(); return s.rangeCount ? blockOf(s.anchorNode) : null; };
      const textHost = (b) => (WR.kindOf(b) === 'h' && b.querySelector(':scope > .t')) || hostOf(b);
      const txt = (sc, so, ec, eo) => { const x = document.createRange(); x.setStart(sc, so); x.setEnd(ec, eo); return x.toString(); };
      const TEXTISH = ['p', 'h', 'list', 'quote'];
      function textNodes(el) {
        const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement.closest('button, .n, .tf-bar') ? 2 : 1) });
        const out = []; while (w.nextNode()) out.push(w.currentNode); return out;
      }
      function setCaret(node, off, endNode, endOff) {
        doc.focus({ preventScroll: true });
        const r = document.createRange(); r.setStart(node, off); if (endNode) r.setEnd(endNode, endOff); else r.collapse(true);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
        const el = node.nodeType === 1 ? node : node.parentElement, br = el.getBoundingClientRect(), cr = content.getBoundingClientRect();
        if (br.bottom > cr.bottom - 80 || br.top < cr.top) content.scrollTop += br.top - cr.top - content.clientHeight / 3;
      }
      function caretInCell(cell, selectAll) {
        const ns = textNodes(cell);
        if (!ns.length) return setCaret(cell, 0);
        const last = ns[ns.length - 1];
        if (selectAll) setCaret(ns[0], 0, last, last.length); else setCaret(last, last.length);
      }
      const atEnd = (host) => { const s = getSelection(); if (!s.rangeCount || !s.isCollapsed) return false; return !txt(s.anchorNode, s.anchorOffset, host, host.childNodes.length).length; };
      const cellOf = (n) => { const el = n && (n.nodeType === 1 ? n : n.parentElement); return el ? el.closest('td, th') : null; };
      const tableRows = (b) => [...b.querySelectorAll('table > thead > tr:not(.filters), table > tbody > tr')];

      // ---- structural undo: table actions and multi-block edits re-render the page, which the browser cannot undo ----
      const hist = [], redo = [];
      function applyText(next, place, pinL0) {
        const before = S.text, clean = next.split(MK).join('');
        if (clean === before && next === clean) return false;
        hist.push({ before, after: clean }); if (hist.length > 60) hist.shift(); redo.length = 0;
        const t = curTab();
        busy++;
        try {
          setText(next); if (t) t.text = next;
          const pin = pinL0 !== undefined && pinL0 !== null ? pinL0 : place && place.l0;
          keepInPlace(() => (pin === undefined || pin === null ? null : blockAt(pin)), paint);
          placeCaret(place);
          if (next !== clean) { setText(clean); if (t) t.text = clean; }
        } finally { busy--; }
        notifyTabs(); track();
        return true;
      }
      function placeCaret(place) {
        for (const n of textNodes(doc)) { const i = n.nodeValue.indexOf(MK); if (i >= 0) { n.deleteData(i, 1); return setCaret(n, i); } }
        if (!place) return;
        const b = blockAt(place.l0); if (!b) return;
        if (place.cell && WR.kindOf(b) === 'table') {
          const rows = tableRows(b), tr = rows[Math.max(0, Math.min(place.cell[0], rows.length - 1))];
          const td = tr && tr.children[Math.max(0, Math.min(place.cell[1], tr.children.length - 1))];
          if (td) return caretInCell(td, place.select);
        }
        if (b.classList.contains('wblock')) caretTo(b, !!place.end);
      }
      function undo(again) {
        commitAll();
        const from = again ? redo : hist, top = from[from.length - 1];
        if (!top) return false;
        if (S.text !== (again ? top.before : top.after)) { from.length = 0; return false; } // typed since: the browser's own undo takes over
        from.pop(); (again ? hist : redo).push(top);
        const t = curTab(), y = content.scrollTop, v = again ? top.after : top.before;
        busy++; try { setText(v); if (t) t.text = v; paint(); content.scrollTop = y; } finally { busy--; }
        notifyTabs(); flash(again ? 'Redone' : 'Undone');
        return true;
      }

      // ---- tables: actions work on the table's markdown, then the page is re-rendered with the caret in the right cell ----
      // which rows / columns / cells the selection touches (a caret touches its own cell)
      function tableSel(b, clicked) {
        if (wsel && wsel.b === b && (!clicked || clicked.classList.contains('wsel'))) return wholeSel(wsel);
        const rows = tableRows(b), s = getSelection(), r = s.rangeCount ? s.getRangeAt(0) : null;
        const pos = (cell) => { const tr = cell.parentElement; return [rows.indexOf(tr), [...tr.children].indexOf(cell)]; };
        let cells = r ? rows.flatMap((tr) => [...tr.children].filter((c) => r.intersectsNode(c))) : [];
        if (clicked && !cells.includes(clicked)) cells = [clicked];
        if (!cells.length) { const c = cellOf(s.anchorNode) || (rows[0] && rows[0].children[0]); if (c) cells = [c]; }
        const at = cells.map(pos).filter((p) => p[0] >= 0);
        const anchor = (clicked && pos(clicked)) || (cellOf(s.anchorNode) && pos(cellOf(s.anchorNode))) || at[0] || [0, 0];
        return { rows: [...new Set(at.map((p) => p[0]))].sort((a, b2) => a - b2), cols: [...new Set(at.map((p) => p[1]))].sort((a, b2) => a - b2), cells: at, r: anchor[0], c: anchor[1] };
      }
      function tableModel(b) {
        commitAll();
        const lines = S.text.split('\n'), l0 = +b.dataset.l0, l1 = +b.dataset.l1, own = lines.slice(l0, l1);
        let trail = 0; while (trail < own.length && !own[own.length - 1 - trail].trim()) trail++;
        const tl = own.slice(0, own.length - trail);
        const head = WR.splitRow(tl[0] || '|  |'), n = head.length;
        const fit = (cells) => { const c = cells.slice(0, n); while (c.length < n) c.push(''); return c; };
        const rows = [{ cells: head, line: tl[0] }, ...tl.slice(2).map((l) => ({ cells: fit(WR.splitRow(l)), line: l }))];
        const aligns = fit(WR.splitRow(tl[1] || '').map((c) => (/^:-+:$/.test(c) ? 'center' : /^-+:$/.test(c) ? 'right' : /^:-+$/.test(c) ? 'left' : '')));
        return { lines, l0, l1, trail, rows, aligns, sep: tl[1], alignsWere: aligns.join(','), n };
      }
      function tableText(m) {
        const line = (row) => row.line != null ? row.line : '| ' + row.cells.map((c) => c.trim()).join(' | ') + ' |';
        const n = m.rows[0].cells.length;
        const sep = m.sep && m.aligns.join(',') === m.alignsWere && WR.splitRow(m.sep).length === n ? m.sep
          : '| ' + m.aligns.map((a) => (a === 'center' ? ':---:' : a === 'right' ? '---:' : a === 'left' ? ':---' : '---')).join(' | ') + ' |';
        return [line(m.rows[0]), sep, ...m.rows.slice(1).map(line)];
      }
      const cmpCells = (a, b2) => {
        const x = a.trim(), y = b2.trim();
        if (!x || !y) return x ? -1 : y ? 1 : 0; // empty cells last
        const nx = cellNumber(x), ny = cellNumber(y);
        if (nx !== null && ny !== null && nx !== ny) return nx - ny;
        return x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' });
      };
      const TOPS = {
        rowAbove: 'Insert row above', rowBelow: 'Insert row below', dupRow: 'Duplicate row', moveUp: 'Move row up', moveDown: 'Move row down', delRows: 'Delete row',
        colLeft: 'Insert column left', colRight: 'Insert column right', moveLeft: 'Move column left', moveRight: 'Move column right', delCols: 'Delete column',
        alignLeft: 'Align left', alignCenter: 'Align centre', alignRight: 'Align right', sortAsc: 'Sort A → Z', sortDesc: 'Sort Z → A', clearCells: 'Clear cells', delTable: 'Delete table',
      };
      function tableOp(b, op, sel, target) {
        const m = tableModel(b), rows = m.rows, n = m.n, empty = () => ({ cells: Array(rows[0].cells.length).fill(''), line: null });
        let { r, c } = sel; r = Math.max(0, Math.min(r, rows.length - 1)); c = Math.max(0, Math.min(c, n - 1));
        const R = sel.rows.filter((i) => i < rows.length), C = sel.cols.filter((i) => i < n);
        const lo = R.length ? R[0] : r, hi = R.length ? R[R.length - 1] : r, clo = C.length ? C[0] : c, chi = C.length ? C[C.length - 1] : c;
        const eachRow = (fn) => rows.forEach((row) => { fn(row.cells); row.line = null; });
        let to = [r, c], gone = false, msg = '';
        switch (op) {
          case 'rowAbove': rows.splice(r, 0, empty()); to = [r, c]; if (r === 0) msg = 'New header row -- the old header is now the first row'; break;
          case 'rowBelow': rows.splice(r + 1, 0, empty()); to = [r + 1, c]; break;
          case 'dupRow': rows.splice(hi + 1, 0, ...rows.slice(lo, hi + 1).map((x) => ({ cells: [...x.cells], line: null }))); to = [hi + 1, c]; break;
          case 'moveUp': if (lo === 0) return flash('Already the top row'); rows.splice(hi, 0, ...rows.splice(lo - 1, 1)); to = [r - 1, c]; break;
          case 'moveDown': if (hi >= rows.length - 1) return flash('Already the last row'); rows.splice(lo, 0, ...rows.splice(hi + 1, 1)); to = [r + 1, c]; break;
          case 'delRows': {
            const del = new Set(R.length ? R : [r]);
            if (del.size >= rows.length) { gone = true; break; }
            for (const i of [...del].sort((a, b2) => b2 - a)) rows.splice(i, 1);
            if (del.has(0)) msg = 'The first remaining row is now the header';
            to = [Math.min(lo, rows.length - 1), c]; msg = msg || (del.size > 1 ? `Deleted ${del.size} rows` : 'Row deleted'); break;
          }
          case 'colLeft': eachRow((x) => x.splice(c, 0, '')); m.aligns.splice(c, 0, ''); to = [r, c]; break;
          case 'colRight': eachRow((x) => x.splice(c + 1, 0, '')); m.aligns.splice(c + 1, 0, ''); to = [r, c + 1]; break;
          case 'moveLeft': if (clo === 0) return flash('Already the first column'); eachRow((x) => x.splice(chi, 0, ...x.splice(clo - 1, 1))); m.aligns.splice(chi, 0, ...m.aligns.splice(clo - 1, 1)); to = [r, c - 1]; break;
          case 'moveRight': if (chi >= n - 1) return flash('Already the last column'); eachRow((x) => x.splice(clo, 0, ...x.splice(chi + 1, 1))); m.aligns.splice(clo, 0, ...m.aligns.splice(chi + 1, 1)); to = [r, c + 1]; break;
          case 'delCols': {
            const del = new Set(C.length ? C : [c]);
            if (del.size >= n) { gone = true; break; }
            for (const i of [...del].sort((a, b2) => b2 - a)) { eachRow((x) => x.splice(i, 1)); m.aligns.splice(i, 1); }
            to = [r, Math.min(clo, n - del.size - 1)]; msg = del.size > 1 ? `Deleted ${del.size} columns` : 'Column deleted'; break;
          }
          case 'alignLeft': case 'alignCenter': case 'alignRight': {
            const a = { alignLeft: 'left', alignCenter: 'center', alignRight: 'right' }[op], cs = C.length ? C : [c];
            const same = cs.every((i) => m.aligns[i] === a); cs.forEach((i) => { m.aligns[i] = same ? '' : a; }); break;
          }
          case 'sortAsc': case 'sortDesc': {
            const body = rows.splice(1), k = c, dir = op === 'sortAsc' ? 1 : -1;
            body.sort((x, y) => { const v = cmpCells(x.cells[k] || '', y.cells[k] || ''); return !(x.cells[k] || '').trim() || !(y.cells[k] || '').trim() ? v : v * dir; });
            rows.push(...body); to = [1, c]; msg = `Sorted by "${rows[0].cells[k].trim() || 'column ' + (k + 1)}"`; break;
          }
          // Header toggle. Markdown always has a header line, so "no header" is an empty one; making a row the header
          // drops such an empty header instead of keeping it as a blank row, so the toggle round-trips.
          case 'makeHeader': {
            if (r === 0) return flash('This row is already the header');
            const old = rows[0], [row] = rows.splice(r, 1);
            if (old.cells.some((x) => x.trim())) rows.splice(1, 0, old); rows.splice(0, 1, row);
            to = [0, c]; msg = 'Header row set'; break;
          }
          case 'headerToRow': rows.unshift({ cells: Array(n).fill(''), line: null }); to = [0, c]; msg = 'Header is now a normal row -- type headings in the empty row, or leave it blank'; break;
          case 'moveCol': { // drag and drop: sel.from / sel.to are column indexes; to is a slot (0 = before the first column)
            const from = sel.from, slot = sel.to;
            if (slot === from || slot === from + 1) return;
            const dest = slot > from ? slot - 1 : slot;
            eachRow((x) => x.splice(dest, 0, ...x.splice(from, 1))); m.aligns.splice(dest, 0, ...m.aligns.splice(from, 1));
            to = [r, dest]; msg = 'Column moved'; break;
          }
          case 'moveRow': { // drag and drop: sel.from / sel.to are row indexes, the header being 0
            const from = sel.from, slot = sel.to;
            if (from < 1 || slot < 1 || slot === from || slot === from + 1) return;
            const [row] = rows.splice(from, 1), dest = slot > from ? slot - 1 : slot;
            rows.splice(dest, 0, row); to = [dest, c]; msg = 'Row moved'; break;
          }
          case 'clearCells': for (const [i, j] of sel.cells.length ? sel.cells : [[r, c]]) if (rows[i] && j < rows[i].cells.length) { rows[i].cells[j] = ''; rows[i].line = null; } break;
          case 'delTable': gone = true; break;
          default: return;
        }
        if (target) to = target;
        const lines = m.lines, rep = gone ? [] : [...tableText(m), ...lines.slice(m.l1 - m.trail, m.l1)];
        lines.splice(m.l0, m.l1 - m.l0, ...rep);
        if (gone && COLOUR_RE.test(lines[m.l0] || '')) lines.splice(m.l0, 1); // its colour comment goes with it
        applyText(lines.join('\n'), gone ? { l0: m.l0 } : { l0: m.l0, cell: to }, m.l0);
        if (gone) flash('Table deleted -- ⌘Z brings it back'); else if (msg) flash(msg);
      }
      function insertTable(b) {
        commitAll();
        const lines = S.text.split('\n'), at = b ? +b.dataset.l1 : lines.length;
        const tbl = ['| Column 1 | Column 2 | Column 3 |', '| --- | --- | --- |', '|  |  |  |', '|  |  |  |'];
        const pre = at > 0 && (lines[at - 1] || '').trim() ? [''] : [], post = at < lines.length && (lines[at] || '').trim() ? [''] : [];
        lines.splice(at, 0, ...pre, ...tbl, ...post);
        applyText(lines.join('\n'), { l0: at + pre.length, cell: [0, 0], select: true }, b ? +b.dataset.l0 : null);
        flash('Table added -- Tab moves between cells, right-click for rows and columns', 3000);
      }
      // Tab / Shift-Tab between cells; Tab in the last cell adds a row
      function moveCell(b, dir) {
        const rows = tableRows(b), cells = rows.flatMap((tr) => [...tr.children]), cur = cellOf(getSelection().anchorNode);
        const i = cells.indexOf(cur), next = cells[i + dir];
        if (next) return caretInCell(next, true);
        if (dir > 0 && i >= 0) { const sel = tableSel(b); tableOp(b, 'rowBelow', { ...sel, rows: [], cols: [] }, [sel.r + 1, 0]); }
      }

      // ---- colours: a column, a row or a cell; written into the table's colour comment (undoable like any table change) ----
      function colourTargets(b, sel, scope) {
        const rows = tableRows(b), hs = rows[0] ? [...rows[0].children].map(cellText) : [];
        const label = (i) => cellText(rows[i] && rows[i].children[0]);
        const cells = sel.cells.length ? sel.cells : [[sel.r, sel.c]];
        if (scope === 'col') return [...new Set(cells.map((p) => p[1]))].map((c) => ['cols', hs[c]]).filter((t) => t[1] !== undefined);
        if (scope === 'row') return [...new Set(cells.map((p) => p[0]).filter((i) => i > 0))].map((i) => ['rows', label(i)]);
        return cells.map(([i, c]) => (i === 0 ? ['cols', hs[c]] : ['cells', label(i) + '|' + hs[c]])); // a header cell colours its column
      }
      function colourOp(b, sel, scope, name, ink) {
        commitAll();
        const l0 = +b.dataset.l0, l1 = +b.dataset.l1, all = readColours(S.text.split('\n'), l0, l1).data, d = ink ? all.text : all;
        const ts = colourTargets(b, sel, scope);
        if (!ts.length) return flash(scope === 'row' ? 'The header row takes its colours from its columns' : 'Nothing to colour here');
        for (const [bag, key] of ts) {
          if (name) d[bag][key] = name; else delete d[bag][key];
          if (!name && bag === 'rows') for (const k of Object.keys(d.cells)) if (k.startsWith(key + '|')) delete d.cells[k]; // clearing a row clears its cells too
          if (!name && bag === 'cols') for (const k of Object.keys(d.cells)) if (k.endsWith('|' + key)) delete d.cells[k];
        }
        applyText(writeColours(S.text, l0, l1, all), { l0, cell: [sel.r, sel.c] }, l0);
        if (root.classList.contains('no-tcolour')) flash('Saved -- table colours are switched off on this Mac, the ◑ on the table turns them on', 3500);
      }
      // number bars for the selected column(s): only columns md.js judged to hold amounts can have them
      function barColumns(b, sel) {
        const rows = tableRows(b), hs = rows[0] ? [...rows[0].children] : [];
        const cs = [...new Set((sel.cells.length ? sel.cells : [[sel.r, sel.c]]).map((p) => p[1]))];
        return { all: cs.map((c) => hs[c]).filter(Boolean), ok: cs.map((c) => hs[c]).filter((th) => th && th.classList.contains('barv')).map(cellText) };
      }
      function barsOn(b, sel) {
        const { ok } = barColumns(b, sel); if (!ok.length) return false;
        const d = readColours(S.text.split('\n'), +b.dataset.l0, +b.dataset.l1).data;
        return ok.every((k) => d.bars.includes(k));
      }
      function barOp(b, sel) {
        commitAll();
        const { ok } = barColumns(b, sel);
        if (!ok.length) return flash('Number bars are for columns of amounts -- this one looks like IDs, codes or row numbers');
        const l0 = +b.dataset.l0, l1 = +b.dataset.l1, d = readColours(S.text.split('\n'), l0, l1).data, on = ok.every((k) => d.bars.includes(k));
        d.bars = on ? d.bars.filter((k) => !ok.includes(k)) : [...d.bars, ...ok];
        applyText(writeColours(S.text, l0, l1, d), { l0, cell: [sel.r, sel.c] }, l0);
      }
      // the default scope from the selection: whole rows -> Row, whole columns -> Column, a header cell -> Column, else Cell
      let lastScope = null;
      function scopeFor(b, sel) {
        const rows = tableRows(b), n = rows[0] ? rows[0].children.length : 0, cells = sel.cells.length ? sel.cells : [[sel.r, sel.c]];
        const byRow = new Map(), byCol = new Map();
        cells.forEach(([i, c]) => { byRow.set(i, (byRow.get(i) || 0) + 1); byCol.set(c, (byCol.get(c) || 0) + 1); });
        if (sel.whole === 'row' || (cells.length > 1 && [...byRow.values()].every((x) => x === n) && ![...byRow.keys()].includes(0))) return 'row';
        if (sel.whole === 'col' || (cells.length > 1 && [...byCol.values()].every((x) => x === rows.length)) || cells.every(([i]) => i === 0)) return 'col';
        return cells.length === 1 && lastScope ? lastScope : 'cell';
      }
      // the picker: Cell / Row / Column, Fill / Text, a shade (light .. dark) and 16 colours; ✕ removes the fill or text colour
      let lastInk = false, lastShade = 'soft';
      function colourPicker(b, sel, done, onPick) {
        let scope = scopeFor(b, sel), ink = lastInk, shade = lastShade;
        const seg = (cls, items, get, set) => {
          const el = h('span', { class: 'wseg ' + cls, role: 'tablist' });
          items.forEach(([k, label, tip]) => el.append(h('button', { type: 'button', 'data-k': k, title: tip || '', onmousedown: (e) => e.preventDefault(),
            onclick: (e) => { e.stopPropagation(); set(k); sync(); } }, label)));
          el.sync = () => el.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.k === String(get())));
          return el;
        };
        const tabs = seg('wscope', [['cell', 'Cell'], ['row', 'Row'], ['col', 'Column']], () => scope, (k) => { scope = k; lastScope = k; });
        tabs.querySelectorAll('button').forEach((x) => { x.dataset.scope = x.dataset.k; });
        const kind = seg('wkind', [['false', 'Fill', 'Colour the background'], ['true', 'Text', 'Colour the text']], () => ink, (k) => { ink = lastInk = k === 'true'; });
        const shades = h('span', { class: 'wshade', role: 'tablist' }, ...SHADES.map(([k, label]) => h('button', { type: 'button', class: 'sh', 'data-sh': k, title: label, 'aria-label': label + ' shade',
          onmousedown: (e) => e.preventDefault(), onclick: (e) => { e.stopPropagation(); shade = lastShade = k; sync(); } })));
        const box = h('div', { class: 'wcolours' });
        function sync() {
          tabs.sync(); kind.sync();
          shades.querySelectorAll('.sh').forEach((x) => x.classList.toggle('on', x.dataset.sh === shade));
          box.dataset.sh = shade; box.dataset.ink = ink ? 'text' : 'fill';
          box.querySelector('.sw.none').title = ink ? 'Remove text colour' : 'Remove fill colour';
        }
        const pick = (name) => { done && done(); (onPick || ((sc, v, k) => colourOp(b, sel, sc, v, k)))(scope, name && joinColour(name, shade), ink); };
        box.append(h('div', { class: 'wch' }, h('span', {}, 'Colour'), tabs),
          h('div', { class: 'wch2' }, kind, shades),
          h('div', { class: 'wsw' }, ...COL_COLOURS.map(([name, hex]) => h('button', { type: 'button', class: 'sw', title: name[0].toUpperCase() + name.slice(1), style: '--cc:' + hex, 'data-cc': name,
            onmousedown: (e) => e.preventDefault(), onclick: () => pick(name) }, h('b', {}, 'A'))),
          h('button', { type: 'button', class: 'sw none', html: '&#x2715;', onmousedown: (e) => e.preventDefault(), onclick: () => pick(null) })));
        sync();
        return box;
      }
      // ---- the menu ----
      const menu = h('div', { class: 'wmenu', role: 'menu', hidden: '' });
      root.append(menu);
      function hideMenu() { menu.hidden = true; menu.replaceChildren(); }
      function showMenu(x, y, b, sel, above) {
        const nr = sel.rows.length || 1, nc = sel.cols.length || 1, rows = tableRows(b), n = rows[0] ? rows[0].children.length : 0;
        const lo = sel.rows.length ? sel.rows[0] : sel.r, hi = sel.rows.length ? sel.rows[nr - 1] : sel.r;
        const clo = sel.cols.length ? sel.cols[0] : sel.c, chi = sel.cols.length ? sel.cols[nc - 1] : sel.c;
        const item = (op, label, key, dis, danger) => h('button', { type: 'button', role: 'menuitem', class: danger ? 'danger' : '', disabled: dis ? '' : null,
          onmousedown: (e) => e.preventDefault(), onclick: () => { hideMenu(); tableOp(b, op, sel); } }, h('span', {}, label), key ? h('kbd', {}, key) : null);
        const grp = (name) => h('div', { class: 'wmh' }, name);
        const aligned = (op, glyph, tip) => h('button', { type: 'button', class: 'wal', title: tip, onmousedown: (e) => e.preventDefault(), onclick: () => { hideMenu(); tableOp(b, op, sel); } , html: glyph });
        const hdr = lo === 0;
        const barItem = (bb, ss) => { const { ok, all } = barColumns(bb, ss), on = barsOn(bb, ss);
          return h('button', { type: 'button', role: 'menuitem', disabled: ok.length ? null : '', title: ok.length ? '' : (all.some((th) => th.classList.contains('num')) ? 'These numbers look like IDs, codes or row numbers, so a bar would mean nothing' : 'Only for columns of numbers'),
            onmousedown: (e) => e.preventDefault(), onclick: () => { hideMenu(); barOp(bb, ss); } }, h('span', {}, on ? 'Hide number bars' : 'Show number bars')); };
        menu.replaceChildren(
          colourPicker(b, sel, hideMenu),
          grp(nr > 1 ? `${nr} rows` : hdr ? 'Header row' : 'Row'),
          item('rowAbove', 'Insert row above'), item('rowBelow', 'Insert row below', '⌘↩'), item('dupRow', nr > 1 ? `Duplicate ${nr} rows` : 'Duplicate row'),
          item('moveUp', 'Move up', '', lo === 0), item('moveDown', 'Move down', '', hi >= rows.length - 1),
          item(hdr ? 'headerToRow' : 'makeHeader', hdr ? 'Turn header into a normal row' : 'Make this the header row', '', nr > 1),
          item('delRows', nr > 1 ? `Delete ${nr} rows` : 'Delete row', '', false, true),
          grp(nc > 1 ? `${nc} columns` : 'Column'),
          item('colLeft', 'Insert column left'), item('colRight', 'Insert column right'),
          item('moveLeft', 'Move left', '', clo === 0), item('moveRight', 'Move right', '', chi >= n - 1),
          h('div', { class: 'walign' }, h('span', {}, 'Align'),
            aligned('alignLeft', '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M2 4h12M2 8h8M2 12h11" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>', 'Align left'),
            aligned('alignCenter', '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M2 4h12M4 8h8M3 12h10" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>', 'Align centre'),
            aligned('alignRight', '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M2 4h12M6 8h8M3 12h11" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>', 'Align right')),
          item('sortAsc', 'Sort by this column, A → Z'), item('sortDesc', 'Sort by this column, Z → A'),
          barItem(b, sel),
          item('delCols', nc > 1 ? `Delete ${nc} columns` : 'Delete column', '', false, true),
          grp('Table'),
          h('button', { type: 'button', role: 'menuitem', onmousedown: (e) => e.preventDefault(), onclick: () => { hideMenu(); toggleTableColours(); } }, h('span', {}, root.classList.contains('no-tcolour') ? 'Turn table colours on' : 'Turn table colours off')),
          item('clearCells', sel.cells.length > 1 ? `Clear ${sel.cells.length} cells` : 'Clear cell'), item('delTable', 'Delete table', '', false, true));
        menu.hidden = false;
        const mw = menu.offsetWidth, mh = menu.offsetHeight;
        menu.style.left = Math.max(8, Math.min(x, innerWidth - mw - 8)) + 'px';
        menu.style.top = Math.max(8, Math.min(above ? y - mh - 8 : y, innerHeight - mh - 8)) + 'px';
      }
      document.addEventListener('mousedown', (e) => { if (!menu.hidden && !menu.contains(e.target)) hideMenu(); }, true);
      document.addEventListener('keydown', (e) => { if (!menu.hidden && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hideMenu(); } }, true);
      content.addEventListener('scroll', () => { if (!menu.hidden) hideMenu(); }, { passive: true });
      // ---- drag a table row by its handle ----
      // One floating grip (outside the page, so it never ends up in the file) follows the row under the pointer. Dragging it
      // shows a line where the row will land; dropping moves the row in the markdown. Body rows only: the header is set
      // with the Header toggle. Esc cancels.
      const grip = h('div', { class: 'wdrag', title: 'Drag to move this row', hidden: '',
        html: '<svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true"><g fill="currentColor"><circle cx="2.5" cy="3" r="1.3"/><circle cx="7.5" cy="3" r="1.3"/><circle cx="2.5" cy="8" r="1.3"/><circle cx="7.5" cy="8" r="1.3"/><circle cx="2.5" cy="13" r="1.3"/><circle cx="7.5" cy="13" r="1.3"/></g></svg>' });
      const dropLine = h('div', { class: 'wdrop', hidden: '' });
      root.append(grip, dropLine);
      let gripRow = null, drag = null;
      const bodyRows = (b) => [...b.querySelectorAll('table > tbody > tr')];
      function placeGrip(tr) {
        gripRow = tr;
        const r = tr.getBoundingClientRect(), t = tr.closest('table').getBoundingClientRect();
        grip.hidden = false; grip.style.left = (t.left - 22) + 'px'; grip.style.top = (r.top + r.height / 2 - 11) + 'px';
      }
      function hideGrip() { if (drag) return; grip.hidden = true; gripRow = null; }
      doc.addEventListener('mousemove', (e) => {
        if (!ok() || drag) return;
        const tr = e.target.closest && e.target.closest('.table-wrap tbody > tr');
        if (tr && blockOf(tr)) return placeGrip(tr);
        // on the way from a row to the grip, the pointer crosses the margin left of the table: keep the grip there
        if (gripRow && gripRow.isConnected) { const r = gripRow.getBoundingClientRect(); if (e.clientY >= r.top && e.clientY <= r.bottom && e.clientX >= r.left - 34 && e.clientX <= r.right) return; }
        hideGrip();
      });
      content.addEventListener('scroll', () => { if (!drag) hideGrip(); }, { passive: true });
      // the slot (0 = before the first body row) nearest the pointer, among the rows a filter has not hidden
      function slotAt(y) {
        const rows = bodyRows(drag.b), vis = rows.filter((tr) => tr.offsetParent !== null);
        for (const tr of vis) { const r = tr.getBoundingClientRect(); if (y < r.top + r.height / 2) return { slot: rows.indexOf(tr), y: r.top }; }
        const last = vis[vis.length - 1]; return { slot: rows.indexOf(last) + 1, y: last.getBoundingClientRect().bottom };
      }
      grip.addEventListener('pointerdown', (e) => {
        if (!gripRow || !ok() || e.button !== 0) return;
        const b = blockOf(gripRow); if (!b) return;
        e.preventDefault(); commitAll(); hideMenu();
        grip.setPointerCapture(e.pointerId);
        drag = { b, tr: gripRow, from: bodyRows(b).indexOf(gripRow), slot: -1, x0: e.clientX, y0: e.clientY, moved: false };
        gripRow.classList.add('wdragging'); root.classList.add('w-dragging');
      });
      grip.addEventListener('pointermove', (e) => {
        if (!drag) return;
        if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > 4) drag.moved = true; else return;
        const { slot, y } = slotAt(e.clientY), t = drag.tr.closest('table').getBoundingClientRect();
        drag.slot = slot;
        const still = slot === drag.from || slot === drag.from + 1;
        dropLine.hidden = still;
        if (!still) { dropLine.style.left = t.left + 'px'; dropLine.style.width = t.width + 'px'; dropLine.style.top = (y - 1.5) + 'px'; }
        grip.style.top = (e.clientY - 11) + 'px';
      });
      function endDrag(apply) {
        if (!drag) return;
        const d = drag; drag = null;
        d.tr.classList.remove('wdragging'); root.classList.remove('w-dragging'); dropLine.hidden = true; grip.hidden = true; gripRow = null;
        if (apply && !d.moved) return selectWhole(d.b, 'row', d.from + 1);
        if (apply && d.slot >= 0 && d.slot !== d.from && d.slot !== d.from + 1) tableOp(d.b, 'moveRow', { rows: [], cols: [], cells: [], r: d.from + 1, c: 0, from: d.from + 1, to: d.slot + 1 });
      }
      grip.addEventListener('pointerup', () => endDrag(true));
      grip.addEventListener('pointercancel', () => endDrag(false));
      document.addEventListener('keydown', (e) => { if (drag && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endDrag(false); } }, true);

      // ---- drag a table column by its handle (shown above the header cell under the pointer) ----
      const cgrip = h('div', { class: 'wdrag col', title: 'Drag to move this column', hidden: '',
        html: '<svg viewBox="0 0 16 10" width="16" height="10" aria-hidden="true"><g fill="currentColor"><circle cx="3" cy="2.5" r="1.3"/><circle cx="8" cy="2.5" r="1.3"/><circle cx="13" cy="2.5" r="1.3"/><circle cx="3" cy="7.5" r="1.3"/><circle cx="8" cy="7.5" r="1.3"/><circle cx="13" cy="7.5" r="1.3"/></g></svg>' });
      const cdrop = h('div', { class: 'wdrop v', hidden: '' });
      root.append(cgrip, cdrop);
      let gripTh = null, cdrag = null;
      const headCells = (b) => { const tr = b.querySelector('table > thead > tr:not(.filters)'); return tr ? [...tr.children] : []; };
      function placeCgrip(th) {
        gripTh = th; const r = th.getBoundingClientRect();
        cgrip.hidden = false; cgrip.style.left = (r.left + r.width / 2 - 11) + 'px'; cgrip.style.top = (r.top - 13) + 'px';
      }
      function hideCgrip() { if (cdrag) return; cgrip.hidden = true; gripTh = null; }
      doc.addEventListener('mousemove', (e) => {
        if (!ok() || cdrag || drag) return;
        const th = e.target.closest && e.target.closest('.table-wrap thead > tr:not(.filters) > th');
        if (th && blockOf(th)) return placeCgrip(th);
        // on the way up to the grip the pointer crosses the strip above the header: keep the grip there
        if (gripTh && gripTh.isConnected) { const r = gripTh.getBoundingClientRect(); if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top - 26 && e.clientY <= r.bottom) return; }
        hideCgrip();
      });
      content.addEventListener('scroll', () => { if (!cdrag) hideCgrip(); }, { passive: true });
      function colSlotAt(x) {
        const ths = headCells(cdrag.b);
        for (const [i, th] of ths.entries()) { const r = th.getBoundingClientRect(); if (x < r.left + r.width / 2) return { slot: i, x: r.left }; }
        return { slot: ths.length, x: ths[ths.length - 1].getBoundingClientRect().right };
      }
      const colCells = (b, i) => [...b.querySelectorAll('table > thead > tr:not(.filters), table > tbody > tr')].map((tr) => tr.children[i]).filter(Boolean);
      cgrip.addEventListener('pointerdown', (e) => {
        if (!gripTh || !ok() || e.button !== 0) return;
        const b = blockOf(gripTh); if (!b) return;
        e.preventDefault(); commitAll(); hideMenu(); hideGrip();
        cgrip.setPointerCapture(e.pointerId);
        const from = headCells(b).indexOf(gripTh);
        cdrag = { b, from, slot: -1, cells: colCells(b, from), x0: e.clientX, y0: e.clientY, moved: false };
        cdrag.cells.forEach((c) => c.classList.add('wdragging')); root.classList.add('w-dragging');
      });
      cgrip.addEventListener('pointermove', (e) => {
        if (!cdrag) return;
        if (Math.hypot(e.clientX - cdrag.x0, e.clientY - cdrag.y0) > 4) cdrag.moved = true; else return;
        const { slot, x } = colSlotAt(e.clientX), t = cdrag.b.querySelector('table').getBoundingClientRect();
        cdrag.slot = slot;
        const still = slot === cdrag.from || slot === cdrag.from + 1;
        cdrop.hidden = still;
        if (!still) { cdrop.style.left = (x - 1.5) + 'px'; cdrop.style.top = t.top + 'px'; cdrop.style.height = t.height + 'px'; }
        cgrip.style.left = (e.clientX - 11) + 'px';
      });
      function endCdrag(apply) {
        if (!cdrag) return;
        const d = cdrag; cdrag = null;
        d.cells.forEach((c) => c.classList.remove('wdragging')); root.classList.remove('w-dragging'); cdrop.hidden = true; cgrip.hidden = true; gripTh = null;
        if (apply && !d.moved) return selectWhole(d.b, 'col', d.from);
        if (apply && d.slot >= 0 && d.slot !== d.from && d.slot !== d.from + 1) tableOp(d.b, 'moveCol', { rows: [], cols: [], cells: [], r: 0, c: d.from, from: d.from, to: d.slot });
      }
      cgrip.addEventListener('pointerup', () => endCdrag(true));
      cgrip.addEventListener('pointercancel', () => endCdrag(false));
      document.addEventListener('keydown', (e) => { if (cdrag && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endCdrag(false); } }, true);

      // ---- whole row / column selection: click a grip (without dragging) ----
      // A soft ring marks the row or column, and a small pill beside it holds what you do with a whole row / column.
      // Delete or Backspace removes it, Esc (or a click elsewhere) lets go. Table actions and the right-click menu act on it.
      let wsel = null;
      const pill = h('div', { class: 'wpill', role: 'toolbar', hidden: '' });
      root.append(pill);
      function wholeSel(ws) {
        const rows = tableRows(ws.b), n = rows[0] ? rows[0].children.length : 0;
        if (ws.kind === 'row') return { rows: [ws.i], cols: [...Array(n).keys()], cells: [...Array(n).keys()].map((c) => [ws.i, c]), r: ws.i, c: 0, whole: 'row' };
        return { rows: [...rows.keys()], cols: [ws.i], cells: [...rows.keys()].map((r) => [r, ws.i]), r: 0, c: ws.i, whole: 'col' };
      }
      function clearWhole() {
        if (!wsel) return; wsel = null; pill.hidden = true; pill.replaceChildren();
        doc.querySelectorAll('.wsel, .wsel-first, .wsel-last').forEach((x) => x.classList.remove('wsel', 'wsel-first', 'wsel-last'));
        root.classList.remove('w-whole');
      }
      function selectWhole(b, kind, i) {
        clearWhole();
        const rows = tableRows(b); if (!rows[i] && kind === 'row') return;
        const cells = kind === 'row' ? [...rows[i].children] : rows.map((tr) => tr.children[i]).filter(Boolean);
        if (!cells.length) return;
        wsel = { b, kind, i };
        cells.forEach((x) => x.classList.add('wsel')); cells[0].classList.add('wsel-first'); cells[cells.length - 1].classList.add('wsel-last');
        root.classList.add('w-whole'); root.dataset.whole = kind;
        caretInCell(cells[0]); // keeps the keyboard in the table; the ring is the visible selection
        const sel = wholeSel(wsel), op = (name) => () => { const ws = wsel; clearWhole(); tableOp(ws.b, name, sel); };
        const ico = (svg) => '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + svg + '</svg>';
        const btn = (title, html, fn, cls) => h('button', { type: 'button', title, class: cls || '', html, onmousedown: (e) => e.preventDefault(), onclick: fn });
        const swatch = h('button', { type: 'button', class: 'wpc', title: 'Colour this ' + (kind === 'row' ? 'row' : 'column'), onmousedown: (e) => e.preventDefault(),
          onclick: (e) => { e.stopPropagation(); const open = pill.querySelector('.wcolours'); if (open) { open.remove(); return; } const p = colourPicker(b, sel, clearWhole); p.querySelector('.wscope').remove(); pill.append(p); } });
        const label = h('span', { class: 'wpl' }, kind === 'row' ? (i === 0 ? 'Header' : 'Row ' + i) : (cellText(rows[0].children[i]) || 'Column ' + (i + 1)));
        const parts = kind === 'row'
          ? [label, swatch, btn('Insert a row above', ico('<path d="M8 3v6M5 6h6M3 13h10"/>'), op('rowAbove')), btn('Insert a row below', ico('<path d="M8 7v6M5 10h6M3 3h10"/>'), op('rowBelow')),
            btn('Duplicate', ico('<rect x="5" y="5" width="8" height="8" rx="1.5"/><path d="M3 10V4a1 1 0 0 1 1-1h6"/>'), op('dupRow')),
            i > 0 ? btn('Make this the header row', ico('<path d="M3 4h10M3 8h10M3 12h6"/>'), op('makeHeader')) : btn('Turn the header into a normal row', ico('<path d="M3 4h10M3 8h10M3 12h6"/>'), op('headerToRow')),
            btn('Delete row', ico('<path d="M3 5h10M6.5 5V3.5h3V5M5 5l.6 8h4.8L11 5"/>'), op('delRows'), 'danger')]
          : [label, swatch, btn('Insert a column left', ico('<path d="M9 8H3M6 5v6M13 3v10"/>'), op('colLeft')), btn('Insert a column right', ico('<path d="M7 8h6M10 5v6M3 3v10"/>'), op('colRight')),
            rows[0].children[i] && rows[0].children[i].classList.contains('barv') ? btn(barsOn(b, sel) ? 'Hide number bars' : 'Show number bars', ico('<path d="M3 4h7M3 8h10M3 12h4"/>'), () => { clearWhole(); barOp(b, sel); }, barsOn(b, sel) ? 'on' : '') : null,
            btn('Sort A → Z', ico('<path d="M4 3v10M2 11l2 2 2-2M9 4h5M9 8h3.5M9 12h2"/>'), op('sortAsc')), btn('Sort Z → A', ico('<path d="M4 13V3M2 5l2-2 2 2M9 4h2M9 8h3.5M9 12h5"/>'), op('sortDesc')),
            btn('Delete column', ico('<path d="M3 5h10M6.5 5V3.5h3V5M5 5l.6 8h4.8L11 5"/>'), op('delCols'), 'danger')];
        pill.replaceChildren(...parts.filter(Boolean));
        pill.hidden = false;
        const first = cells[0].getBoundingClientRect(), last = cells[cells.length - 1].getBoundingClientRect(), pw = pill.offsetWidth, ph = pill.offsetHeight;
        let x, y;
        if (kind === 'row') { x = last.right - pw; y = first.top - ph - 6; if (y < content.getBoundingClientRect().top + 4) y = first.bottom + 6; }
        else { x = first.left + first.width / 2 - pw / 2; y = first.top - ph - 18; if (y < content.getBoundingClientRect().top + 4) y = last.bottom + 6; }
        pill.style.left = Math.max(8, Math.min(x, innerWidth - pw - 8)) + 'px'; pill.style.top = y + 'px';
      }
      document.addEventListener('mousedown', (e) => { if (wsel && !pill.contains(e.target) && !menu.contains(e.target) && e.button === 0) clearWhole(); }, true);
      content.addEventListener('scroll', () => { if (wsel) clearWhole(); }, { passive: true });
      document.addEventListener('keydown', (e) => {
        if (!wsel) return;
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); clearWhole(); return; }
        if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); e.stopPropagation(); const ws = wsel, sel = wholeSel(ws); clearWhole(); tableOp(ws.b, ws.kind === 'row' ? 'delRows' : 'delCols', sel); return; }
        if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1) clearWhole(); // typing goes into the cell, the whole-row selection lets go
      }, true);

      doc.addEventListener('contextmenu', (e) => {
        if (!ok()) return; const cell = e.target.closest('td, th'), b = cell && blockOf(cell);
        if (!b || WR.kindOf(b) !== 'table' || cell.closest('tr.filters')) return;
        e.preventDefault(); commitAll();
        const sel = tableSel(b, cell);
        if (sel.cells.length === 1) caretInCell(cell); // a right-click outside the selection moves the caret to that cell
        showMenu(e.clientX, e.clientY, b, sel);
      });

      // ---- deleting (or typing over) a selection that crosses blocks, sections or table cells ----
      // within one table: rows the selection covers end to end are removed, the selected text of other cells cleared
      function tableCut(b, r) {
        const rows = tableRows(b); let firstCell = null, removed = 0, touched = 0, headCovered = false;
        for (const [i, tr] of rows.entries()) {
          const cells = [...tr.children]; if (!cells.some((c) => r.intersectsNode(c))) continue;
          touched++;
          const rr = document.createRange(); rr.selectNodeContents(tr);
          const fromStart = r.compareBoundaryPoints(Range.START_TO_START, rr) <= 0 || !txt(tr, 0, r.startContainer, r.startOffset).trim();
          const toEnd = r.compareBoundaryPoints(Range.END_TO_END, rr) >= 0 || !txt(r.endContainer, r.endOffset, tr, tr.childNodes.length).trim();
          if (fromStart && toEnd) { if (i === 0) headCovered = true; else { tr.remove(); removed++; continue; } }
          for (const c of cells) {
            if (!r.intersectsNode(c)) continue;
            const x = document.createRange(); x.selectNodeContents(c);
            if (c.contains(r.startContainer)) x.setStart(r.startContainer, r.startOffset);
            if (c.contains(r.endContainer)) x.setEnd(r.endContainer, r.endOffset);
            [...c.querySelectorAll('button')].forEach((bt) => bt.remove()); // the filter funnel; rebuilt on the next render
            x.deleteContents(); if (!firstCell) firstCell = [c, x.startContainer, x.startOffset];
          }
        }
        const allGone = headCovered && removed === rows.length - 1;
        return { firstCell, allGone, touched };
      }
      function needsUs(r) {
        const bl = topBlocks().filter((x) => r.intersectsNode(x));
        if (bl.length !== 1) return true;
        const b = bl[0];
        if (!b.classList.contains('wblock') || !b.contains(r.startContainer) || !b.contains(r.endContainer)) return true;
        if (WR.kindOf(b) === 'table') { const cs = tableRows(b).flatMap((tr) => [...tr.children]).filter((c) => r.intersectsNode(c)); return cs.length > 1; }
        return false;
      }
      function cutRange(r0, insert, join) { busy++; try { cutNow(r0, insert || '', join); } finally { busy--; } track(); }
      function cutNow(r0, insert, joining) {
        commitAll();
        const r = r0.cloneRange();
        let bl = topBlocks().filter((x) => r.intersectsNode(x));
        // a triple-click ends the selection at the very start of the next block: that block is not part of it
        if (!joining && bl.length > 1 && !txt(bl[bl.length - 1], 0, r.endContainer, r.endOffset).length) { bl.pop(); const e = textHost(bl[bl.length - 1]); r.setEnd(e, e.childNodes.length); }
        if (!bl.length) return;
        if (bl.length === 1) {
          const b = bl[0], k = WR.kindOf(b);
          if (!b.classList.contains('wblock')) return;
          if (k === 'table') {
            const res = tableCut(b, r);
            if (res.allGone) { const lines = S.text.split('\n'); lines.splice(+b.dataset.l0, +b.dataset.l1 - +b.dataset.l0); applyText(lines.join('\n'), { l0: +b.dataset.l0 }, +b.dataset.l0); return; }
            const before = S.text;
            if (res.firstCell && res.firstCell[0].isConnected) {
              const [, n, o] = res.firstCell; const x = document.createRange(); x.setStart(n, o);
              if (insert) { const tn = document.createTextNode(insert); x.insertNode(tn); setCaret(tn, insert.length); } else setCaret(n, o);
            }
            dirty.add(b); commit(b);
            if (S.text !== before) { hist.push({ before, after: S.text }); redo.length = 0; }
            if (res.touched > 1 && tableRows(b).length < res.touched) flash('Rows deleted -- ⌘Z brings them back');
            return;
          }
          // one block, but the range reached past it: keep the part inside
          const x = document.createRange(); x.setStart(r.startContainer, r.startOffset); x.setEnd(r.endContainer, r.endOffset); x.deleteContents();
          if (insert) { const tn = document.createTextNode(insert); x.insertNode(tn); setCaret(tn, insert.length); } else setCaret(x.startContainer, x.startOffset);
          if (!hostOf(b).textContent.trim() && k === 'p' && !b.querySelector('img')) hostOf(b).replaceChildren(h('br'));
          mark(b); return;
        }
        const lines = S.text.split('\n'), first = bl[0], last = bl[bl.length - 1];
        const fk = first.classList.contains('wblock') ? WR.kindOf(first) : null, lk = last.classList.contains('wblock') ? WR.kindOf(last) : null;
        const L0 = +first.dataset.l0, L1 = +last.dataset.l1;
        const srcOf = (x) => { const own = lines.slice(+x.dataset.l0, +x.dataset.l1); while (own.length && !own[own.length - 1].trim()) own.pop(); return own.join('\n'); };
        const origFirst = srcOf(first), origLast = srcOf(last);
        let join = null; // [node, offset] where the two halves meet (inside the first block)
        if (fk === 'table') { const res = tableCut(first, r); if (res.allGone) first.dataset.gone = '1'; }
        else if (fk) {
          const e = textHost(first), x = document.createRange(); x.setStart(r.startContainer, r.startOffset); x.setEnd(e, e.childNodes.length);
          x.deleteContents(); join = [x.startContainer, x.startOffset];
        }
        if (lk === 'table') { const res = tableCut(last, r); if (res.allGone) last.dataset.gone = '1'; }
        else if (lk) { const s = textHost(last), x = document.createRange(); x.setStart(s, 0); x.setEnd(r.endContainer, r.endOffset); x.deleteContents(); }
        // the caret marker and the typed text go where the halves meet; the rest of a paragraph (or the first bullet) joins it
        if (join && TEXTISH.includes(fk)) {
          const x = document.createRange(); x.setStart(join[0], join[1]);
          let tail = null;
          if (lk === 'p' || lk === 'h') { tail = itemsOf(last)[0]; last.dataset.gone = '1'; }
          else if (lk === 'list') { const li = last.querySelector(':scope > li'); if (li && !li.querySelector('ul, ol')) { tail = document.createDocumentFragment(); tail.append(...[...li.childNodes].filter((c) => !(c.nodeType === 1 && c.tagName === 'INPUT'))); li.remove(); } }
          else if (lk === 'quote') { const p = last.querySelector(':scope > p'); if (p) { tail = document.createDocumentFragment(); tail.append(...p.childNodes); p.remove(); } }
          if (tail) x.insertNode(tail);
          x.insertNode(document.createTextNode(insert + MK));
        } else if (lk && lk !== 'table' && lk !== 'code') { const s = textHost(last); s.insertBefore(document.createTextNode(insert + MK), s.firstChild); }
        const md = (x, k, orig) => (x.dataset.gone ? '' : k ? WR.block(x, orig) || '' : orig);
        const parts = [md(first, fk, origFirst), md(last, lk, origLast)].filter((p) => p.trim());
        const own = lines.slice(L0, L1); let trail = 0; while (trail < own.length && !own[own.length - 1 - trail].trim()) trail++;
        const rep = parts.length ? [...parts.join('\n\n').split('\n'), ...own.slice(own.length - trail)] : [];
        lines.splice(L0, L1 - L0, ...rep);
        applyText(lines.join('\n'), { l0: L0 }, L0);
      }
      // Backspace at the start of a paragraph / heading joins it to the text block above; Delete at the end pulls the next one up
      function joinBlocks(a, b) {
        const ka = WR.kindOf(a), kb = WR.kindOf(b);
        if (!a.classList.contains('wblock') || !b.classList.contains('wblock') || !TEXTISH.includes(ka) || !['p', 'h'].includes(kb)) return false;
        const ns = textNodes(textHost(a)), r = document.createRange();
        if (ns.length) { const l = ns[ns.length - 1]; r.setStart(l, l.length); } else r.setStart(textHost(a), textHost(a).childNodes.length);
        r.setEnd(textHost(b), 0);
        cutRange(r, '', true);
        return true;
      }
      const neighbour = (b, d) => { const all = topBlocks(); return all[all.indexOf(b) + d] || null; };

      document.addEventListener('selectionchange', () => { if (S.mode === 'write') { barState(); track(); } });
      // the block holding the caret: highlighted, and committed (an empty new line removed) when the caret leaves it
      let cur = null;
      function track() {
        if (!ok() || busy) return;
        const b = document.activeElement === doc ? selBlock() : null;
        if (b === cur) return;
        const prev = cur; cur = b;
        if (prev) prev.classList.remove('wcur');
        if (b) b.classList.add('wcur');
        if (prev) leave(prev);
      }
      function leave(b) {
        if (dirty.has(b)) commit(b);
        if (b.isConnected && b.dataset.l0 === b.dataset.l1 && !hostOf(b).textContent.trim() && !b.querySelector('img') && doc.querySelectorAll('.wblock').length > 1) b.remove(); // an empty new line you left
      }
      doc.addEventListener('beforeinput', (e) => {
        if (!ok() || busy) return;
        const t = e.inputType;
        if (t === 'historyUndo' || t === 'historyRedo') { if (undo(t === 'historyRedo')) e.preventDefault(); return; }
        const s = getSelection(); if (!s.rangeCount) return;
        const r = s.getRangeAt(0);
        if (r.collapsed) { if (!blockOf(r.startContainer)) e.preventDefault(); return; } // between blocks: nothing to type into
        if (!needsUs(r)) return;
        if (t === 'insertFromDrop' || t === 'deleteByDrag') { e.preventDefault(); return; }
        if (/^(insert|delete)/.test(t)) {
          e.preventDefault();
          const text = /^insert(Text|ReplacementText|FromPaste)$/.test(t) ? (e.data != null ? e.data : e.dataTransfer ? e.dataTransfer.getData('text/plain') : '') : '';
          cutRange(r, text);
        }
      });
      doc.addEventListener('cut', (e) => {
        if (!ok()) return; const s = getSelection(); if (!s.rangeCount || s.isCollapsed || !needsUs(s.getRangeAt(0))) return;
        e.preventDefault(); if (e.clipboardData) e.clipboardData.setData('text/plain', s.toString());
        cutRange(s.getRangeAt(0), '');
      });
      doc.addEventListener('input', (e) => {
        if (!ok()) return; const b = selBlock(); if (!b) return;
        // "## ", "- ", "1. ", "> ", "[ ] " typed at the very start of a paragraph turn it into that kind of block
        if (WR.kindOf(b) === 'p' && e.inputType === 'insertText' && e.data === ' ') {
          const f = b.firstChild, s = getSelection();
          const sc = f && f.nodeType === 3 && WR.shortcut(f.nodeValue.replace(/\u00a0/g, ' '));
          if (sc && s.anchorNode === f && s.anchorOffset === sc.cut) { f.nodeValue = f.nodeValue.slice(sc.cut); const x = convert(b, sc.tag, sc.checked); if (x) caretTo(x, false); return; }
        }
        mark(b);
      });
      doc.addEventListener('focusout', (e) => {
        if (!ok() || busy || (e.relatedTarget && doc.contains(e.relatedTarget))) return;
        if (cur) { const p = cur; cur.classList.remove('wcur'); cur = null; leave(p); }
      });
      doc.addEventListener('paste', (e) => {
        if (!ok() || !selBlock() || !S.text.trim()) return; // an empty document: the shell's paste handler fills it as markdown
        const t = e.clipboardData && e.clipboardData.getData('text/plain'); if (t == null) return;
        e.preventDefault(); document.execCommand('insertText', false, t); // plain text only: no foreign styling
      });
      doc.addEventListener('keydown', (e) => {
        if (!ok()) return;
        const mod = e.metaKey || e.ctrlKey, s = getSelection();
        if (mod && !e.altKey && e.key.toLowerCase() === 'z') { if (undo(e.shiftKey)) { e.preventDefault(); return; } }
        if ((e.key === 'Backspace' || e.key === 'Delete') && s.rangeCount && !s.isCollapsed && needsUs(s.getRangeAt(0))) { e.preventDefault(); cutRange(s.getRangeAt(0), ''); return; }
        const b = selBlock();
        if (!b) { if (e.key === 'Escape') doc.blur(); else if (!mod && (e.key.length === 1 || e.key === 'Enter' || e.key === 'Backspace' || e.key === 'Delete') && s.isCollapsed) e.preventDefault(); return; }
        const k = WR.kindOf(b), host = hostOf(b);
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); doc.blur(); return; }
        if (mod && e.key.toLowerCase() === 'k' && k !== 'code') { e.preventDefault(); return linkAsk(); }
        if (k === 'code') {
          if (e.key === 'Tab') { e.preventDefault(); document.execCommand('insertText', false, '  '); }
          else if (e.key === 'Enter' && !mod) { e.preventDefault(); document.execCommand('insertText', false, '\n'); }
          else if ((e.key === 'Backspace' && atStart(host)) || (e.key === 'Delete' && atEnd(host))) e.preventDefault();
          return;
        }
        if (k === 'table') {
          const cell = cellOf(s.anchorNode);
          if (e.key === 'Tab') { e.preventDefault(); moveCell(b, e.shiftKey ? -1 : 1); return; }
          if (e.key === 'Enter') { e.preventDefault(); if (mod) tableOp(b, 'rowBelow', { ...tableSel(b), rows: [], cols: [] }); return; } // a table cell is one line; ⌘↩ adds a row
          if (cell && ((e.key === 'Backspace' && atStart(cell)) || (e.key === 'Delete' && atEnd(cell)))) e.preventDefault(); // never merge cells
          return;
        }
        if (e.key === 'Enter' && !mod && e.shiftKey && k === 'p') { e.preventDefault(); document.execCommand('insertLineBreak'); return; }
        if (e.key === 'Enter' && !mod && (k === 'p' || k === 'h')) { e.preventDefault(); splitAtCaret(b); return; }
        if (e.key === 'Enter' && !mod && !e.shiftKey && (k === 'list' || k === 'quote')) {
          const at = s.anchorNode && (s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement), item = at && at.closest(k === 'list' ? 'li' : 'p, div');
          if (item && b.contains(item) && item !== b && !item.textContent.trim()) {
            e.preventDefault();
            if (item.parentElement === b && item === b.lastElementChild) { item.remove(); caretTo(newParaAfter(b), false); } // Enter on an empty last line ends the list / quote
            return; // an empty line in the middle: the browser would split the block in two outside our reach
          }
          return;
        }
        if (e.key === 'Backspace' && !mod && atStart(textHost(b))) {
          e.preventDefault();
          if ((k === 'p' || k === 'h') && !host.textContent.trim() && !host.querySelector('img')) return removeBlock(b, true);
          if (k === 'h') { const x = convert(b, 'P'); if (x) caretTo(x, false); return; }
          if (k === 'p') { const prev = neighbour(b, -1); if (prev) joinBlocks(prev, b); }
          return;
        }
        if (e.key === 'Delete' && !mod && atEnd(textHost(b))) {
          e.preventDefault();
          if (TEXTISH.includes(k)) { const next = neighbour(b, 1); if (next) joinBlocks(b, next); }
        }
      });
      doc.addEventListener('change', (e) => { if (ok() && e.target.type === 'checkbox') { const b = blockOf(e.target); if (b) { dirty.add(b); commit(b); } } });
      return { enable, reset, commitAll, colourPicker };
    })();

    // ---------- Write mode for JSON and SQL ----------
    // The same page as Read, changed in place. JSON: click a value or a key to change it; a table (an array of objects)
    // takes the same actions as a markdown table -- insert, duplicate, move, drag, sort and delete rows and columns,
    // rename a column from its header, colours and number bars. SQL: the query text itself is editable and is
    // re-coloured when you pause; a query's title (the comment above it) is editable too, and a query can be added,
    // duplicated, moved or deleted. Every change is a splice of the source that core/json.js / core/sql.js work out, so
    // the rest of the file keeps its own layout, and ⌘Z undoes it.
    const WD = (() => {
      const kind = () => docKind();
      const on = () => S.mode === 'write' && (kind() === 'json' || kind() === 'sql') && root.classList.contains('writing-data');
      const hist = [], redo = [];
      let ed = null, busy = 0, cur = null, sqlTimer = 0, jsel = null, dg = null, built = '';
      const bar = h('div', { class: 'wbar wdbar', role: 'toolbar', 'aria-label': 'Write' });
      const menu = h('div', { class: 'wmenu wdmenu', role: 'menu', hidden: '' });
      const dropLine = h('div', { class: 'wdrop', hidden: '' });
      root.append(bar, menu, dropLine);
      const q = (sel, el) => [...(el || doc).querySelectorAll(sel)];
      const vis = (els) => els.find((x) => x.getClientRects().length) || els[0] || null;
      const E = (v) => CSS.escape(String(v));
      const wrapOf = (jp) => doc.querySelector(`.table-wrap[data-jp="${E(jp)}"]`);
      const colsOf = (w) => { try { return JSON.parse(w.dataset.cols || '[]'); } catch { return []; } };

      // ---- where things are: a small description of an element that can be found again after a re-render ----
      function find(d) {
        if (!d) return null;
        if (d.wk === 'v' || d.wk === 'k') return vis(q(`[data-wk="${d.wk}"][data-p="${E(d.p)}"]`));
        if (d.wk === 'row') return vis(q(`.jl[data-p="${E(d.p)}"], summary[data-p="${E(d.p)}"], .jroot[data-p="${E(d.p)}"]`));
        if (d.wk === 'sql') return doc.querySelector(`.sqlb[data-st="${d.st}"] pre > code`);
        if (d.wk === 'stmt') return doc.querySelector(`.sqlb[data-st="${d.st}"]`);
        const w = d.jp !== undefined ? wrapOf(d.jp) : null; if (!w) return null;
        if (d.wk === 'cell') return w.querySelector(`tbody tr[data-i="${d.i}"] td[data-col="${E(d.col)}"]`);
        if (d.wk === 'th') return w.querySelector(`thead th[data-col="${E(d.col)}"]`);
        if (d.wk === 'tr') return w.querySelector(`tbody tr[data-i="${d.i}"]`);
        return w; // 'table'
      }
      function describe(el) {
        if (!el || el.nodeType !== 1) return null;
        const wk = el.dataset.wk;
        if (wk === 'v' || wk === 'k') return { wk, p: el.dataset.p };
        const w = el.closest('.table-wrap[data-jp]');
        if (w) {
          const c = el.closest('td[data-col], th[data-col]');
          if (c) return c.tagName === 'TH' ? { wk: 'th', jp: w.dataset.jp, col: c.dataset.col } : { wk: 'cell', jp: w.dataset.jp, i: +c.parentElement.dataset.i, col: c.dataset.col };
          const tr = el.closest('tr[data-i]'); if (tr) return { wk: 'tr', jp: w.dataset.jp, i: +tr.dataset.i };
          return { wk: 'table', jp: w.dataset.jp };
        }
        if (kind() === 'sql') { // a query: its code block, or anything in its section (title, summary rows)
          const sb = el.closest('.sqlb[data-st]'); if (sb) return { wk: 'sql', st: +sb.dataset.st };
          const st = el.closest('.sqlst, .sec'); const b = st && st.querySelector('.sqlb[data-st]'); if (b) return { wk: 'sql', st: +b.dataset.st };
          return null;
        }
        const r = el.closest('.jl[data-p], summary[data-p], .jroot[data-p]'); if (r) return { wk: 'row', p: r.dataset.p };
        return null;
      }
      const textNodesOf = (el) => { const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement.closest('button') ? 2 : 1) }); const o = []; while (w.nextNode()) o.push(w.currentNode); return o; };
      function caretOffset(el) {
        const s = getSelection(); if (!s.rangeCount || !el.contains(s.anchorNode)) return null;
        const r = document.createRange(); r.setStart(el, 0); r.setEnd(s.anchorNode, s.anchorOffset); return r.toString().length;
      }
      function placeAt(el, how) {
        const ns = textNodesOf(el), s = getSelection(), r = document.createRange();
        if (!ns.length) { r.selectNodeContents(el); r.collapse(false); }
        else if (how === 'all') { r.setStart(ns[0], 0); const l = ns[ns.length - 1]; r.setEnd(l, l.length); }
        else if (typeof how === 'number') {
          let left = how, done = false;
          for (const n of ns) { if (left <= n.length) { r.setStart(n, left); done = true; break; } left -= n.length; }
          if (!done) { const l = ns[ns.length - 1]; r.setStart(l, l.length); }
          r.collapse(true);
        } else { const l = ns[ns.length - 1]; r.setStart(l, l.length); r.collapse(true); }
        s.removeAllRanges(); s.addRange(r);
      }
      // put the cursor on d: opens the folds above it, keeps it in view
      function focusTo(d, how) {
        let el = typeof d === 'function' ? d() : find(d); if (!el) return false;
        for (let p = el.closest('details'); p; p = p.parentElement && p.parentElement.closest('details')) p.open = true;
        if (!el.classList.contains('wed')) { const inner = el.querySelector('.wed'); if (!inner) { el.scrollIntoView({ block: 'nearest' }); cur = describe(el); syncBar(); return true; } el = inner; }
        el.focus({ preventScroll: true }); placeAt(el, how);
        const br = el.getBoundingClientRect(), cr = content.getBoundingClientRect();
        if (br.bottom > cr.bottom - 90 || br.top < cr.top) content.scrollTop += br.top - cr.top - content.clientHeight / 3;
        return true;
      }

      // ---- text changes: one undo step each; the page is re-rendered and the anchor kept where it was on screen ----
      const foldState = () => new Map(q('details').map((d) => [d.dataset.p ? 'p' + d.dataset.p : d.dataset.raw ? 'r' + d.dataset.raw : null, d.open]).filter((x) => x[0]));
      const refold = (m) => q('details').forEach((d) => { const k = d.dataset.p ? 'p' + d.dataset.p : d.dataset.raw ? 'r' + d.dataset.raw : null; if (k && m.has(k)) d.open = m.get(k); });
      function show(next, anchor, focus, how) {
        const t = curTab(), folds = foldState();
        busy++;
        try { setText(next); if (t) t.text = next; keepInPlace(() => find(anchor), () => { paint(); refold(folds); }); } finally { busy--; }
        notifyTabs();
        if (focus) focusTo(focus, how === undefined ? 'all' : how);
      }
      function mutate(next, anchor, focus, how) {
        if (next === S.text) return false;
        hist.push({ before: S.text, after: next }); if (hist.length > 80) hist.shift(); redo.length = 0;
        show(next, anchor, focus, how);
        return true;
      }
      function undo(again) {
        if (ed) { if (readOf(ed) !== ed.shown) finish('blur'); else { restore(ed); ed = null; } }
        const from = again ? redo : hist, top = from[from.length - 1];
        if (!top || S.text !== (again ? top.before : top.after)) { if (from.length) from.length = 0; flash(again ? 'Nothing to redo' : 'Nothing to undo'); return false; }
        from.pop(); (again ? hist : redo).push(top);
        const y = content.scrollTop; show(again ? top.after : top.before, null, null); content.scrollTop = y;
        flash(again ? 'Redone' : 'Undone');
        return true;
      }

      // ---- one field being edited ----
      function readOf(e) {
        if (e.wk === 'cell' || e.wk === 'th') return cellText(e.el);
        if (e.wk === 'title' || e.wk === 'k') return e.el.textContent.replace(/\n/g, ' ');
        return e.el.textContent;
      }
      function restore(e) { if (e.el.isConnected) e.el.replaceChildren(...e.orig); }
      function begin(el) {
        const wk = el.dataset.wk;
        const e = { el, wk, d: describe(el), orig: [...el.childNodes].map((n) => n.cloneNode(true)) };
        if (wk === 'v') {
          e.p = el.dataset.p; e.t = el.dataset.t;
          const lit = JV.literalAt(S.text, e.p); if (lit === null) return;
          const raw = e.t === 'string' ? JSON.parse(lit) : lit;
          if (el.textContent !== raw) { const at = caretOffset(el); el.textContent = raw; placeAt(el, at === null ? 'end' : Math.max(0, at - (e.t === 'string' ? 1 : 0))); }
          e.shown = raw;
        } else if (wk === 'k') {
          e.p = el.dataset.p; let raw; try { raw = JSON.parse(el.textContent); } catch { raw = el.textContent; }
          if (el.textContent !== raw) { const at = caretOffset(el); el.textContent = raw; placeAt(el, at === null ? 'end' : Math.max(0, at - 1)); }
          e.shown = raw;
        } else if (wk === 'cell' || wk === 'th') {
          const w = el.closest('.table-wrap[data-jp]'); e.jp = w.dataset.jp; e.cols = colsOf(w); e.col = el.dataset.col;
          if (wk === 'cell') e.i = +el.parentElement.dataset.i;
          e.shown = cellText(el);
        } else if (wk === 'sql') {
          const b = el.closest('.sqlb'); e.s = +b.dataset.s; e.st = +b.dataset.st; e.shown = el.textContent;
        } else if (wk === 'title') { const sc = el.closest('.sqlst, .sec'), b = sc && sc.querySelector('.sqlb[data-st]'); e.l0 = +el.closest('h2').dataset.l0; e.st = b ? +b.dataset.st : 0; e.shown = el.textContent; }
        ed = e; cur = e.d; syncBar();
      }
      function retitle(l0, t) {
        const lines = S.text.split('\n'), m = /^(\s*(?:--+|#+|\/\*+)\s*)(.*?)(\s*\*+\/\s*)?$/.exec(lines[l0] || '');
        if (!m) throw new Error('Could not find this title in the file');
        lines[l0] = m[1] + t.trim() + (m[3] || ''); return lines.join('\n');
      }
      // finish the field: 'cancel' puts it back, anything else writes it. `next` (a description, or a function of the
      // edit's result giving one) is where the cursor goes afterwards.
      function finish(how, next, nextHow) {
        const e = ed; if (!e) return false;
        ed = null; clearTimeout(sqlTimer);
        const now = readOf(e), go = (r) => (typeof next === 'function' ? next(r) : next);
        if (how === 'cancel' || now === e.shown) { restore(e); if (next) focusTo(go(null), nextHow); return false; }
        let r = null;
        try {
          if (e.wk === 'v') r = JV.edit(S.text, 'set', { pk: e.p, raw: now, was: e.t });
          else if (e.wk === 'k') r = JV.edit(S.text, 'rename', { pk: e.p, key: now });
          else if (e.wk === 'cell') r = JV.edit(S.text, 'cell', { pk: e.jp, i: e.i, col: e.col, raw: now, cols: e.cols });
          else if (e.wk === 'th') r = JV.edit(S.text, 'colRename', { pk: e.jp, from: e.col, to: now.trim() });
          else if (e.wk === 'sql') r = { text: S.text.slice(0, e.s) + now + S.text.slice(e.s + e.shown.length) };
          else if (e.wk === 'title') { if (!now.trim()) throw new Error('A title needs some words -- or delete the comment in Edit mode'); r = { text: retitle(e.l0, now) }; }
        } catch (err) { restore(e); flash(err.message, 3200); return false; }
        if (!r || r.text === S.text) { restore(e); if (next) focusTo(go(null), nextHow); return false; }
        const anchor = e.wk === 'k' && r.focus ? { wk: 'row', p: r.focus } : e.wk === 'th' ? { wk: 'table', jp: e.jp } : e.wk === 'sql' || e.wk === 'title' ? { wk: 'stmt', st: e.st === undefined ? 0 : e.st } : e.d;
        mutate(r.text, anchor, next ? go(r) : null, nextHow);
        if (e.wk === 'v' && e.t !== 'string' && r.text && /^"/.test(JV.literalAt(S.text, e.p) || '')) flash('Saved as text -- right-click › Type to change it back', 2600);
        return true;
      }
      const commitAll = () => { if (ed) finish('blur'); };

      // ---- turning it on for a freshly painted page ----
      function enable(r) {
        const k = kind(), act = S.mode === 'write' && (k === 'json' || k === 'sql') && !(k === 'json' && r && r.json && r.json.error);
        root.classList.toggle('writing-data', act);
        ed = null; jsel = null; hideMenu();
        if (!act) { if (S.mode === 'write' && k === 'json' && r && r.json && r.json.error) flash('This JSON has an error -- fix it in Edit mode (⌘2) to write on the page', 3500); return; }
        const mk = (el, wk, tip) => { el.contentEditable = 'plaintext-only'; el.classList.add('wed'); el.dataset.wk = wk; el.spellcheck = false; if (tip && !el.title) el.title = tip; };
        if (k === 'json') {
          q('.jv[data-p]').forEach((el) => mk(el, 'v'));
          q('.jk[data-p]').forEach((el) => mk(el, 'k'));
          q('.table-wrap[data-jp] > table').forEach((t) => {
            t.querySelectorAll('thead th[data-col]').forEach((th) => {
              mk(th, 'th', 'Type to rename this column in every row');
              th.querySelectorAll('button').forEach((b) => { b.contentEditable = 'false'; });
              const g = h('button', { type: 'button', class: 'jcg', contenteditable: 'false', tabindex: '-1', title: 'Drag to move this column · click to select it', 'aria-label': 'Move or select column' }); // the glyph is CSS, so the header's text stays the column name
              if (th.firstChild) th.firstChild.after(g); else th.append(g); // after the name: the header still starts with it
            });
            t.querySelectorAll('tbody td[data-col]:not(.jarr)').forEach((td) => mk(td, 'cell'));
            t.querySelectorAll('tbody td.jarr').forEach((td) => { td.title = 'A list: change it in "as tree" under the table, or in Edit mode'; });
            t.querySelectorAll('tbody td.jidxcol').forEach((td) => { td.classList.add('jrowh'); td.title = 'Click to select this row (⇧-click for more) · drag to move it'; });
          });
        } else {
          q('.sqlb[data-st] pre > code').forEach((el) => mk(el, 'sql'));
          q('h2[data-l0]:not([data-gen]) > .t').forEach((el) => mk(el, 'title', 'The comment above the query -- type to rename it'));
        }
        buildBar(k); syncBar();
      }

      // ---- the toolbar ----
      const BTN = {
        json: [['add', '+ Add', 'Add a key / item below this one (in a table: a row)'], ['dup', 'Duplicate', 'Duplicate this key, item or row'], ['up', '↑', 'Move up'], ['down', '↓', 'Move down'],
          ['del', 'Delete', 'Delete this key, item or row (selected rows: all of them)'], ['more', 'More ▾', 'Type, columns, colours ... (or right-click)']],
        sql: [['add', '+ Query', 'A new query below this one'], ['dup', 'Duplicate', 'Duplicate this query'], ['up', '↑', 'Move this query up'], ['down', '↓', 'Move this query down'],
          ['del', 'Delete', 'Delete this query'], ['fmt', 'Format', 'Re-indent the whole file (whitespace only)']],
      };
      function buildBar(k) {
        if (built === k) return; built = k;
        bar.replaceChildren(h('span', { class: 'wtag' }, k === 'json' ? 'Writing JSON' : 'Writing SQL'),
          ...BTN[k].map(([a, label, tip]) => h('button', { type: 'button', 'data-act': a, title: tip, onmousedown: (e) => e.preventDefault(), onclick: (e) => act(a, e) }, label)),
          h('span', { class: 'whelp', title: 'Changes go into the file text straight away; ⌘S saves; ⌘Z undoes' }, k === 'json' ? 'Click a value to change it · right-click for more' : 'Type in a query · right-click for more'));
      }
      function syncBar() {
        if (!built) return;
        const has = !!cur && (kind() === 'sql' ? cur.wk === 'sql' : cur.wk !== 'table');
        bar.querySelectorAll('button[data-act]').forEach((b) => { b.disabled = b.dataset.act !== 'fmt' && !has; });
      }
      function act(a, e) {
        if (a === 'fmt') { commitAll(); return formatDoc(false); }
        const d = cur; if (!d) return flash('Click into the page first');
        if (kind() === 'sql') return sqlAct(a, d.st);
        if (a === 'more') { const r = e.currentTarget.getBoundingClientRect(); return openMenuFor(find(d) || doc, r.left, r.top, true); }
        if (d.wk === 'cell' || d.wk === 'th' || d.wk === 'tr') {
          const w = find({ wk: 'table', jp: d.jp }); if (!w) return;
          const rows = jsel && jsel.jp === d.jp && jsel.kind === 'row' ? jsel.rows : d.i !== undefined ? [d.i] : [];
          if (!rows.length) return flash('Click a cell in a row first');
          const op = { add: 'rowBelow', dup: 'rowDup', up: 'rowUp', down: 'rowDown', del: 'rowDel' }[a];
          return rowOp(w, op, rows, d.col);
        }
        const p = d.p; if (!p) return;
        treeAct({ add: 'add', dup: 'dup', up: 'up', down: 'down', del: 'del' }[a], p);
      }

      // ---- JSON tree actions ----
      function treeAct(op, p, arg) {
        commitAll();
        let r;
        try {
          if (op === 'add' || op === 'above') r = JV.edit(S.text, 'add', { pk: p, before: op === 'above' });
          else if (op === 'inside') r = JV.edit(S.text, 'addInside', { pk: p });
          else if (op === 'dup') r = JV.edit(S.text, 'dup', { pk: p });
          else if (op === 'up' || op === 'down') r = JV.edit(S.text, 'move', { pk: p, dir: op === 'up' ? -1 : 1 });
          else if (op === 'del') r = JV.edit(S.text, 'del', { pks: [p] });
          else if (op === 'type') r = JV.edit(S.text, 'type', { pk: p, to: arg });
        } catch (err) { return flash(err.message, 3000); }
        if (!r) return;
        const f = r.focus;
        const focus = f ? () => find({ wk: r.role === 'k' ? 'k' : 'v', p: f }) || find({ wk: 'row', p: f }) : null;
        mutate(r.text, f ? { wk: 'row', p: f } : { wk: 'row', p: parentOf(p) }, focus, op === 'up' || op === 'down' || op === 'type' ? 'end' : 'all');
        if (op === 'del') flash('Deleted -- ⌘Z brings it back');
      }
      const parentOf = (p) => { if (p.startsWith('doc#')) return p; const a = JSON.parse(p); return a.length === 2 ? a[0] : JV.pathKey(a.slice(0, -1)); };

      // ---- JSON table actions ----
      function tableAct(jp, op, args, focus, how) {
        commitAll();
        const w = wrapOf(jp); if (!w) return null;
        let r; try { r = JV.edit(S.text, op, { pk: jp, cols: colsOf(w), ...args }); } catch (err) { flash(err.message, 3000); return null; }
        if (!r) return null;
        clearSel();
        mutate(r.text, { wk: 'table', jp }, focus ? focus(r) : null, how);
        return r;
      }
      function rowOp(w, op, rows, col) {
        const jp = w.dataset.jp, cols = colsOf(w), lo = Math.min(...rows), hi = Math.max(...rows), c0 = col || cols[0];
        if (op === 'rowAbove') return tableAct(jp, 'rowAdd', { at: lo, like: lo }, () => ({ wk: 'cell', jp, i: lo, col: c0 }));
        if (op === 'rowBelow') return tableAct(jp, 'rowAdd', { at: hi + 1, like: hi }, () => ({ wk: 'cell', jp, i: hi + 1, col: c0 }));
        if (op === 'rowDup') return tableAct(jp, 'rowDup', { rows }, () => ({ wk: 'cell', jp, i: hi + 1, col: c0 }), 'end');
        if (op === 'rowUp') { if (lo === 0) return flash('Already the top row'); return tableAct(jp, 'rowMove', { from: lo, to: lo - 1 }, () => ({ wk: 'cell', jp, i: lo - 1, col: c0 }), 'end'); }
        if (op === 'rowDown') { const n = w.querySelectorAll('tbody tr[data-i]').length; if (hi >= n - 1) return flash('Already the last row'); return tableAct(jp, 'rowMove', { from: hi, to: hi + 2 }, () => ({ wk: 'cell', jp, i: hi + 1, col: c0 }), 'end'); }
        if (op === 'rowDel') { const r = tableAct(jp, 'rowDel', { rows }); if (r) flash(rows.length > 1 ? `Deleted ${rows.length} rows -- ⌘Z brings them back` : 'Row deleted -- ⌘Z brings it back'); return r; }
        return null;
      }
      function colOp(w, op, names) {
        const jp = w.dataset.jp, cols = colsOf(w), idx = names.map((n) => cols.indexOf(n)).filter((i) => i >= 0), lo = Math.min(...idx), hi = Math.max(...idx);
        if (op === 'colLeft' || op === 'colRight') return tableAct(jp, 'colAdd', { at: op === 'colLeft' ? lo : hi + 1 }, (r) => ({ wk: 'th', jp, col: r.focus.col }));
        if (op === 'moveLeft') { if (lo === 0) return flash('Already the first column'); return tableAct(jp, 'colMove', { from: lo, to: lo - 1 }); }
        if (op === 'moveRight') { if (hi >= cols.length - 1) return flash('Already the last column'); return tableAct(jp, 'colMove', { from: hi, to: hi + 2 }); }
        if (op === 'sortAsc' || op === 'sortDesc') { const r = tableAct(jp, 'sort', { col: cols[lo], dir: op === 'sortAsc' ? 1 : -1 }); if (r) flash(`Sorted by "${cols[lo]}"`); else flash('Already in that order'); return r; }
        if (op === 'delCols') { const r = tableAct(jp, 'colDel', { names }); if (r) flash(names.length > 1 ? `Deleted ${names.length} columns` : 'Column deleted -- ⌘Z brings it back'); return r; }
        return null;
      }
      // colours for a JSON table are kept on this Mac: a JSON file cannot carry them without breaking programs that read it
      function jColour(w, sel, scope, val, ink) {
        const jp = w.dataset.jp;
        if (!jcSave(jp, jcData(jp))) return flash('Save this file first -- colours are kept per file', 3000);
        const d = jcData(jp), bag = ink ? d.text : d, rows = [...w.querySelectorAll('thead > tr:not(.filters), tbody > tr')];
        const hs = rows[0] ? [...rows[0].children].map(cellText) : [], label = (i) => cellText(rows[i] && rows[i].children[1]);
        const cells = sel.cells.length ? sel.cells : [[sel.r, sel.c]];
        let ts;
        if (scope === 'col') ts = [...new Set(cells.map((p) => p[1]).filter((c) => c > 0))].map((c) => ['cols', hs[c]]);
        else if (scope === 'row') ts = [...new Set(cells.map((p) => p[0]).filter((i) => i > 0))].map((i) => ['rows', label(i)]);
        else ts = cells.filter((p) => p[1] > 0).map(([i, c]) => (i === 0 ? ['cols', hs[c]] : ['cells', label(i) + '|' + hs[c]]));
        if (!ts.length) return flash('Pick a cell, row or column of the table');
        for (const [b, key] of ts) { if (val) bag[b][key] = val; else delete bag[b][key]; }
        jcSave(jp, d); applyColColours();
        if (!localStorage.getItem('mdr-jcolour-told')) { localStorage.setItem('mdr-jcolour-told', '1'); flash('Colours for JSON tables are saved on this Mac, not in the file (a JSON file cannot hold them without breaking programs that read it)', 5000); }
      }
      function jBars(w, names) {
        const jp = w.dataset.jp, ths = names.map((n) => w.querySelector(`thead th[data-col="${E(n)}"]`)).filter(Boolean);
        const ok = ths.filter((th) => th.classList.contains('barv')).map((th) => th.dataset.col);
        if (!ok.length) return flash('Number bars are for columns of amounts -- this one looks like IDs, codes or row numbers');
        const d = jcData(jp), onNow = ok.every((k) => d.bars.includes(k));
        d.bars = onNow ? d.bars.filter((k) => !ok.includes(k)) : [...d.bars, ...ok];
        if (!jcSave(jp, d)) return flash('Save this file first -- colours are kept per file', 3000);
        applyColColours();
      }

      // ---- whole-row / whole-column selection (click the # cell or a column's grip) ----
      function clearSel() { jsel = null; q('.wsel').forEach((x) => x.classList.remove('wsel')); }
      function paintSel() {
        q('.wsel').forEach((x) => x.classList.remove('wsel'));
        const w = jsel && wrapOf(jsel.jp); if (!w) return;
        if (jsel.kind === 'row') jsel.rows.forEach((i) => w.querySelectorAll(`tbody tr[data-i="${i}"] > *`).forEach((x) => x.classList.add('wsel')));
        else jsel.cols.forEach((c) => w.querySelectorAll(`[data-col="${E(c)}"]`).forEach((x) => x.classList.add('wsel')));
      }
      function pickSel(g) {
        if (ed) finish('blur');
        const jp = g.jp;
        if (g.row !== null) {
          if (g.shift && jsel && jsel.jp === jp && jsel.kind === 'row') { const a = Math.min(jsel.anchor, g.row), b = Math.max(jsel.anchor, g.row); jsel.rows = [...Array(b - a + 1).keys()].map((x) => x + a); }
          else jsel = { jp, kind: 'row', rows: [g.row], anchor: g.row };
          cur = { wk: 'tr', jp, i: g.row };
        } else {
          if (g.shift && jsel && jsel.jp === jp && jsel.kind === 'col') { if (!jsel.cols.includes(g.col)) jsel.cols.push(g.col); }
          else jsel = { jp, kind: 'col', cols: [g.col] };
          cur = { wk: 'th', jp, col: g.col };
        }
        paintSel(); syncBar();
        flash(jsel.kind === 'row' ? `${jsel.rows.length > 1 ? jsel.rows.length + ' rows' : 'Row'} selected -- Delete removes, right-click for more` : `${jsel.cols.length > 1 ? jsel.cols.length + ' columns' : 'Column'} selected -- Delete removes, right-click for more`, 2200);
      }

      // ---- menus ----
      function hideMenu() { menu.hidden = true; menu.replaceChildren(); }
      function place(x, y, above) {
        menu.hidden = false;
        const mw = menu.offsetWidth, mh = menu.offsetHeight;
        menu.style.left = Math.max(8, Math.min(x, innerWidth - mw - 8)) + 'px';
        menu.style.top = Math.max(8, Math.min(above ? y - mh - 8 : y, innerHeight - mh - 8)) + 'px';
      }
      const it = (label, fn, dis, danger, key) => h('button', { type: 'button', role: 'menuitem', class: danger ? 'danger' : '', disabled: dis ? '' : null,
        onmousedown: (e) => e.preventDefault(), onclick: () => { hideMenu(); fn(); } }, h('span', {}, label), key ? h('kbd', {}, key) : null);
      const grp = (n) => h('div', { class: 'wmh' }, n);
      function openMenuFor(t, x, y, above) {
        if (!t || !t.closest) return;
        if (kind() === 'sql') { const d = describe(t); if (d && d.st !== undefined) sqlMenu(d.st, x, y, above); return; }
        const w = t.closest('.table-wrap[data-jp]'); if (w) return tableMenu(w, t, x, y, above);
        const r = t.closest('.jl[data-p], summary[data-p], .jroot[data-p]'); if (r) return treeMenu(r, x, y, above);
      }
      function tableMenu(w, t, x, y, above) {
        const jp = w.dataset.jp, cols = colsOf(w), td = t.closest('td, th'), tr = t.closest('tr[data-i]');
        const s = jsel && jsel.jp === jp ? jsel : null;
        let rows, names, whole = null;
        if (s && s.kind === 'row' && (!tr || s.rows.includes(+tr.dataset.i))) { rows = s.rows; names = td && td.dataset.col ? [td.dataset.col] : [cols[0]]; whole = 'row'; }
        else if (s && s.kind === 'col' && (!td || s.cols.includes(td.dataset.col))) { names = s.cols; rows = []; whole = 'col'; }
        else { rows = tr ? [+tr.dataset.i] : []; names = td && td.dataset.col !== undefined ? [td.dataset.col] : [cols[0]]; }
        const ci = names.map((n) => cols.indexOf(n)), nRows = w.querySelectorAll('tbody tr[data-i]').length, all = [...w.querySelectorAll('tbody tr[data-i]')].map((r) => +r.dataset.i);
        const cells = whole === 'row' ? rows.flatMap((i) => cols.map((_, c) => [i + 1, c + 1])) : whole === 'col' ? [0, ...all.map((i) => i + 1)].flatMap((i) => ci.map((c) => [i, c + 1]))
          : rows.length ? rows.flatMap((i) => ci.map((c) => [i + 1, c + 1])) : ci.map((c) => [0, c + 1]);
        const sel = { rows: whole === 'col' ? [] : rows.map((i) => i + 1), cols: ci.map((c) => c + 1), cells, r: rows.length ? rows[0] + 1 : 0, c: ci[0] + 1, whole };
        const barsOk = names.some((n) => { const th = w.querySelector(`thead th[data-col="${E(n)}"]`); return th && th.classList.contains('barv'); });
        const barsOn = barsOk && names.every((n) => jcData(jp).bars.includes(n)), nr = rows.length, nc = names.length;
        menu.replaceChildren(
          W.colourPicker(w, sel, hideMenu, (scope, val, ink) => jColour(w, sel, scope, val, ink)),
          ...(nr ? [grp(nr > 1 ? `${nr} rows` : 'Row'),
            it('Insert row above', () => rowOp(w, 'rowAbove', rows, names[0])), it('Insert row below', () => rowOp(w, 'rowBelow', rows, names[0]), false, false, '⌘↩'),
            it(nr > 1 ? `Duplicate ${nr} rows` : 'Duplicate row', () => rowOp(w, 'rowDup', rows, names[0])),
            it('Move up', () => rowOp(w, 'rowUp', rows, names[0]), Math.min(...rows) === 0), it('Move down', () => rowOp(w, 'rowDown', rows, names[0]), Math.max(...rows) >= nRows - 1),
            it(nr > 1 ? `Delete ${nr} rows` : 'Delete row', () => rowOp(w, 'rowDel', rows), false, true)] : []),
          grp(nc > 1 ? `${nc} columns` : `Column "${names[0]}"`),
          it('Insert column left', () => colOp(w, 'colLeft', names)), it('Insert column right', () => colOp(w, 'colRight', names)),
          it('Move left', () => colOp(w, 'moveLeft', names), Math.min(...ci) === 0), it('Move right', () => colOp(w, 'moveRight', names), Math.max(...ci) >= cols.length - 1),
          it('Sort by this column, A → Z', () => colOp(w, 'sortAsc', names)), it('Sort by this column, Z → A', () => colOp(w, 'sortDesc', names)),
          h('button', { type: 'button', role: 'menuitem', disabled: barsOk ? null : '', title: barsOk ? '' : 'Only for columns of amounts -- these look like IDs, codes or row numbers', onmousedown: (e) => e.preventDefault(), onclick: () => { hideMenu(); jBars(w, names); } }, h('span', {}, barsOn ? 'Hide number bars' : 'Show number bars')),
          it(nc > 1 ? `Delete ${nc} columns` : 'Delete column', () => colOp(w, 'delCols', names), false, true),
          grp('Table'),
          it(root.classList.contains('no-tcolour') ? 'Turn table colours on' : 'Turn table colours off', toggleTableColours));
        place(x, y, above);
      }
      const pathText = (p) => { if (p.startsWith('doc#')) return '$'; return '$' + JSON.parse(p).slice(1).map((k) => (typeof k === 'number' ? `[${k}]` : /^[A-Za-z_$][\w$]*$/.test(k) ? '.' + k : `[${JSON.stringify(k)}]`)).join(''); };
      function treeMenu(rowEl, x, y, above) {
        const p = rowEl.dataset.p, isRoot = p.startsWith('doc#'), isCont = rowEl.hasAttribute('data-c') || (rowEl.classList.contains('jroot') && !rowEl.querySelector(':scope > .jt > .jl > .jv'));
        const last = isRoot ? null : JSON.parse(p).slice(-1)[0], inArr = typeof last === 'number', what = inArr ? 'item' : 'key';
        const lit = isRoot ? null : JV.literalAt(S.text, p) || '';
        const now = !lit ? '' : lit[0] === '"' ? 'string' : lit[0] === '{' ? 'object' : lit[0] === '[' ? 'array' : /^(true|false|null)$/.test(lit) ? lit : 'number';
        const tb = (to, label, tip) => h('button', { type: 'button', class: 'wal' + (now === to ? ' on' : ''), title: tip, onmousedown: (e) => e.preventDefault(), onclick: () => { hideMenu(); treeAct('type', p, to); } }, label);
        const items = [];
        if (!isRoot) items.push(grp(inArr ? `Item ${last}` : `Key "${last}"`),
          it(`Add ${what} below`, () => treeAct('add', p)), it(`Add ${what} above`, () => treeAct('above', p)),
          it('Duplicate', () => treeAct('dup', p)), it('Move up', () => treeAct('up', p)), it('Move down', () => treeAct('down', p)));
        if (isCont) items.push(it(isRoot ? 'Add at the end' : 'Add inside, at the end', () => treeAct('inside', p)));
        if (!isRoot) items.push(h('div', { class: 'walign wtype' }, h('span', {}, 'Type'), tb('string', 'Text', 'Text, in quotes'), tb('number', '123', 'Number'), tb('true', 'true'), tb('false', 'false'), tb('null', 'null', 'Empty (null)'), tb('object', '{ }', 'An object (its value is replaced)'), tb('array', '[ ]', 'A list (its value is replaced)')));
        items.push(it('Copy path', () => { const t = pathText(p); (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => flash('Copied ' + t), () => flash(t, 4000)); }));
        if (!isRoot) items.push(it(`Delete ${what}`, () => treeAct('del', p), false, true));
        menu.replaceChildren(...items); place(x, y, above);
      }

      // ---- SQL ----
      function sqlAct(a, st) {
        commitAll();
        const op = { add: 'add', dup: 'dup', up: 'up', down: 'down', del: 'del' }[a]; if (!op) return;
        let r; try { r = SQLV.edit(S.text, op, st); } catch (err) { return flash(err.message, 3000); }
        const f = r.focus === null || r.focus === undefined ? null : r.focus;
        mutate(r.text, f === null ? null : { wk: 'stmt', st: f }, f === null ? null : { wk: 'sql', st: f }, op === 'add' ? 'all' : 'end');
        if (op === 'del') flash('Query deleted -- ⌘Z brings it back'); else if (op === 'add') flash('New query added -- type over it', 2200);
      }
      function sqlMenu(st, x, y, above) {
        const n = q('.sqlb[data-st]').length;
        menu.replaceChildren(grp(`Query ${st + 1}`),
          it('New query below', () => sqlAct('add', st)), it('Duplicate', () => sqlAct('dup', st)),
          it('Move up', () => sqlAct('up', st), st === 0), it('Move down', () => sqlAct('down', st), st >= n - 1),
          it('Format the file', () => { commitAll(); formatDoc(false); }),
          it('Delete query', () => sqlAct('del', st), false, true));
        place(x, y, above);
      }
      let composing = false;
      function sqlPause() {
        if (!ed || ed.wk !== 'sql' || composing) return;
        const off = caretOffset(ed.el), pos = ed.s + (off === null ? ed.el.textContent.length : off);
        if (!finish('blur')) return;
        const hit = q('.sqlb[data-st]').map((b) => [+b.dataset.s, b.querySelector('pre > code')]).filter((x) => x[0] <= pos && x[1]).pop();
        if (!hit) return;
        hit[1].focus({ preventScroll: true }); if (!ed || ed.el !== hit[1]) begin(hit[1]);
        placeAt(hit[1], pos - hit[0]);
      }
      const indentAtCaret = (el) => { const off = caretOffset(el); const before = el.textContent.slice(0, off === null ? undefined : off); return /[ \t]*$/.exec(before.slice(before.lastIndexOf('\n') + 1).match(/^[ \t]*/)[0])[0]; };

      // ---- events ----
      doc.addEventListener('focusin', (e) => {
        if (!on() || busy) return;
        const el = e.target.closest && e.target.closest('.wed'); if (!el || (ed && ed.el === el)) return;
        if (ed) { const nd = describe(el), at = caretOffset(el); finish('blur', nd, at === null ? 'end' : at); if (ed && ed.el === el) return; if (!el.isConnected) return; }
        begin(el);
      });
      doc.addEventListener('focusout', (e) => {
        if (!ed || busy || e.target !== ed.el) return;
        const e0 = ed;
        setTimeout(() => { if (ed === e0 && document.activeElement !== e0.el) finish('blur'); }, 0);
      });
      doc.addEventListener('click', (e) => { if (on() && e.target.closest('summary') && e.target.closest('.wed, .jcg')) e.preventDefault(); }, true);
      doc.addEventListener('input', () => { if (on() && ed && ed.wk === 'sql') { clearTimeout(sqlTimer); sqlTimer = setTimeout(sqlPause, 1200); } });
      doc.addEventListener('compositionstart', () => { composing = true; });
      doc.addEventListener('compositionend', () => { composing = false; });
      doc.addEventListener('beforeinput', (e) => {
        if (!on() || busy || !/^history(Undo|Redo)$/.test(e.inputType)) return;
        if (ed && ed.wk !== 'sql' && readOf(ed) !== ed.shown) return; // the field's own undo
        e.preventDefault(); undo(e.inputType === 'historyRedo');
      });
      doc.addEventListener('contextmenu', (e) => {
        if (!on()) return;
        const d = describe(e.target); if (!d) return;
        e.preventDefault();
        const x = e.clientX, y = e.clientY;
        if (ed && !(d.wk === ed.d?.wk && JSON.stringify(d) === JSON.stringify(ed.d))) commitAll();
        else if (ed) commitAll();
        openMenuFor(find(d) || doc, x, y);
      });
      doc.addEventListener('mousedown', (e) => {
        if (!on()) return;
        const d = describe(e.target); if (d) { cur = d; syncBar(); }
        if (kind() !== 'json' || e.button !== 0) return;
        const rh = e.target.closest('td.jrowh'), cg = e.target.closest('.jcg');
        if (!rh && !cg) { if (jsel) clearSel(); return; }
        e.preventDefault();
        const w = e.target.closest('.table-wrap[data-jp]');
        dg = { jp: w.dataset.jp, row: rh ? +rh.parentElement.dataset.i : null, col: cg ? cg.closest('th').dataset.col : null, x: e.clientX, y: e.clientY, moving: false, shift: e.shiftKey };
      });
      document.addEventListener('mousedown', (e) => { if (!menu.hidden && !menu.contains(e.target)) hideMenu(); }, true);
      content.addEventListener('scroll', () => { if (!menu.hidden) hideMenu(); }, { passive: true });
      function slotAt(g, ev) {
        const w = wrapOf(g.jp); if (!w) return null;
        const tb = w.querySelector('table').getBoundingClientRect();
        if (g.row !== null) {
          const trs = [...w.querySelectorAll('tbody tr[data-i]')].filter((r) => r.getClientRects().length);
          for (const r of trs) { const b = r.getBoundingClientRect(); if (ev.clientY < b.top + b.height / 2) return { slot: +r.dataset.i, x: tb.left, y: b.top - 1, w: tb.width }; }
          const l = trs[trs.length - 1]; return l ? { slot: +l.dataset.i + 1, x: tb.left, y: l.getBoundingClientRect().bottom - 1, w: tb.width } : null;
        }
        const ths = [...w.querySelectorAll('thead th[data-col]')], cols = colsOf(w);
        for (const th of ths) { const b = th.getBoundingClientRect(); if (ev.clientX < b.left + b.width / 2) return { slot: cols.indexOf(th.dataset.col), x: b.left - 1, y: tb.top, h: tb.height, v: true }; }
        const b = ths[ths.length - 1].getBoundingClientRect(); return { slot: cols.length, x: b.right - 1, y: tb.top, h: tb.height, v: true };
      }
      function endDrag() { dg = null; dropLine.hidden = true; q('.wdragging').forEach((x) => x.classList.remove('wdragging')); }
      addEventListener('mousemove', (e) => {
        if (!dg) return;
        if (!dg.moving) {
          if (Math.hypot(e.clientX - dg.x, e.clientY - dg.y) < 5) return;
          dg.moving = true; if (ed) finish('blur');
          const w = wrapOf(dg.jp); if (!w) return endDrag();
          (dg.row !== null ? w.querySelectorAll(`tbody tr[data-i="${dg.row}"] > *`) : w.querySelectorAll(`[data-col="${E(dg.col)}"]`)).forEach((x) => x.classList.add('wdragging'));
        }
        const s = slotAt(dg, e); if (!s) return;
        dropLine.hidden = false; dropLine.classList.toggle('v', !!s.v);
        Object.assign(dropLine.style, s.v ? { left: s.x + 'px', top: s.y + 'px', height: s.h + 'px', width: '' } : { left: s.x + 'px', top: s.y + 'px', width: s.w + 'px', height: '' });
      });
      addEventListener('mouseup', (e) => {
        if (!dg) return;
        const g = dg, s = g.moving ? slotAt(g, e) : null; endDrag();
        if (!g.moving) return pickSel(g);
        if (!s) return;
        if (g.row !== null) { if (tableAct(g.jp, 'rowMove', { from: g.row, to: s.slot })) flash('Row moved'); }
        else { const w = wrapOf(g.jp); if (w && tableAct(g.jp, 'colMove', { from: colsOf(w).indexOf(g.col), to: s.slot })) flash('Column moved'); }
      });
      document.addEventListener('keydown', (e) => {
        if (!on()) return;
        if (dg && e.key === 'Escape') { e.preventDefault(); endDrag(); return; }
        if (!menu.hidden && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hideMenu(); return; }
        const mod = e.metaKey || e.ctrlKey;
        const inPage = doc.contains(e.target) || e.target === document.body;
        if (!inPage) return;
        if (mod && !e.altKey && e.key.toLowerCase() === 'z') {
          if (ed && ed.wk !== 'sql' && readOf(ed) !== ed.shown) return; // the field's own undo
          e.preventDefault(); undo(e.shiftKey); return;
        }
        if (!ed) {
          if (jsel && (e.key === 'Backspace' || e.key === 'Delete')) { e.preventDefault(); const w = wrapOf(jsel.jp); if (w) { if (jsel.kind === 'row') rowOp(w, 'rowDel', jsel.rows); else colOp(w, 'delCols', jsel.cols); } }
          else if (jsel && e.key === 'Escape') { e.preventDefault(); clearSel(); }
          return;
        }
        const wk = ed.wk, el = ed.el, d = ed.d;
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(wk === 'sql' || wk === 'title' ? 'blur' : 'cancel'); if (document.activeElement && doc.contains(document.activeElement)) document.activeElement.blur(); return; }
        if (wk === 'sql') {
          if (e.key === 'Tab') { e.preventDefault(); document.execCommand('insertText', false, '    '); }
          else if (e.key === 'Enter' && !mod) { e.preventDefault(); document.execCommand('insertText', false, '\n' + indentAtCaret(el)); }
          return;
        }
        if (e.key === 'Tab') {
          e.preventDefault();
          const all = q('.wed').filter((x) => x.getClientRects().length), nx = all[all.indexOf(el) + (e.shiftKey ? -1 : 1)];
          const tr = el.closest('tr[data-i]'), lastCell = wk === 'cell' && tr && !tr.nextElementSibling && el === [...tr.querySelectorAll('td.wed')].pop();
          if (lastCell && !e.shiftKey) { finish('blur'); const w = wrapOf(d.jp); if (w) rowOp(w, 'rowBelow', [d.i], colsOf(w)[0]); return; }
          finish('blur', nx ? describe(nx) : null, 'all'); return;
        }
        if (e.key === 'Enter') {
          if (wk === 'v' && e.shiftKey && ed.t === 'string') return; // a line break inside the text
          e.preventDefault();
          if (wk === 'cell' && mod) { finish('blur'); const w = wrapOf(d.jp); if (w) rowOp(w, 'rowBelow', [d.i], d.col); return; }
          if (wk === 'k') { const p = ed.p; finish('blur', (r) => ({ wk: 'v', p: r && r.focus ? r.focus : p }), 'all'); return; }
          if (wk === 'cell') { finish('blur', { wk: 'cell', jp: d.jp, i: d.i + 1, col: d.col }, 'all'); return; }
          if (wk === 'th') { finish('blur', (r) => ({ wk: 'cell', jp: d.jp, i: 0, col: r && r.focus ? r.focus.col : d.col }), 'all'); return; }
          finish('blur'); if (document.activeElement && doc.contains(document.activeElement)) document.activeElement.blur();
        }
      });
      return { enable, commitAll, undo };
    })();

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
    // A .sql file (or an untitled SQL paste) renders through core/sql.js: one block per statement, titled by the
    // comment above it, with a plain-words summary and role-coloured code.
    const IS_JSON = (p) => /\.json$/i.test((p || '').split(/[?#]/)[0]);
    const IS_SQL = (p) => /\.(sql|hql|psql)$/i.test((p || '').split(/[?#]/)[0]);
    // A .mmd / .mermaid file (or an untitled paste that starts with a diagram word) is one drawn diagram: core/diagram.js.
    const IS_MMD = (p) => /\.(mmd|mermaid)$/i.test((p || '').split(/[?#]/)[0]);
    const docKind = () => {
      const t = curTab(); if (!t) return 'md';
      if (isUntitled(t)) return global.JV && JV.looksLikeJson(S.text) ? 'json' : global.DG && DG.looksLike(S.text) ? 'mmd' : global.SQLV && SQLV.looksLikeSql(S.text) ? 'sql' : 'md';
      return IS_JSON(curDisp().name) ? 'json' : IS_SQL(curDisp().name) && global.SQLV ? 'sql' : IS_MMD(curDisp().name) && global.DG ? 'mmd' : 'md';
    };
    function formatDoc(minify) {
      const kind = docKind();
      if (kind === 'sql' && global.SQLV) {
        // whitespace-only re-indent; refuse (loudly) if the token stream would change, so Format can never alter a query
        const next = SQLV.format(S.text);
        if (!SQLV.sameTokens(S.text, next)) return flash('Cannot format: result would change the query', 4000);
        if (next === S.text) return flash('Already formatted');
        setText(next); const t = curTab(); if (t) t.text = next; paint(); flash('Re-indented'); return;
      }
      if (kind !== 'json' || !global.JV) return flash('Not a JSON or SQL document');
      try {
        const next = minify ? JV.minify(S.text) : JV.format(S.text);
        if (next === S.text) return flash(minify ? 'Already minified' : 'Already formatted');
        setText(next); const t = curTab(); if (t) t.text = next; paint(); flash(minify ? 'Minified' : 'Formatted');
      } catch (e) { flash('Cannot format: ' + (e && e.message || e), 4000); }
    }
    function paint() {
      W.reset(); // the blocks are about to be rebuilt; callers commit pending Write edits first
      const kind = docKind();
      root.dataset.kind = kind;
      fmtBtn.title = kind === 'sql' ? 'Re-indent SQL (⌘⇧F) -- whitespace only, the query is unchanged' : 'Format JSON (⌘⇧F) · ⌥-click to minify';
      $('.gutter span', editor).textContent = kind;
      const r = kind === 'json' ? JV.renderDoc(S.text, { name: curDisp().name }) : kind === 'sql' ? SQLV.renderDoc(S.text, { name: curDisp().name }) : kind === 'mmd' ? DG.renderDoc(S.text, { name: curDisp().name }) : MD.renderDoc(S.text, { base: docBase(), home: adapter.home });
      head.replaceChildren(...r.headEl.childNodes);
      // chips (sections theme shows them; others hide via CSS)
      head.append(h('nav', { class: 'chips' }, ...r.sectionEls.map((s) => h('a', { href: '#' + s.id, onclick: (e) => { e.preventDefault(); scrollTo(s.id); }, html: (s.el.querySelector('h2 .t') || {}).innerHTML || MD.esc(s.title) }))));
      const copyLabel = { json: 'Copy JSON', sql: 'Copy SQL' }[kind] || 'Copy';
      const copySec = (i) => (kind === 'json' ? copyJsonSection(i) : kind === 'sql' ? copySqlSection(i) : copySection(i));
      secs.replaceChildren(...r.sectionEls.map((s) => h('section', { class: 'sec', 'data-i': s.index, id: 'sec-' + s.index },
        h('div', { class: 'tools' },
          kind !== 'md' ? null : h('button', { 'data-act': 'edit', onclick: () => editSection(s.index) }, 'Edit section'),
          h('button', { 'data-act': 'copy', onclick: () => copySec(s.index) }, copyLabel)),
        h('div', { class: 'body' }, ...s.el.childNodes))));
      if (kind === 'json' && MD.decorateTables) MD.decorateTables(doc); // status chips and number-bar lengths, as for markdown tables
      toc.replaceChildren(...r.toc.filter((t) => t.lvl <= 3).map((t) => h('a', { class: 'l' + t.lvl, href: '#' + t.id, onclick: (e) => { e.preventDefault(); scrollTo(t.id); } }, t.text.replace(/^\d+[.)]\s*/, ''))));
      if (kind === 'sql') {
        const lg = head.querySelector('.sqllegend');
        if (lg) {
          if (localStorage.getItem('mdr-sql-legend') === 'off') lg.classList.add('off');
          lg.querySelector('.lgx').addEventListener('click', (e) => { e.stopPropagation(); lg.classList.add('off'); localStorage.setItem('mdr-sql-legend', 'off'); flash('Legend hidden -- click the row of colour dots above the first query to bring it back', 3500); });
          lg.addEventListener('click', (e) => { if (lg.classList.contains('off')) { lg.classList.remove('off'); localStorage.removeItem('mdr-sql-legend'); } });
        }
      }
      if (kind === 'json') {
        const lines = S.text.split('\n').length; const nd = (r.json.docs || []).length;
        meta.replaceChildren(h('div', {}, nd > 1 ? `${nd} documents · ${r.stats.tables} tables` : `${Math.max(0, r.toc.length - 1)} top-level keys · ${r.stats.tables} tables`), h('div', {}, r.json.error ? 'invalid JSON' : `${lines} lines · valid JSON`));
        $('.wc', editor).textContent = lines + ' lines';
        head.querySelectorAll('button.jx').forEach((b) => b.addEventListener('click', () => { const on = b.dataset.act === 'expand'; doc.querySelectorAll('details.jn:not(.jraw)').forEach((d) => { d.open = on; }); }));
      } else if (kind === 'mmd') {
        const a = r.diagram;
        meta.replaceChildren(h('div', {}, `${a.label} · ${a.line}`), h('div', {}, `${a.lines} lines · mermaid`));
        $('.wc', editor).textContent = a.lines + ' lines';
      } else if (kind === 'sql') {
        const q = r.sql;
        meta.replaceChildren(h('div', {}, `${q.statements} statement${q.statements === 1 ? '' : 's'} · ${q.tables} table${q.tables === 1 ? '' : 's'}${q.ctes ? ` · ${q.ctes} named set${q.ctes === 1 ? '' : 's'}` : ''}`), h('div', {}, `${q.lines} lines · SQL`));
        $('.wc', editor).textContent = q.lines + ' lines';
      } else {
        meta.replaceChildren(h('div', {}, `${r.stats.sections} sections · ${r.stats.tables} tables`), h('div', {}, `~${r.stats.words} words · ${r.stats.minutes} min read`));
        $('.wc', editor).textContent = r.stats.words + ' words';
      }
      const t = $('h1', head);
      document.title = (S.dirty ? '• ' : '') + (t ? t.textContent : curDisp().name);
      spy();
      checkPathLinks();
      wireTables();
      applyColColours();
      wireCode();
      if (global.CSS && CSS.highlights) CSS.highlights.delete('mdr-mirror'); // ranges pointed at the old nodes
      refreshFind();
      W.enable();
      WD.enable(r);
    }
    function copyJsonSection(i) { navigator.clipboard.writeText(JV.sectionSource(S.text, i)).then(() => flash('JSON copied')); }
    function copySqlSection(i) { navigator.clipboard.writeText(SQLV.sectionSource(S.text, i)).then(() => flash('SQL copied')); }
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
    // Copy on a fenced block copies the source text of that block (the <code>'s DOM text equals the source, hl.js).
    function wireCode() {
      doc.querySelectorAll('.codeblock .codebar button.copy').forEach((b) => b.addEventListener('click', () => {
        const code = b.closest('.codeblock').querySelector('pre > code');
        const text = code.textContent.replace(/\n$/, '');
        const ok = () => { b.textContent = 'Copied'; b.classList.add('done'); flash('Code copied'); setTimeout(() => { b.textContent = 'Copy'; b.classList.remove('done'); }, 1400); };
        // execCommand fallback for when the async clipboard is refused (window not focused, permission not granted).
        const legacy = () => { const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.append(ta); ta.select(); let done = false; try { done = document.execCommand('copy'); } catch { /* refused */ } ta.remove(); done ? ok() : flash('Copy failed'); };
        (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(ok, legacy);
      }));
    }
    // ---------- table colours ----------
    // Status chips come from md.js. On top of that a column, a row or a single cell can be given a fill colour and/or a
    // text colour, each in one of four shades, and a column of amounts can show number bars (off unless turned on).
    // The choice is saved IN THE FILE, as one HTML comment right under the table, so anyone opening the file in MdReader
    // sees it, and other markdown viewers (GitHub, code.amazon.com) hide it:
    //   <!-- mdr-colours {"cols":{"State":"teal"},"rows":{"Deploy":"rose.dark"},"text":{"cells":{"Build|Score":"red"}},"bars":["Count"]} -->
    // A value is "<colour>" (the soft shade) or "<colour>.light|.strong|.dark". Columns are keyed by header text, rows
    // by their first cell, cells by both -- so a colour follows its column or row when it is moved or sorted. The on/off
    // switch is a personal view setting (this machine only).
    const COL_COLOURS = [['blue', '#4f7bd9'], ['sky', '#3a9fd6'], ['teal', '#2a9d8f'], ['mint', '#3fae8c'], ['green', '#4c9a5a'], ['lime', '#86a83a'],
      ['yellow', '#c9b22a'], ['amber', '#c9942a'], ['orange', '#d0703b'], ['red', '#c9473f'], ['rose', '#c95a7a'], ['pink', '#c867b4'],
      ['violet', '#8a6fd0'], ['indigo', '#5d63c9'], ['brown', '#9a6b4b'], ['grey', '#8a8f98']];
    const SHADES = [['light', 'Light'], ['soft', 'Soft'], ['strong', 'Strong'], ['dark', 'Dark']];
    const COLOUR_RE = /^\s*<!--\s*mdr-colours\s+(\{.*\})\s*-->\s*$/;
    const hexOf = (name) => (COL_COLOURS.find((x) => x[0] === name) || [])[1];
    const splitColour = (v) => { const m = /^([a-z]+)(?:\.(light|soft|strong|dark))?$/.exec(v || ''); return m && hexOf(m[1]) ? [m[1], m[2] || 'soft'] : null; };
    const joinColour = (name, shade) => (shade && shade !== 'soft' ? name + '.' + shade : name);
    const cellText = (c) => (c ? [...c.childNodes].filter((n) => !(n.nodeType === 1 && n.tagName === 'BUTTON')).map((n) => n.textContent).join('').replace(/\s+/g, ' ').trim() : '');
    const BAGS = ['cols', 'rows', 'cells'];
    const emptyColours = () => ({ cols: {}, rows: {}, cells: {}, text: { cols: {}, rows: {}, cells: {} }, bars: [] });
    // the line right under the table's last row, where its colour comment lives (or would be inserted)
    // JSON tables: the same colours, kept in this machine's storage per file and table (a JSON file has nowhere to hold them)
    const JC_KEY = 'mdr-jcolours';
    const jcDoc = () => { const t = curTab(); return t && !isUntitled(t) ? S.path : null; };
    function jcAll() { try { return JSON.parse(localStorage.getItem(JC_KEY) || '{}') || {}; } catch { return {}; } }
    function jcData(jp) {
      const d = emptyColours(), id = jcDoc(), src = id && (jcAll()[id] || {})[jp];
      if (src) { for (const k of BAGS) { if (src[k]) d[k] = { ...src[k] }; if (src.text && src.text[k]) d.text[k] = { ...src.text[k] }; } if (Array.isArray(src.bars)) d.bars = src.bars.slice(); }
      return d;
    }
    function jcSave(jp, d) { const id = jcDoc(); if (!id) return false; const all = jcAll(); (all[id] = all[id] || {})[jp] = d; localStorage.setItem(JC_KEY, JSON.stringify(all)); return true; }
    function colourSlot(lines, l0, l1) { let end = l1; while (end > l0 && !(lines[end - 1] || '').trim()) end--; return end; }
    function readColours(lines, l0, l1) {
      const at = colourSlot(lines, l0, l1), m = COLOUR_RE.exec(lines[at] || '');
      const data = emptyColours();
      const bags = (src, dst) => { for (const k of BAGS) if (src && src[k] && typeof src[k] === 'object') dst[k] = { ...src[k] }; };
      if (m) try { const d = JSON.parse(m[1]); bags(d, data); bags(d.text, data.text); if (Array.isArray(d.bars)) data.bars = d.bars.filter((x) => typeof x === 'string'); } catch { /* a hand-broken comment: start fresh */ }
      return { at, has: !!m, data };
    }
    function writeColours(text, l0, l1, data) {
      const lines = text.split('\n'), r = readColours(lines, l0, l1);
      const clean = (src) => Object.fromEntries(BAGS.map((k) => [k, Object.fromEntries(Object.entries(src[k] || {}).filter(([, v]) => splitColour(v)))]).filter(([, v]) => Object.keys(v).length));
      const out = clean(data), txt = clean(data.text || {}), bars = [...new Set(data.bars || [])];
      if (Object.keys(txt).length) out.text = txt;
      if (bars.length) out.bars = bars;
      const empty = !Object.keys(out).length;
      const line = '<!-- mdr-colours ' + JSON.stringify(out) + ' -->';
      if (r.has) { if (empty) lines.splice(r.at, 1); else lines[r.at] = line; }
      else if (!empty) lines.splice(r.at, 0, line);
      return lines.join('\n');
    }
    function paintCell(x, fill, ink) {
      const f = splitColour(fill), t = splitColour(ink);
      if (f) { x.dataset.cc = f[0]; x.dataset.sh = f[1]; x.style.setProperty('--cc', hexOf(f[0])); } else { delete x.dataset.cc; delete x.dataset.sh; x.style.removeProperty('--cc'); }
      if (t) { x.dataset.tc = t[0]; x.dataset.tsh = t[1]; x.style.setProperty('--tc', hexOf(t[0])); } else { delete x.dataset.tc; delete x.dataset.tsh; x.style.removeProperty('--tc'); }
    }
    function applyColColours() {
      root.classList.toggle('no-tcolour', localStorage.getItem('mdr-tcolour') === 'off');
      const lines = S.text.split('\n');
      doc.querySelectorAll('.table-wrap').forEach((wrap) => {
        const table = wrap.querySelector(':scope > table'); if (!table) return;
        const isJ = wrap.dataset.jp !== undefined; // a JSON table: colours are kept on this Mac (jcData), its rows are named by the first column after #
        const d = isJ ? jcData(wrap.dataset.jp) : wrap.dataset.l0 !== undefined ? readColours(lines, +wrap.dataset.l0, +wrap.dataset.l1).data : emptyColours();
        const head = table.querySelector('thead > tr:not(.filters)'), hs = head ? [...head.children].map(cellText) : [];
        const pick = (bag, label, c) => bag.cells[label + '|' + hs[c]] || bag.rows[label] || bag.cols[hs[c]]; // cell beats row beats column
        if (head) [...head.children].forEach((th, c) => { paintCell(th, d.cols[hs[c]], d.text.cols[hs[c]]); th.classList.toggle('bar', th.classList.contains('barv') && d.bars.includes(hs[c])); });
        table.querySelectorAll('tbody > tr').forEach((tr) => {
          const label = cellText(tr.children[isJ ? 1 : 0]);
          [...tr.children].forEach((td, c) => { paintCell(td, pick(d, label, c), pick(d.text, label, c)); td.classList.toggle('bar', td.classList.contains('barv') && d.bars.includes(hs[c])); });
        });
        // the on/off switch: a small round button at the table's top right, shown on hover, which only names itself
        // while the pointer is on it (so it never sits over a header)
        if (!wrap.querySelector(':scope > .tcol-btn')) wrap.append(h('button', { type: 'button', class: 'tcol-btn', contenteditable: 'false', onmousedown: (e) => e.preventDefault(), onclick: toggleTableColours }, h('i', {}, '◐'), h('span', {})));
        const on = !root.classList.contains('no-tcolour');
        wrap.querySelectorAll(':scope > .tcol-btn').forEach((b) => { b.querySelector('i').textContent = on ? '◐' : '◑'; b.querySelector('span').textContent = on ? 'Colours on' : 'Colours off'; b.title = on ? 'Turn table colours off (status chips, number bars, your colours) -- only on this Mac, the file is not changed' : 'Turn table colours back on'; });
      });
    }
    function toggleTableColours() {
      const off = localStorage.getItem('mdr-tcolour') === 'off';
      if (off) localStorage.removeItem('mdr-tcolour'); else localStorage.setItem('mdr-tcolour', 'off');
      applyColColours(); flash(off ? 'Table colours on' : 'Table colours off -- the ◑ on any table turns them back on', 2600);
    }
    function wireTables() {
      S.filters = S.filters || {};
      [...doc.querySelectorAll('.table-wrap > table')].forEach((table, ti) => {
        const ths = [...table.querySelectorAll('thead th')];
        const rows = [...table.querySelectorAll('tbody > tr')];
        if (!ths.length || !rows.length) return;
        const wrap = table.parentElement; wrap.classList.add('filterable');
        const st = S.filters[ti] || (S.filters[ti] = { q: ths.map(() => ''), all: '', open: false, col: -1 });
        while (st.q.length < ths.length) st.q.push('');
        st.q.length = ths.length; // a column deleted in Write leaves one box fewer
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
    const IS_MD = (p) => /\.(md|markdown|mdown|mkd|json|sql|mmd|mermaid)$/i.test(p);
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
      if (srcShown()) buildMirrorSoon();
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
    const spyLater = debounce(spy, 40);

    // ---------- split sync ----------
    // In Split the two panes are locked together. md.js stamps every rendered block with the source lines it came
    // from (data-l0/data-l1). A mirror of the textarea (.srchl: one div per source line, same font, padding and
    // width, transparent text, laid over the textarea) gives the pixel row of any source line, so a scroll on either
    // side is converted line -> block (or block -> line) and applied to the other. The mirror is also where a
    // selection made on the right is painted (<mark> over the matching source); a selection made on the left tints
    // its block(s) on the right and, when the words can be found in the rendered text, highlights them exactly.
    const sync = { lines: [], starts: [], marked: [], raf: 0, prog: new Map() };
    const inSplit = () => S.mode === 'split'; // json.js stamps its rows the same way md.js does, so JSON syncs too
    const now = () => performance.now();
    // A scroll this code sets on one pane must not be echoed back by that pane's own scroll event. A time window is
    // not enough (a long smooth scroll outlives it and its tail drags the other pane away again), so the pane is
    // ignored until it has reached the target it was sent to, with a time cap as the safety net.
    function setScroll(el, top, smooth) {
      top = Math.max(0, Math.min(top, el.scrollHeight - el.clientHeight));
      // A long smooth scroll (thousands of px, e.g. a tall page in a roomy theme) can run past 1.5 s, and its slow
      // tail was then taken for a user scroll that dragged the other pane back. Give it up to 4 s; the pane is
      // released early when the scroll ends (scrollend) or the user takes over (wheel / pointer / key, below).
      sync.prog.set(el, { top, until: now() + (smooth ? 4000 : 150) });
      if (smooth) el.scrollTo({ top, behavior: 'smooth' }); else el.scrollTop = top;
    }
    function releaseScroll(e) { sync.prog.delete(e.currentTarget); }
    function echo(el) { // true while el is still travelling to a target this code set
      const p = sync.prog.get(el); if (!p) return false;
      // Arrived: this event is the echo. Keep the entry (until scrollend / user input / the cap) so a repeat event at
      // the same position -- layout settling after the scroll, a repaint of the selection marks -- is not mistaken
      // for the user scrolling and does not drag the other pane back.
      if (Math.abs(el.scrollTop - p.top) < 1) { p.arrived = true; return true; }
      if (p.arrived || now() > p.until) { sync.prog.delete(el); return false; } // moved off the target, or never got there: the user's
      return true;
    }
    // The mirror is also the line-number gutter: every .ln row carries its number in a ::before drawn to the left of
    // the text, so numbers stay aligned with wrapped lines. Built in Edit as well as Split for that reason.
    function buildMirror() {
      if (!srcShown()) return;
      const digits = Math.max(2, String(ta.value.split('\n').length).length);
      editor.style.setProperty('--lnw', 'calc(' + digits + 'ch + 22px)'); // gutter width: textarea padding-left grows with it
      const cs = getComputedStyle(ta);
      for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'tabSize', 'paddingTop', 'paddingLeft', 'paddingBottom', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderRadius']) hl.style[p] = cs[p];
      const bars = ta.offsetWidth - ta.clientWidth - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth); // a visible scrollbar narrows the wrap width
      hl.style.paddingRight = (parseFloat(cs.paddingRight) + Math.max(0, bars)) + 'px';
      const text = ta.value, lines = text.split('\n');
      sync.starts = []; let pos = 0; for (const l of lines) { sync.starts.push(pos); pos += l.length + 1; }
      sync.lines = lines.map((l) => h('div', { class: 'ln' }, l || '\u200b'));
      sync.marked = [];
      hl.replaceChildren(...sync.lines);
      hl.scrollTop = ta.scrollTop;
      refreshFind();
    }
    const buildMirrorSoon = debounce(buildMirror, 60);
    // The editor pane fills exactly the visible height of the content pane in Edit and Split, so the textarea is the
    // only thing that scrolls (the pane itself never does) and the source runs to the bottom of the window.
    function fitEditor() {
      if (!srcShown()) { editor.style.height = ''; return; }
      const z = parseFloat(getComputedStyle(editor).zoom) || 1;
      editor.style.height = (content.clientHeight / z) + 'px';
    }
    const lineOf = (pos) => { const st = sync.starts; let lo = 0, hi = st.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (st[m] <= pos) lo = m; else hi = m - 1; } return lo; };
    const hlPad = () => parseFloat(hl.style.paddingTop) || 0;
    function lineY(ln) { // pixel row (textarea scroll coords) of a fractional source line
      const L = sync.lines; if (!L.length) return 0;
      const i = Math.min(L.length - 1, Math.max(0, Math.floor(ln))), d = L[i];
      return d.offsetTop + Math.min(1, Math.max(0, ln - i)) * d.offsetHeight;
    }
    function lineAtY(y) { // fractional source line at a pixel row
      const L = sync.lines; if (!L.length) return 0;
      let lo = 0, hi = L.length - 1;
      while (lo < hi) { const m = (lo + hi + 1) >> 1; if (L[m].offsetTop <= y) lo = m; else hi = m - 1; }
      const d = L[lo]; return lo + Math.min(1, Math.max(0, (y - d.offsetTop) / (d.offsetHeight || 1)));
    }
    // Rows folded away inside a closed <details> (JSON tree) still have an offsetParent -- Chromium hides them with
    // content-visibility, not display:none -- so visibility is asked for explicitly; checkVisibility sees through that.
    const shown = (el) => (el.checkVisibility ? el.checkVisibility() : !!el.offsetParent);
    function blocks() { // rendered blocks with their source lines and their rows in content scroll coords
      const cr = content.getBoundingClientRect(), st = content.scrollTop;
      return [...doc.querySelectorAll('[data-l0]')].filter((el) => !el.closest('[data-l0] [data-l0]') && shown(el)).map((el) => {
        const r = el.getBoundingClientRect(); let l1 = +el.dataset.l1;
        const d = el.tagName === 'SUMMARY' ? el.parentElement : null; // a folded JSON node: its hidden lines belong to the summary row
        if (d && d.dataset.r1 && !d.open) l1 = +d.dataset.r1;
        return { el, l0: +el.dataset.l0, l1, top: r.top - cr.top + st, bottom: r.bottom - cr.top + st };
      });
    }
    // Interpolate within a block, or across the gap to the next one, in both directions. Lines before the first block
    // (a JSON file's opening brace and leading comments, rendered as the header) map onto the space above it.
    function lineToY(ln, bs) {
      let b = null, nx = null;
      for (let i = 0; i < bs.length; i++) { if (bs[i].l0 <= ln) b = bs[i]; else { nx = bs[i]; break; } }
      if (!b) return nx ? nx.top * Math.min(1, Math.max(0, ln) / Math.max(1, nx.l0)) : 0;
      if (ln < b.l1) return b.top + (ln - b.l0) / Math.max(1, b.l1 - b.l0) * (b.bottom - b.top);
      if (!nx) return b.bottom;
      return b.bottom + (ln - b.l1) / Math.max(1, nx.l0 - b.l1) * (nx.top - b.bottom);
    }
    function yToLine(y, bs) {
      let b = null, nx = null;
      for (let i = 0; i < bs.length; i++) { if (bs[i].top <= y) b = bs[i]; else { nx = bs[i]; break; } }
      if (!b) return nx ? nx.l0 * Math.min(1, Math.max(0, y) / Math.max(1, nx.top)) : 0;
      if (y < b.bottom) return b.l0 + (y - b.top) / Math.max(1, b.bottom - b.top) * (b.l1 - b.l0);
      if (!nx) return b.l1;
      return b.l1 + (y - b.bottom) / Math.max(1, nx.top - b.bottom) * (nx.l0 - b.l1);
    }
    // When the very first source line is itself the first block (markdown: the h1), its offset is the document's top
    // padding and is cancelled so line 0 at the top of the left pane <-> scrollTop 0 on the right. Otherwise the
    // space above the first block is the header the leading lines map onto, and nothing is cancelled.
    const topGap = (bs) => (bs[0].l0 === 0 ? bs[0].top : 0);
    // Cancelling that whole offset everywhere would leave every aligned block that far below the top of the right
    // pane -- harmless for a 22px page margin, but a theme whose title sits in a padded hero band (Lumen) would show
    // the previous block's tail. So the full offset is cancelled only at the top and eases down to the page's own
    // top padding over the next stretch of the same height. paneY maps a document y to a scrollTop; docY inverts it.
    const docPad = () => parseFloat(getComputedStyle(doc).paddingTop) || 0;
    function paneY(yRaw, bs) {
      const g = topGap(bs), p = Math.min(docPad(), g);
      if (yRaw <= g) return 0;
      if (yRaw <= 2 * g - p) return 2 * (yRaw - g);
      return yRaw - p;
    }
    function docY(y, bs) {
      const g = topGap(bs), p = Math.min(docPad(), g);
      return y <= 2 * (g - p) ? g + y / 2 : y + p;
    }
    function onSrcScroll() {
      hl.scrollTop = ta.scrollTop;
      if (!inSplit() || echo(ta) || !sync.lines.length) return;
      cancelAnimationFrame(sync.raf);
      sync.raf = requestAnimationFrame(() => {
        const bs = blocks(); if (!bs.length) return;
        const ln = lineAtY(ta.scrollTop + hlPad());
        const y = paneY(lineToY(ln, bs), bs);
        if (Math.abs(content.scrollTop - y) < 1) return;
        setScroll(content, y);
      });
    }
    function onContentScroll() {
      spyLater();
      if (!inSplit() || echo(content) || !sync.lines.length) return;
      cancelAnimationFrame(sync.raf);
      sync.raf = requestAnimationFrame(() => {
        const bs = blocks(); if (!bs.length) return;
        const ln = yToLine(docY(content.scrollTop, bs), bs);
        const y = Math.max(0, lineY(ln) - hlPad());
        if (Math.abs(ta.scrollTop - y) < 1) return;
        setScroll(ta, y);
      });
    }
    // Right -> left: paint the selected source in the mirror. The selected text is looked for verbatim in the source
    // of the block(s) it spans; when inline syntax gets in the way (**bold**, links) the whole block's lines are marked.
    function clearLeftMarks() { sync.marked.forEach((i) => { const d = sync.lines[i]; if (d) d.textContent = ta.value.split('\n')[i] || '\u200b'; }); sync.marked = []; }
    function markLeft(lo, hi, text, nth) {
      clearLeftMarks();
      const lines = ta.value.split('\n'); hi = Math.min(hi, lines.length);
      const src = lines.slice(lo, hi).join('\n');
      const t = (text || '').trim(); let a = 0, b = src.length;
      if (t.length) {
        // All occurrences in the block's source; take the one at the same rank as the selection had in the rendered
        // text (so "a" selected in the second bullet marks that "a", not the first one in the list).
        const occ = []; for (let i = src.indexOf(t); i >= 0 && occ.length < 500; i = src.indexOf(t, i + 1)) occ.push(i);
        if (occ.length) { const idx = occ[Math.min(nth || 0, occ.length - 1)]; a = idx; b = idx + t.length; }
      }
      let pos = 0;
      for (let i = lo; i < hi; i++) {
        const l = lines[i], s = pos, e = pos + l.length; pos = e + 1;
        const ma = Math.max(a, s) - s, mb = Math.min(b, e) - s;
        if (mb < ma || (mb === ma && l.length)) continue;
        const d = sync.lines[i]; if (!d) continue;
        d.replaceChildren(l.slice(0, ma), h('mark', {}, l.slice(ma, mb) || '\u200b'), l.slice(mb) || '');
        sync.marked.push(i);
      }
      if (!sync.marked.length) return;
      const y0 = lineY(sync.marked[0]), y1 = lineY(sync.marked[sync.marked.length - 1] + 1);
      if (y0 < ta.scrollTop + 8 || y1 > ta.scrollTop + ta.clientHeight - 8) setScroll(ta, y0 - hlPad() - Math.min(80, ta.clientHeight / 4), true);
    }
    const onSelChange = debounce(() => {
      if (!inSplit()) return;
      const sel = document.getSelection();
      const an = sel && sel.rangeCount ? sel.anchorNode : null;
      if (!an || !doc.contains(an) || sel.isCollapsed) return clearLeftMarks(); // selection left the rendering (or collapsed)
      clearRightMarks(); // the user is now selecting on the right; drop the echo of an earlier left selection
      const blkOf = (n) => n && (n.nodeType === 1 ? n : n.parentElement).closest('[data-l0]');
      const bs = [blkOf(an), blkOf(sel.focusNode)].filter(Boolean);
      if (!bs.length) return;
      const text = sel.toString(), t = text.trim();
      // Rank of this selection among identical strings in the block's rendered text: count occurrences before it.
      let nth = 0;
      if (t.length && bs[0] === bs[bs.length - 1]) {
        const r = sel.getRangeAt(0), pre = document.createRange();
        pre.selectNodeContents(bs[0]); pre.setEnd(r.startContainer, r.startOffset);
        const before = pre.toString() + text.slice(0, text.length - text.trimStart().length);
        for (let i = before.indexOf(t); i >= 0; i = before.indexOf(t, i + 1)) nth++;
      }
      markLeft(Math.min(...bs.map((b) => +b.dataset.l0)), Math.max(...bs.map((b) => +b.dataset.l1)), text, nth);
    }, 80);
    // Left -> right: tint the blocks the textarea selection spans and highlight the exact words when they are found
    // in the rendered text (CSS Custom Highlight API; whitespace-insensitive, inline markup stripped from the query).
    const HL_NAME = 'mdr-mirror';
    function clearRightMarks() { doc.querySelectorAll('.mirror').forEach((el) => el.classList.remove('mirror')); if (global.CSS && CSS.highlights) CSS.highlights.delete(HL_NAME); }
    function findInBlock(el, query, nth) {
      const q = query.replace(/\s+/g, ' ').trim().toLowerCase(); if (!q.length) return null;
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); const nodes = [];
      let full = ''; while (walker.nextNode()) { nodes.push({ n: walker.currentNode, at: full.length }); full += walker.currentNode.nodeValue; }
      let norm = '', map = []; // norm index -> full index
      for (let i = 0; i < full.length; i++) { const c = full[i]; if (/\s/.test(c)) { if (norm.endsWith(' ')) continue; norm += ' '; } else norm += c.toLowerCase(); map.push(i); }
      const occ = []; for (let i = norm.indexOf(q); i >= 0 && occ.length < 500; i = norm.indexOf(q, i + 1)) occ.push(i);
      if (!occ.length) return null;
      const i0 = occ[Math.min(nth || 0, occ.length - 1)];
      const f0 = map[i0], f1 = map[i0 + q.length - 1] + 1;
      const locate = (f) => { let k = nodes.length - 1; while (k > 0 && nodes[k].at > f) k--; return [nodes[k].n, f - nodes[k].at]; };
      const r = document.createRange(); const [n0, o0] = locate(f0), [n1, o1] = locate(f1 - 1);
      r.setStart(n0, o0); r.setEnd(n1, Math.min(o1 + 1, n1.nodeValue.length)); return r;
    }
    const onSrcSelect = debounce(() => {
      if (!inSplit()) return;
      const s = ta.selectionStart, e = ta.selectionEnd;
      clearRightMarks();
      if (s === e) return;
      const lo = lineOf(s), hi = lineOf(Math.max(s, e - 1)) + 1;
      // Selected lines hidden inside folded JSON nodes: unfold those nodes (not the "as tree" duplicate of a table)
      // so the exact row can be tinted; a selection on the summary's own line leaves the node folded.
      for (const d of doc.querySelectorAll('details[data-r0]:not([open]):not(.jraw)')) {
        const r0 = +d.dataset.r0, r1 = +d.dataset.r1; // hidden lines are (r0, r1): everything after the summary's line
        if (hi > r0 + 1 && lo < r1) d.open = true;
      }
      // Innermost stamped elements the selection spans (a bullet or table row rather than the whole list/table).
      const cand = [...doc.querySelectorAll('[data-l0]')].filter((el) => shown(el) && +el.dataset.l0 < hi && +el.dataset.l1 > lo);
      const inner = cand.filter((el) => !cand.some((o) => o !== el && el.contains(o)));
      const bs = inner.map((el) => { const r = el.getBoundingClientRect(), cr = content.getBoundingClientRect(); return { el, l0: +el.dataset.l0, l1: +el.dataset.l1, top: r.top - cr.top + content.scrollTop, bottom: r.bottom - cr.top + content.scrollTop }; }).sort((a, b) => a.top - b.top);
      if (!bs.length) return;
      bs.forEach((b) => b.el.classList.add('mirror'));
      const raw = ta.value.slice(s, e);
      const isJson = root.dataset.kind === 'json', isMd = !root.dataset.kind || root.dataset.kind === 'md';
      const strip = (x) => (isJson ? x.replace(/,\s*$/, '') : !isMd ? x : x.replace(/[*_`~]+|^\s*(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gm, ''));
      // JSON: tree rows show strings quoted, table cells bare -- try both; markdown: drop the inline markup.
      const queries = isJson ? [...new Set([strip(raw), strip(raw).replace(/"/g, '')])] : [strip(raw)];
      // Rank of the selection among identical strings in the block's source before it, so the right highlight lands
      // on the same occurrence (not the first one in the block).
      const rank = (b, q) => {
        const qn = q.replace(/\s+/g, ' ').trim().toLowerCase(); if (!qn) return 0;
        const lines = ta.value.split('\n'), start = lines.slice(0, b.l0).join('\n').length + (b.l0 ? 1 : 0);
        const before = strip(ta.value.slice(start, Math.max(start, s))).replace(/\s+/g, ' ').toLowerCase();
        let n = 0; for (let i = before.indexOf(qn); i >= 0; i = before.indexOf(qn, i + 1)) n++; return n;
      };
      if (global.CSS && CSS.highlights && global.Highlight) { outer: for (const b of bs) for (const query of queries) { const r = findInBlock(b.el, query, rank(b, query)); if (r) { CSS.highlights.set(HL_NAME, new Highlight(r)); break outer; } } }
      const top = bs[0].top, bottom = bs[bs.length - 1].bottom, vt = content.scrollTop, vb = vt + content.clientHeight;
      if (top < vt + 8 || bottom > vb - 8) setScroll(content, top - Math.min(80, content.clientHeight / 4), true);
    }, 60);
    document.addEventListener('selectionchange', onSelChange);
    for (const el of [ta, content]) for (const ev of ['scrollend', 'wheel', 'pointerdown', 'keydown', 'touchstart']) el.addEventListener(ev, releaseScroll, { passive: true });
    ['select', 'keyup', 'mouseup'].forEach((ev) => ta.addEventListener(ev, onSrcSelect));
    if (global.ResizeObserver) new ResizeObserver(() => { refreeze(); fitEditor(); if (srcShown()) buildMirrorSoon(); }).observe(content);

    // ---------- modes / theme / panels ----------
    function setMode(m, quiet) {
      if (!['read', 'write', 'edit', 'split'].includes(m)) m = 'read';
      W.commitAll(); WD.commitAll();
      if (S.editingSec !== null) finishSection(S.editingSec, true);
      const was = S.mode;
      S.mode = m; root.dataset.mode = m;
      seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
      if (m === 'read' || m === 'split' || m === 'write' || was === 'write') paint();
      refreeze(); // the pane is half as wide in Split: a frozen (magnified) layout must re-lay out for it
      fitEditor(); if (srcShown()) requestAnimationFrame(buildMirror);
      if (srcShown()) setTimeout(() => ta.focus(), 0);
      if (!quiet) adapter.setPref && adapter.setPref('mode', m);
    }
    function setTheme(t) {
      if (!THEMES.some((x) => x.id === t)) t = DEFAULT_THEME;
      S.theme = t; document.documentElement.dataset.theme = t; themeSel.value = t;
      refreeze();
      if (srcShown()) requestAnimationFrame(() => { fitEditor(); buildMirror(); });
      revealActiveTab(); requestAnimationFrame(revealActiveTab); // the strip's padding and zoom change per theme, which can scroll the active tab out of view
      adapter.setPref && adapter.setPref('theme', t);
    }
    // Keep the active tab inside the (scrollable) strip: after a switch, a theme change, or a window resize. Measured
    // from client rects and corrected twice, because Chromium scales scrollLeft when the strip carries a CSS zoom
    // (the sections theme), which makes both scrollIntoView and an offsetLeft-based target land a few px short.
    function revealActiveTab() {
      const on = tabsEl.children[S.tab]; if (!on) return;
      for (let i = 0; i < 2; i++) {
        const r = on.getBoundingClientRect(), s = tabsEl.getBoundingClientRect();
        const scale = tabsEl.offsetWidth ? s.width / tabsEl.offsetWidth : 1, pad = 12 * scale;
        const d = r.left - pad < s.left ? r.left - pad - s.left : r.right + pad > s.right ? r.right + pad - s.right : 0;
        if (!d) return;
        tabsEl.scrollLeft += d / scale;
      }
    }
    addEventListener('resize', debounce(revealActiveTab, 120));
    // ---------- zoom / reading width ----------
    // Auto-zoom: on wide screens a fixed 16px column looks tiny, so the document scales with the
    // content pane (1.0 at <=1200px, up to 1.5 at 2400px+), then the user's A-/A+ steps multiply it.
    function applyZoom() { root.style.setProperty('--zoom', (S.zoom * S.autoZoom).toFixed(3)); root.style.setProperty('--ui-zoom', (1 + (S.autoZoom - 1) * 0.6).toFixed(3)); zoomPct.textContent = pct() + '%'; fitEditor(); }
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
        if (Math.abs(z - S.autoZoom) > 0.01) { S.autoZoom = z; applyZoom(); requestAnimationFrame(revealActiveTab); } // the strip zooms with --ui-zoom, moving its scroll position
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
      if (docKind() !== 'md') return; // JSON / SQL have no markdown sections to splice; use Edit mode
      W.commitAll(); WD.commitAll();
      if (S.editingSec !== null && S.editingSec !== i) finishSection(S.editingSec, true, true);
      const { sections } = MD.split(S.text);
      const sec = secs.querySelector(`.sec[data-i="${i}"]`);
      if (!sec || !sections[i]) return;
      S.editingSec = i;
      sec.classList.add('editing');
      const t = h('textarea', { class: 'sec-src', spellcheck: 'false', onkeydown: (e) => { if (e.key === 'Escape') finishSection(i, false, true); if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') finishSection(i, true, true); } });
      t.value = sections[i].src;
      sec.append(t);
      t.style.height = Math.max(220, Math.min(innerHeight * 0.7, t.scrollHeight + 20)) + 'px';
      const b = sec.querySelector('[data-act=edit]'); b.textContent = 'Done'; b.onclick = () => finishSection(i, true, true);
      const c = sec.querySelector('[data-act=copy]'); c.textContent = 'Cancel'; c.onclick = () => finishSection(i, false, true);
      t.focus({ preventScroll: true }); // focusing must not jump the page; the textarea sits right under the heading
    }
    // Done / Cancel re-render the whole document, and pictures and diagrams above the section come back with zero
    // height until they load again, so the page would slide away from the section being edited. Pin the section's
    // top to where it was on screen, and keep it pinned while late content settles -- until the user scrolls.
    function keepSectionInPlace(i, change) {
      keepInPlace(() => secs.querySelector(`.sec[data-i="${i}"]`), change);
    }
    // the same for any element found again after a re-render (Write's table and multi-block edits pin the block)
    function keepInPlace(find, change) {
      const top = () => { const el = find(); return el ? el.getBoundingClientRect().top - content.getBoundingClientRect().top : null; };
      const want = top();
      change();
      if (want === null) return;
      const fix = () => { const now = top(); if (now !== null && Math.abs(now - want) > 0.5) content.scrollTop += now - want; };
      fix(); fix(); // a second pass absorbs any scale between layout and scroll (magnified page)
      let done = false;
      const ro = global.ResizeObserver ? new ResizeObserver(() => { if (!done) fix(); }) : null;
      if (ro) ro.observe(doc);
      const onImg = (e) => { if (!done && e.target.tagName === 'IMG') fix(); };
      doc.addEventListener('load', onImg, true);
      const stop = () => { if (done) return; done = true; if (ro) ro.disconnect(); doc.removeEventListener('load', onImg, true); ['wheel', 'touchstart', 'mousedown', 'keydown'].forEach((ev) => content.removeEventListener(ev, stop, true)); };
      ['wheel', 'touchstart', 'mousedown', 'keydown'].forEach((ev) => content.addEventListener(ev, stop, true));
      setTimeout(stop, 2500);
    }
    function finishSection(i, apply, pin) {
      const sec = secs.querySelector(`.sec[data-i="${i}"]`);
      const t = sec && sec.querySelector('.sec-src');
      if (t && apply) {
        const { sections, lines } = MD.split(S.text);
        const s = sections[i];
        // Done without a change must not touch the text (re-joining the lines could mark the tab as edited)
        if (s && t.value !== s.src) {
          const next = [...lines.slice(0, s.start), ...t.value.replace(/\n$/, '').split('\n'), ...lines.slice(s.end)].join('\n');
          if (next !== S.text) setText(next);
        }
      }
      S.editingSec = null;
      if (pin) keepSectionInPlace(i, paint); else paint();
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
      W.commitAll(); WD.commitAll();
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
      revealActiveTab();
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
      const ext = isUntitled(t) && global.JV && JV.looksLikeJson(t.text) ? 'json' : isUntitled(t) && global.DG && DG.looksLike(t.text) ? 'mmd' : isUntitled(t) && global.SQLV && SQLV.looksLikeSql(t.text) ? 'sql' : 'md';
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
      if (!isUntitled(t)) closedStack.push(t.path);
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
    const parentDir = (d) => { const c = (d || '').replace(/\/+$/, ''); const i = c.lastIndexOf('/'); return i <= 0 ? (c ? '/' : null) : c.slice(0, i); };
    const shortDir = (d) => (adapter.home && (d === adapter.home || d.startsWith(adapter.home + '/')) ? '~' + d.slice(adapter.home.length) : d) || '/';
    const tailDir = (d, n = 2) => { const sd = shortDir(d); const parts = sd.split('/'); return parts.length > n + 1 ? '…/' + parts.slice(-n).join('/') : sd; }; // '…/test/fixtures'
    function treeUp() { const up = parentDir(S.tree); if (!up || up === S.tree) return flash('Already at the top'); rootTreeAt(up); }
    async function buildTree(dir) {
      if (S.tree === dir) return;
      S.tree = dir;
      rootLbl.textContent = tailDir(dir, 3); rootLbl.title = dir;
      const up = parentDir(dir); upBtn.disabled = !up || up === dir; upBtn.title = up && up !== dir ? 'Up to ' + shortDir(up) : 'Already at the top';
      homeBtn.hidden = !adapter.home || dir === adapter.home;
      tree.replaceChildren(await folderNode(dir, true));
    }
    // Recent view replaces the tree while open. Rows: the last session (if the tab set was lost), then recently opened files.
    async function toggleRecent(force) {
      const on = force !== undefined ? force : recentEl.hidden;
      recentBtn.setAttribute('aria-pressed', String(on)); recentBtn.textContent = on ? 'Close' : 'Recent';
      tree.hidden = on; rootLbl.hidden = on; upBtn.hidden = on; homeBtn.hidden = on || !adapter.home || S.tree === adapter.home; recentEl.hidden = !on;
      if (!on) return;
      recentEl.replaceChildren(h('div', { class: 'empty' }, 'loading…'));
      const r = adapter.recent ? await adapter.recent() : { files: [], lastSession: [] };
      const open = new Set(S.tabs.map((t) => t.path));
      const row = (p, extra) => { const d = adapter.displayPath ? adapter.displayPath(p) : { name: p.split('/').pop(), dir: '' }; return h('div', { class: 'rfile' + (open.has(p) ? ' on' : ''), 'data-path': p, title: p, onclick: () => loadFile(p) }, h('span', { class: 'rname' }, d.name), h('span', { class: 'rdir', title: d.dir }, tailDir(d.dir)), extra || null); };
      const kids = [];
      const last = (r.lastSession || []).filter((p) => !open.has(p));
      if (last.length) kids.push(h('div', { class: 'rhead' }, h('span', {}, `Last session · ${last.length} tab${last.length === 1 ? '' : 's'}`), h('button', { class: 'rall', title: 'Reopen every tab from the last session', onclick: async () => { for (const p of last) await loadFile(p); toggleRecent(false); } }, 'Reopen all')), ...last.map((p) => row(p)));
      const rest = (r.files || []).filter((p) => !last.includes(p));
      if (rest.length) kids.push(h('div', { class: 'rhead' }, h('span', {}, 'Recently opened')), ...rest.map((p) => row(p)));
      if (!kids.length) kids.push(h('div', { class: 'empty' }, 'nothing opened yet'));
      recentEl.replaceChildren(...kids);
    }
    async function reopenClosed() {
      while (closedStack.length) { const p = closedStack.pop(); if (!S.tabs.some((t) => t.path === p)) { await loadFile(p); return; } }
      flash('No closed tab to reopen');
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
      const mds = entries.filter((e) => !e.dir && /\.(md|markdown|mdown|txt|json|sql)$/i.test(e.name)).sort((a, b) => a.name.localeCompare(b.name));
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
      W.commitAll(); WD.commitAll();
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
      if (k === 'f' && !e.shiftKey && !e.altKey) { e.preventDefault(); return openFind(); }
      if (k === 'g') { e.preventDefault(); return stepFind(e.shiftKey ? -1 : 1); }
      if (k === 's') { e.preventDefault(); save(); }
      else if (k === 'e' && !e.shiftKey) { e.preventDefault(); setMode(!srcShown() ? 'edit' : 'read'); }
      else if (k === '1') { e.preventDefault(); setMode('read'); } else if (k === '2') { e.preventDefault(); setMode('edit'); } else if (k === '3') { e.preventDefault(); setMode('split'); } else if (k === '4') { e.preventDefault(); setMode('write'); }
      else if (k === '\\') { e.preventDefault(); adapter.listDir && togglePanel('files'); }
      else if (k === '/') { e.preventDefault(); togglePanel('outline'); }
      else if (k === 'y' && e.shiftKey) { e.preventDefault(); cycleTheme(); }
      else if (k === 'f' && e.shiftKey) { e.preventDefault(); formatDoc(e.altKey); }
      else if (k === 't' && e.shiftKey) { e.preventDefault(); reopenClosed(); } // standard "reopen closed tab"
      else if (k === 'arrowup' && e.altKey) { e.preventDefault(); treeUp(); }
      else if (k === 'w' && e.shiftKey) { e.preventDefault(); cycleWidth(); }
      else if (k === '=' || k === '+') { e.preventDefault(); stepZoom(1); }
      else if (k === '-' || k === '_') { e.preventDefault(); stepZoom(-1); }
      else if (k === '0') { e.preventDefault(); resetZoom(); }
      else if (k === 'o' && adapter.openDialog) { e.preventDefault(); openDialog(); }
    });
    // Double-click on the empty part of the tab strip opens a new untitled tab (like a browser).
    tabsEl.addEventListener('dblclick', (e) => { if (e.target === tabsEl) newTab(); });
    // A vertical wheel over the strip scrolls it sideways (a mouse has no horizontal wheel; a trackpad still pans).
    tabsEl.addEventListener('wheel', (e) => { if (e.ctrlKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return; if (tabsEl.scrollWidth > tabsEl.clientWidth) { e.preventDefault(); tabsEl.scrollLeft += e.deltaY; } }, { passive: false });
    // Pasting onto an empty untitled tab while reading fills it, so ⌘T then ⌘V works in any mode.
    addEventListener('paste', (e) => {
      const t = curTab();
      if (e.defaultPrevented) return;
      if (!isUntitled(t) || srcShown() || S.text.trim() || /^(TEXTAREA|INPUT)$/.test((e.target.tagName || '').toUpperCase())) return;
      const md = e.clipboardData && e.clipboardData.getData('text/plain'); if (!md) return;
      e.preventDefault(); setText(md); t.text = md; paint(); notifyTabs();
    });
    doc.addEventListener('click', (e) => {
      const a = e.target.closest('a[href]'); if (!a) return;
      // Write (the default mode) follows links like Read does; ⌥-click puts the cursor inside the link text instead
      if (S.mode === 'write' && e.altKey && a.closest('.wblock, .wed')) { e.preventDefault(); return; }
      if (a.dataset.path) { e.preventDefault(); openPathLink(a.dataset.path, e.metaKey || e.ctrlKey); return; }
      const href = a.getAttribute('href');
      if (href.startsWith('#')) { e.preventDefault(); scrollTo(href.slice(1)); }
      else if (/^https?:/.test(href)) { e.preventDefault(); adapter.openExternal && adapter.openExternal(href); }
      else if (/^[a-z]+:/i.test(href)) { e.preventDefault(); } // mailto:, file:, etc. -- never navigate the shell
      else {
        // Relative link: open sibling .md files in the reader; anything else is ignored rather than navigating away.
        e.preventDefault();
        if (/\.(md|markdown|mdown|mkd|json|sql|mmd|mermaid)(#.*)?$/i.test(href) && S.path && adapter.readFile) {
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
      setMode(DEFAULT_MODE, true); // opens ready to type on the page; Read / Edit / Split stay one click (⌘1-3) away
      saveBtn.disabled = true;
    })();

    // ---------- find (⌘F) ----------
    // One bar for every document kind (markdown, JSON, SQL, mermaid) and every mode. Read searches the rendered
    // page; Edit searches the source (highlights drawn on the line mirror under the textarea); Split highlights both
    // and steps through the pane you last worked in. Matches are painted with the CSS Custom Highlight API, so the
    // document's DOM is never touched; a match inside a folded JSON node opens that node when you step to it.
    const findIn = h('input', { class: 'fq', type: 'text', placeholder: 'Find', spellcheck: 'false', 'aria-label': 'Find in document' });
    const findCount = h('span', { class: 'fcount' });
    const findCase = h('button', { class: 'fcase', title: 'Match case', 'aria-pressed': 'false' }, 'Aa');
    const findPrev = h('button', { class: 'fprev', title: 'Previous match (⇧⌘G)', html: '&#x2191;' });
    const findNext = h('button', { class: 'fnext', title: 'Next match (⌘G · Enter)', html: '&#x2193;' });
    const findClose = h('button', { class: 'fclose', title: 'Close (Esc)', html: '&#x2715;' });
    const findBar = h('div', { class: 'findbar', hidden: '', role: 'search' }, findIn, findCount, findCase, findPrev, findNext, findClose);
    centre.append(findBar);
    const F = { open: false, q: '', cs: false, pane: 'doc', hits: { doc: [], src: [] }, cur: -1 };
    const hasHL = !!(global.CSS && CSS.highlights && global.Highlight);
    const SKIP = 'button, select, input, textarea, .tools, .codebar, .dgbar, .srchl, script, style';
    const BLOCKISH = /^(P|LI|TD|TH|H[1-6]|PRE|DIV|SUMMARY|DT|DD|BLOCKQUOTE|FIGCAPTION|TR|SECTION|ARTICLE|DETAILS|TABLE|UL|OL)$/;
    const blockOf = (n) => { let e = n.parentElement; while (e && !BLOCKISH.test(e.tagName)) e = e.parentElement; return e; };
    // Rendered text: one string per document with a map back to text nodes; a separator between blocks keeps a
    // match from running from the end of one paragraph into the next, while **bold** words inside a sentence match.
    function docHits(q, cs) {
      const nodes = [], starts = []; let text = '', lastBlock = null;
      const w = document.createTreeWalker(doc, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (!n.nodeValue || n.parentElement.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
      for (let n; (n = w.nextNode());) {
        const b = blockOf(n); if (b !== lastBlock) { text += '\u0000'; lastBlock = b; }
        starts.push(text.length); nodes.push(n); text += n.nodeValue;
      }
      const hay = cs ? text : text.toLowerCase(), needle = cs ? q : q.toLowerCase(), out = [];
      const at = (pos) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] <= pos) lo = m; else hi = m - 1; } return lo; };
      for (let i = hay.indexOf(needle); i >= 0 && out.length < 5000; i = hay.indexOf(needle, i + needle.length)) {
        const a = at(i), b = at(i + needle.length - 1), r = document.createRange();
        r.setStart(nodes[a], i - starts[a]); r.setEnd(nodes[b], i + needle.length - starts[b]); out.push(r);
      }
      // a row hidden by a table filter is not a match you can see; a folded JSON node is (it opens on the way)
      return out.filter((r) => { const el = r.startContainer.parentElement; return (el.checkVisibility ? el.checkVisibility() || el.closest('details:not([open])') : true); });
    }
    function srcHits(q, cs) {
      if (!srcShown() || !sync.lines || !sync.lines.length) return [];
      const needle = cs ? q : q.toLowerCase(), out = [];
      sync.lines.forEach((d, ln) => {
        const t = d.firstChild; if (!t || t.nodeType !== 3) return;
        const v = cs ? t.nodeValue : t.nodeValue.toLowerCase();
        for (let i = v.indexOf(needle); i >= 0 && out.length < 5000; i = v.indexOf(needle, i + needle.length)) { const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + needle.length); r.ln = ln; r.col = i; out.push(r); }
      });
      return out;
    }
    const navPane = () => (!srcShown() ? 'doc' : S.mode === 'edit' ? 'src' : F.pane);
    function paintFind() {
      if (!hasHL) return;
      const list = navPane() === 'src' ? F.hits.src : F.hits.doc, cur = list[F.cur];
      CSS.highlights.set('mdr-find', new Highlight(...F.hits.doc, ...F.hits.src.filter((r) => r !== cur)));
      const hc = new Highlight(...(cur ? [cur] : [])); hc.priority = 2; CSS.highlights.set('mdr-find-cur', hc);
    }
    function runFind(keep) {
      F.q = findIn.value; F.cs = findCase.getAttribute('aria-pressed') === 'true';
      const prev = keep ? curFindY() : null;
      F.hits = F.q ? { doc: S.mode === 'edit' ? [] : docHits(F.q, F.cs), src: srcHits(F.q, F.cs) } : { doc: [], src: [] };
      const list = navPane() === 'src' ? F.hits.src : F.hits.doc;
      // keep the place: after a re-render or an edit, continue from the match at (or after) the previous one
      F.cur = !list.length ? -1 : prev === null ? firstVisible(list) : Math.max(0, list.findIndex((r) => hitY(r) >= prev - 1));
      if (F.cur < 0 && list.length) F.cur = 0;
      findCount.textContent = !F.q ? '' : list.length ? `${F.cur + 1} of ${list.length}${list.length >= 5000 ? '+' : ''}` : 'No matches';
      findBar.classList.toggle('none', !!F.q && !list.length);
      paintFind();
    }
    const hitY = (r) => (r.ln !== undefined ? r.ln * 1e6 + r.col : r.getBoundingClientRect().top - content.getBoundingClientRect().top + content.scrollTop);
    const curFindY = () => { const list = navPane() === 'src' ? F.hits.src : F.hits.doc; const r = list[F.cur]; return r && r.startContainer.isConnected ? hitY(r) : null; };
    function firstVisible(list) { // the first match at or below the top of what you are looking at
      if (navPane() === 'src') { const ln = Math.floor(lineAtY(ta.scrollTop)); const i = list.findIndex((r) => r.ln >= ln); return i < 0 ? 0 : i; }
      const top = content.getBoundingClientRect().top; const i = list.findIndex((r) => r.getBoundingClientRect().bottom >= top + 4); return i < 0 ? 0 : i;
    }
    function showHit() {
      const list = navPane() === 'src' ? F.hits.src : F.hits.doc, r = list[F.cur]; if (!r) return;
      if (r.ln !== undefined) {
        const y = lineY(r.ln) - hlPad();
        if (y < ta.scrollTop + 20 || y > ta.scrollTop + ta.clientHeight - 40) { ta.scrollTop = Math.max(0, y - ta.clientHeight / 3); onSrcScroll(); }
      } else {
        for (let d = r.startContainer.parentElement.closest('details:not([open])'); d; d = d.parentElement.closest('details:not([open])')) d.open = true;
        const cr = content.getBoundingClientRect(), rr = r.getBoundingClientRect();
        if (rr.top < cr.top + 40 || rr.bottom > cr.bottom - 40) content.scrollTop += rr.top - cr.top - content.clientHeight / 3;
      }
      findCount.textContent = `${F.cur + 1} of ${list.length}${list.length >= 5000 ? '+' : ''}`;
      paintFind();
    }
    function stepFind(dir) {
      if (!F.open) return openFind();
      if (findIn.value !== F.q) runFind();
      const list = navPane() === 'src' ? F.hits.src : F.hits.doc; if (!list.length) return;
      F.cur = (F.cur + dir + list.length) % list.length; showHit();
    }
    function openFind() {
      const sel = srcShown() && document.activeElement === ta ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : String(getSelection() || '');
      if (sel && !sel.includes('\n') && sel.length < 200) findIn.value = sel.trim() || findIn.value;
      if (S.mode === 'split') F.pane = document.activeElement === ta ? 'src' : F.pane;
      F.open = true; findBar.hidden = false; placeFind();
      findIn.focus(); findIn.select(); runFind(); showHit();
    }
    function closeFind() {
      if (!F.open) return;
      F.open = false; findBar.hidden = true;
      const list = navPane() === 'src' ? F.hits.src : F.hits.doc, r = list[F.cur];
      if (hasHL) { CSS.highlights.delete('mdr-find'); CSS.highlights.delete('mdr-find-cur'); }
      if (r && r.ln !== undefined) { const p = sync.starts[r.ln] + r.col; ta.focus({ preventScroll: true }); ta.setSelectionRange(p, p + F.q.length); } // leave the caret on the match, like an editor
      else if (srcShown()) ta.focus({ preventScroll: true });
      F.hits = { doc: [], src: [] }; F.cur = -1;
    }
    function placeFind() { findBar.style.top = (content.offsetTop + 10) + 'px'; }
    // paint() and the mirror call this on every re-render; it is hoisted, and does nothing until the bar exists
    refreshFind.ready = true;
    function refreshFind() { if (!refreshFind.ready || !F.open) return; clearTimeout(refreshFind.t); refreshFind.t = setTimeout(() => F.open && runFind(true), 120); }
    findIn.addEventListener('input', () => { runFind(); showHit(); });
    findIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(); }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'g') { e.preventDefault(); e.stopPropagation(); stepFind(e.shiftKey ? -1 : 1); }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); findIn.select(); }
    });
    findCase.onclick = () => { findCase.setAttribute('aria-pressed', String(findCase.getAttribute('aria-pressed') !== 'true')); runFind(); showHit(); findIn.focus(); };
    findPrev.onclick = () => { stepFind(-1); findIn.focus(); };
    findNext.onclick = () => { stepFind(1); findIn.focus(); };
    findClose.onclick = () => closeFind();
    // In Split the arrows walk the pane you last worked in
    ta.addEventListener('pointerdown', () => { if (F.pane !== 'src') { F.pane = 'src'; if (F.open) runFind(); } });
    doc.addEventListener('pointerdown', () => { if (F.pane !== 'doc') { F.pane = 'doc'; if (F.open) runFind(); } });
    addEventListener('resize', () => F.open && placeFind());

    return { loadFile, newTab, closeTab, nextTab, showTab, setWidth, stepZoom, resetZoom, cycleWidth, reopenClosed, toggleRecent, treeUp,
      find: openFind, findNext: () => stepFind(1), findPrev: () => stepFind(-1),
      saveAll: async () => { stashActive(); for (const t of S.tabs) if (t.text !== t.saved) await writeTab(t); if (S.tabs[S.tab]) { S.saved = S.tabs[S.tab].saved; S.path = S.tabs[S.tab].path; setDirty(false); } notifyTabs(); },
      setText: (t, path) => { S.path = path || S.path; S.saved = t; setText(t); setDirty(false); const tb = S.tabs[S.tab]; if (tb) { tb.text = tb.saved = t; } paint(); }, setTheme, setMode, save, get state() { return S; } };
  }

  global.MdShell = { mount, THEMES, WIDTHS };
})(window);
