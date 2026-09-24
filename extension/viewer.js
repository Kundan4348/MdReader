// Viewer page: full editor backed by File System Access handles (persisted in IndexedDB as "recent").
(async () => {
  let current = null; // { key, handle, name }
  const open = new Map(); // key -> handle (one per tab)
  const hFor = (key) => open.get(key) || (current && current.key === key ? current.handle : null);
  const adapter = {
    readFile: async (key) => { const h = hFor(key); if (!h) throw new Error('no handle'); const f = await h.getFile(); return f.text(); },
    canSave: () => !!window.showSaveFilePicker,
    // key null = an untitled tab: ask where to save, register the handle under a new key and return it so the tab
    // adopts it. Never fall back to the current file's handle for an untitled tab.
    async writeFile(key, text) {
      let h = key ? hFor(key) : null;
      let newKey = null;
      if (!h) {
        h = await window.showSaveFilePicker({ suggestedName: 'untitled.md', types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md'] } }] });
        newKey = 'h:' + h.name + ':' + Date.now();
        open.set(newKey, h); await MdExt.handles.set(newKey, h);
        current = { key: newKey, handle: h, name: h.name };
      }
      if (!(await MdExt.ensureWritable(h))) throw new Error('write permission denied');
      await MdExt.writeHandle(h, text);
      renderRecent();
      return newKey || key;
    },
    openDialog: async () => { await pick(); return null; },
    getPref: MdExt.prefs.get,
    setPref: (k, v) => { if (k !== 'files') MdExt.prefs.set(k, v); },
    displayPath: (key) => ({ crumbs: [], name: (hFor(key) || {}).name || (current ? current.name : 'untitled.md'), dir: '' }),
    onTabsChanged: ({ paths, active }) => { for (const k of [...open.keys()]) if (!paths.includes(k)) open.delete(k); if (active && open.has(active)) { current = { key: active, handle: open.get(active), name: open.get(active).name }; document.title = current.name; history.replaceState(null, '', '#' + encodeURIComponent(active)); } },
    onLastTabClosed: () => { current = null; document.body.classList.remove('has-doc'); document.title = 'MdReader'; history.replaceState(null, '', ' '); },
    openExternal: (u) => window.open(u, '_blank', 'noopener'),
    openPath: (p) => { location.href = 'mdreader://open?path=' + encodeURIComponent(p); }, // desktop app decides: tab or OS
  };
  const shell = MdShell.mount(document.getElementById('app'), adapter);
  document.getElementById('app').classList.add('no-files', 'always-tabs');

  async function openHandle(key, h) {
    if ((await h.queryPermission({ mode: 'read' })) !== 'granted' && (await h.requestPermission({ mode: 'read' })) !== 'granted') return;
    current = { key, handle: h, name: h.name }; open.set(key, h);
    await shell.loadFile(key);
    document.body.classList.add('has-doc');
    document.title = h.name;
    history.replaceState(null, '', '#' + encodeURIComponent(key));
  }
  async function pick() {
    try {
      const [h] = await window.showOpenFilePicker({ types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown', '.mdown', '.mkd', '.txt'] } }] });
      const key = 'h:' + h.name + ':' + Date.now();
      // de-dupe against recents pointing at the same file
      for (const r of await MdExt.handles.all()) if (r.handle && typeof r.handle.isSameEntry === 'function' && (await r.handle.isSameEntry(h))) { await MdExt.handles.del(r.key); }
      await MdExt.handles.set(key, h);
      await openHandle(key, h);
      renderRecent();
    } catch (e) { if (e && e.name !== 'AbortError') console.warn(e); }
  }
  async function renderRecent() {
    const el = document.getElementById('recent');
    const all = (await MdExt.handles.all()).filter((r) => r.key.startsWith('h:')).sort((a, b) => (b.key.split(':').pop() - a.key.split(':').pop())).slice(0, 12);
    if (!all.length) return;
    el.replaceChildren(...all.map((r) => {
      const b = document.createElement('button'); b.innerHTML = `<b>${MD.esc(r.handle.name)}</b><span>${new Date(+r.key.split(':').pop()).toLocaleDateString()}</span>`;
      b.onclick = () => openHandle(r.key, r.handle); return b;
    }));
  }
  document.getElementById('pick').onclick = pick;
  document.getElementById('theme').onclick = () => { const i = MdShell.THEMES.findIndex((t) => t.id === document.documentElement.dataset.theme); shell.setTheme(MdShell.THEMES[(i + 1) % MdShell.THEMES.length].id); };
  renderRecent();

  // Re-open the last file if we came back to a hash.
  const key = location.hash && decodeURIComponent(location.hash.slice(1));
  if (key) { const h = await MdExt.handles.get(key); if (h) openHandle(key, h); }
  addEventListener('beforeunload', (e) => { if (shell.state.dirty) { e.preventDefault(); e.returnValue = ''; } });
})();
