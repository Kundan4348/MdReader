// Shared host glue for the extension (content script on a .md page, and the viewer page).
// Provides: theme/pref storage, stylesheet loading, File System Access save flow, IndexedDB handle store.
(function (global) {
  const CSS = ['core/fonts/fonts.css', 'core/shell.css', 'core/themes/paper.css', 'core/themes/studio.css', 'core/themes/sections.css', 'core/themes/mono.css'];

  async function injectStyles(extra = []) {
    for (const f of [...CSS, ...extra]) {
      const url = chrome.runtime.getURL(f);
      let css;
      try { css = await (await fetch(url)).text(); } catch (e) { console.warn('[MdReader] could not load', f, e); continue; }
      // Inline the CSS text (works even where the page's CSP blocks <link>), rewriting relative url()s.
      css = css.replace(/url\((['"]?)(?!data:|https?:|chrome-extension:)([^'")]+)\1\)/g, (_, q, rel) => `url(${new URL(rel, url).href})`);
      const st = document.createElement('style'); st.dataset.mdreader = f; st.textContent = css;
      document.head.appendChild(st);
    }
  }

  const prefs = {
    get: (k) => new Promise((r) => chrome.storage.sync.get(k, (o) => r(o[k]))),
    set: (k, v) => chrome.storage.sync.set({ [k]: v }),
  };

  // ---- handle store (IndexedDB) ----
  function idb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('mdreader', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('handles');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  }
  const handles = {
    async get(key) { const db = await idb(); return new Promise((res) => { const t = db.transaction('handles').objectStore('handles').get(key); t.onsuccess = () => res(t.result); t.onerror = () => res(undefined); }); },
    async set(key, h) { const db = await idb(); return new Promise((res) => { const t = db.transaction('handles', 'readwrite').objectStore('handles').put(h, key); t.onsuccess = () => res(); t.onerror = () => res(); }); },
    async all() { const db = await idb(); return new Promise((res) => { const s = db.transaction('handles').objectStore('handles'); const keys = s.getAllKeys(), vals = s.getAll(); vals.onsuccess = () => keys.onsuccess = () => res(keys.result.map((k, i) => ({ key: k, handle: vals.result[i] }))); }); },
    async del(key) { const db = await idb(); return new Promise((res) => { const t = db.transaction('handles', 'readwrite').objectStore('handles').delete(key); t.onsuccess = () => res(); t.onerror = () => res(); }); },
  };

  async function ensureWritable(handle) {
    if (!handle) return false;
    if ((await handle.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
    return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
  }
  async function writeHandle(handle, text) {
    const w = await handle.createWritable();
    await w.write(text); await w.close();
  }

  // Save flow for a page whose file we do not yet hold a handle for (file:// content script):
  // 1st time: ask the user to pick the same file (we verify the name), remember the handle.
  async function saveViaPicker(key, expectedName, text, flash) {
    if (!global.showOpenFilePicker) throw new Error('File System Access API unavailable here. Use “Open in MdReader”.');
    let h = await handles.get(key);
    if (h && !(await ensureWritable(h))) h = null;
    if (!h) {
      flash && flash('Pick the same file once to allow saving…', 3500);
      const [picked] = await global.showOpenFilePicker({ types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown', '.mdown', '.mkd', '.txt'], 'application/json': ['.json'] } }], multiple: false });
      if (expectedName && picked.name !== expectedName && !confirm(`You picked “${picked.name}” but this page is “${expectedName}”. Save into “${picked.name}” anyway?`)) throw new Error('cancelled');
      if (!(await ensureWritable(picked))) throw new Error('write permission denied');
      h = picked; await handles.set(key, h);
    }
    await writeHandle(h, text);
    return h;
  }

  function displayFromUrl(href) {
    let p;
    try { const u = new URL(href); p = u.protocol === 'file:' ? decodeURIComponent(u.pathname) : u.host + decodeURIComponent(u.pathname); } catch { p = href; }
    let parts = p.split('/').filter(Boolean);
    const ui = parts.indexOf('Users'); if (ui === 0 && parts.length > 2) parts = parts.slice(2); // /Users/<name>/...
    return { crumbs: parts.slice(0, -1), name: parts[parts.length - 1] || p, dir: '' , path: p };
  }

  global.MdExt = { injectStyles, prefs, handles, ensureWritable, writeHandle, saveViaPicker, displayFromUrl };
})(window);
