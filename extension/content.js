// Content script: turns Chrome's plain-text rendering of a .md file into the MdReader UI.
(async () => {
  // Only act on real plain-text markdown / JSON documents (Chrome renders those as <pre> inside an empty body).
  if (document.contentType && !/^(text\/(plain|markdown|x-markdown)|application\/json)$/i.test(document.contentType)) return;
  const pre = document.body && document.body.children.length === 1 && document.body.firstElementChild.tagName === 'PRE' ? document.body.firstElementChild : null;
  if (!pre && !/^(text\/markdown|application\/json)$/i.test(document.contentType || '')) return;
  let text = pre ? pre.textContent : document.body.innerText;
  if (await MdExt.prefs.get('disabled')) return;

  // Servers that omit charset make Chrome decode UTF-8 markdown as Windows-1252 ("Â·", "â†’").
  // Re-fetch the bytes and decode as UTF-8 when that happened.
  if (!/utf-?8/i.test(document.characterSet || '') || /Â|â€|â†/.test(text)) {
    try {
      const buf = await (await fetch(location.href, { cache: 'force-cache' })).arrayBuffer();
      const utf8 = new TextDecoder('utf-8', { fatal: true }).decode(buf);
      text = utf8;
    } catch { /* not valid UTF-8 or fetch blocked: keep what Chrome gave us */ }
  }

  const href = location.href;
  const isFile = location.protocol === 'file:';
  const disp = MdExt.displayFromUrl(href);

  // Rebuild the document.
  document.documentElement.innerHTML = '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"></div></body>';
  await MdExt.injectStyles(['ext.css']);

  const adapter = {
    readFile: async () => text,
    canSave: () => true,
    async writeFile(p, t, hint) {
      // p null = an untitled tab (⌘T): always ask where to save, never write it over the page's own file.
      if (p && isFile) return MdExt.saveViaPicker('url:' + href, disp.name, t, flash);
      if (!window.showSaveFilePicker) throw new Error('Saving is not available on this page');
      const json = hint && hint.ext === 'json';
      const h = await window.showSaveFilePicker({ suggestedName: p ? disp.name : (json ? 'untitled.json' : 'untitled.md'), types: [json ? { description: 'JSON', accept: { 'application/json': ['.json'] } } : { description: 'Markdown', accept: { 'text/markdown': ['.md'] } }] });
      await MdExt.writeHandle(h, t);
    },
    getPref: MdExt.prefs.get,
    setPref: (k, v) => { if (k !== 'files') MdExt.prefs.set(k, v); },
    displayPath: () => disp,
    openExternal: (u) => window.open(u, '_blank', 'noopener'),
    openPath: (p) => { location.href = 'mdreader://open?path=' + encodeURIComponent(p); }, // desktop app decides: tab or OS
  };
  const shell = MdShell.mount(document.getElementById('app'), adapter);
  const flash = (m, ms) => { const t = document.querySelector('.toast'); if (!t) return; t.textContent = m; t.classList.add('show'); clearTimeout(flash.t); flash.t = setTimeout(() => t.classList.remove('show'), ms || 1600); };
  document.getElementById('app').classList.add('no-files');
  await shell.loadFile(href);

  // Extra top-bar buttons: "Open in MdReader" (desktop app, via the mdreader:// scheme) and "Raw".
  const top = document.querySelector('.top');
  const themeSel = top.querySelector('select.theme');
  if (isFile) {
    const b = document.createElement('button'); b.className = 'app-open'; b.title = 'Open this file in the MdReader desktop app'; b.textContent = 'Open in app';
    b.onclick = () => { location.href = 'mdreader://open?path=' + encodeURIComponent(disp.path); };
    top.insertBefore(b, themeSel);
  }
  const raw = document.createElement('button'); raw.className = 'icon'; raw.title = 'Show raw text (disable MdReader on this page)'; raw.innerHTML = '&lt;/&gt;';
  raw.onclick = () => { document.documentElement.innerHTML = ''; const p = document.createElement('pre'); p.style.cssText = 'white-space:pre-wrap;word-wrap:break-word;font:13px ui-monospace,Menlo,monospace;padding:16px'; p.textContent = shell.state.text; document.body.appendChild(p); };
  top.insertBefore(raw, themeSel);

  // If a handle for this file is remembered, refresh from it (picks up edits made elsewhere).
  if (isFile) {
    const h = await MdExt.handles.get('url:' + href);
    if (h && (await h.queryPermission({ mode: 'read' })) === 'granted') {
      try { const f = await h.getFile(); const t = await f.text(); if (t !== text) shell.setText(t, href); } catch {}
    }
  }
  addEventListener('beforeunload', (e) => { if (shell.state.dirty) { e.preventDefault(); e.returnValue = ''; } });
})();
