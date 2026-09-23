// MdReader -- Electron main process.
// One window per document. Registered as an opener for .md files and for the mdreader:// scheme
// (used by the Chrome extension's "Open in MdReader" button).
const { app, BrowserWindow, ipcMain, dialog, Menu, shell, nativeTheme } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const isMac = process.platform === 'darwin';
const wins = new Map(); // id -> { win, paths:Set, active, dirty, watchers:Map<path,FSWatcher> }
const pendingOpens = [];
let ready = false;

const prefsFile = () => path.join(app.getPath('userData'), 'prefs.json');
let prefs = {};
try { prefs = JSON.parse(fs.readFileSync(prefsFile(), 'utf8')); } catch { prefs = {}; }
const savePrefs = () => fs.writeFile(prefsFile(), JSON.stringify(prefs, null, 2), () => {});

function pathFromArg(arg) {
  if (!arg) return null;
  if (arg.startsWith('mdreader://')) {
    try { const u = new URL(arg); return decodeURIComponent(u.searchParams.get('path') || u.pathname); } catch { return null; }
  }
  if (arg.startsWith('file://')) { try { return decodeURIComponent(new URL(arg).pathname); } catch { return null; } }
  if (/\.(md|markdown|mdown|mkd|txt)$/i.test(arg) && !arg.startsWith('-')) return path.resolve(arg);
  return null;
}

function createWindow(filePath) {
  // Reuse an untouched empty window if one exists.
  for (const e of wins.values()) if (!e.paths.size && !e.dirty) { e.win.focus(); return openInWindow(e.win, filePath); }
  const win = new BrowserWindow({
    width: prefs.winW || 1280, height: prefs.winH || 860, minWidth: 640, minHeight: 400,
    titleBarStyle: isMac ? 'hiddenInset' : 'default', trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: { paper: '#f7f3ec', studio: '#0f1216', sections: '#eef2f6', mono: '#f9f8f4' }[prefs.theme] || '#f9f8f4',
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true },
  });
  const entry = { win, paths: new Set(), active: null, dirty: false, watchers: new Map(), loaded: false, queue: [] };
  wins.set(win.id, entry);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-finish-load', () => { entry.loaded = true; const q = [filePath, ...entry.queue].filter(Boolean); entry.queue = []; q.forEach((p) => openInWindow(win, p)); });
  win.on('resize', () => { const [w, h] = win.getSize(); prefs.winW = w; prefs.winH = h; savePrefs(); });
  win.on('close', (e) => {
    const en = wins.get(win.id);
    if (en && en.dirty) {
      const r = dialog.showMessageBoxSync(win, { type: 'warning', buttons: ['Save All', "Don't Save", 'Cancel'], defaultId: 0, cancelId: 2, message: 'Some tabs have unsaved changes.', detail: 'Save them before closing the window?' });
      if (r === 2) { e.preventDefault(); return; }
      if (r === 0) { e.preventDefault(); win.webContents.send('cmd', 'save-all-and-close'); return; }
    }
  });
  win.on('closed', () => { const en = wins.get(win.id); if (en) for (const w of en.watchers.values()) w.close(); wins.delete(win.id); });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  // The window only ever shows renderer/index.html. Any navigation (dropped file, relative link, file:// href) is cancelled;
  // markdown targets are routed through openPath instead.
  win.webContents.on('will-navigate', (e, url) => { e.preventDefault(); const p = pathFromArg(url); if (p) openPath(p); });
  return win;
}

function openInWindow(win, filePath) {
  const en = wins.get(win.id);
  if (!en) return;
  if (!en.loaded) { en.queue.push(filePath); return; } // renderer not up yet: flushed on did-finish-load
  win.webContents.send('open-file', filePath); // renderer opens it as a tab and reports back via 'tabs'
  app.addRecentDocument(filePath);
}
function watch(en, p) {
  if (en.watchers.has(p)) return;
  try { en.watchers.set(p, fs.watch(p, { persistent: false }, () => setTimeout(() => !en.win.isDestroyed() && en.win.webContents.send('external-change', p), 120))); } catch {}
}
function unwatch(en, p) { const w = en.watchers.get(p); if (w) { w.close(); en.watchers.delete(p); } }

const isMarkdownPath = (p) => /\.(md|markdown|mdown|mkd|txt)$/i.test(p);
// Anything that is not a markdown/text document (a .py, .csv, a folder) is handed to the OS: default app for files,
// Finder for folders. Falls back to revealing the item when no app claims it.
async function openOther(p) {
  try {
    const st = await fsp.stat(p);
    if (st.isDirectory()) { shell.openPath(p); return; }
    const err = await shell.openPath(p);
    if (err) shell.showItemInFolder(p);
  } catch { /* missing: nothing to open */ }
}
function openPath(p) {
  if (!p) return;
  if (!ready) return pendingOpens.push(p);
  if (!isMarkdownPath(p)) return openOther(p);
  // Already open in some window? focus that tab.
  for (const e of wins.values()) if (e.paths.has(p)) { e.win.focus(); return openInWindow(e.win, p); }
  // Otherwise open as a new tab in the focused window (or the most recent one). Only the very first open creates a window.
  const focused = BrowserWindow.getFocusedWindow();
  const target = (focused && wins.get(focused.id)) || [...wins.values()].pop();
  if (target) { target.win.focus(); return openInWindow(target.win, p); }
  createWindow(p);
}

// macOS: Finder double-click / "Open With" / drag onto Dock icon
app.on('open-file', (e, p) => { e.preventDefault(); openPath(p); });
app.on('open-url', (e, url) => { e.preventDefault(); openPath(pathFromArg(url)); });

// Single instance so a second launch (from Finder or the mdreader:// scheme) routes here.
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', (e, argv) => { const p = argv.map(pathFromArg).filter(Boolean).pop(); if (p) openPath(p); else if (wins.size) [...wins.values()][0].win.focus(); });
if (!app.isDefaultProtocolClient('mdreader')) app.setAsDefaultProtocolClient('mdreader');

// ---------- IPC ----------
const home = app.getPath('home');
ipcMain.handle('read-file', (e, p) => fsp.readFile(p, 'utf8'));
ipcMain.handle('write-file', async (e, p, text) => {
  if (!p) {
    const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), { filters: [{ name: 'Markdown', extensions: ['md'] }], defaultPath: path.join(home, 'Documents', 'untitled.md') });
    if (r.canceled) throw new Error('cancelled');
    p = r.filePath;
  }
  const en = wins.get(BrowserWindow.fromWebContents(e.sender).id);
  // Pause our own watcher around the write so we don't reload the file we just saved.
  if (en) unwatch(en, p);
  await fsp.writeFile(p, text, 'utf8');
  if (en && en.paths.has(p)) setTimeout(() => watch(en, p), 200);
  return p;
});
ipcMain.handle('list-dir', async (e, dir) => {
  const ents = await fsp.readdir(dir, { withFileTypes: true });
  return ents.map((d) => ({ name: d.name, path: path.join(dir, d.name), dir: d.isDirectory() }));
});
ipcMain.handle('open-dialog', async (e) => {
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { properties: ['openFile'], filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'txt'] }] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('get-pref', (e, k) => prefs[k]);
ipcMain.handle('set-pref', (e, k, v) => { prefs[k] = v; savePrefs(); });
ipcMain.handle('display-path', (e, p) => {
  const rel = p.startsWith(home) ? p.slice(home.length + 1) : p;
  const parts = rel.split(path.sep).filter(Boolean);
  return { crumbs: parts.slice(0, -1), name: parts[parts.length - 1] || p, dir: path.dirname(p) };
});
ipcMain.on('get-home', (e) => { e.returnValue = home; });
ipcMain.on('dirty', (e, d) => { const w = BrowserWindow.fromWebContents(e.sender); const en = wins.get(w.id); if (en) { en.dirty = d; w.setDocumentEdited(d); } });
ipcMain.on('open-external', (e, url) => { if (/^https?:/.test(url)) shell.openExternal(url); });
ipcMain.on('close-window', (e) => { const w = BrowserWindow.fromWebContents(e.sender); const en = wins.get(w.id); if (en) en.dirty = false; w.close(); });
ipcMain.on('reveal', (e, p) => p && shell.showItemInFolder(p));
ipcMain.on('open-path', (e, p) => { if (p) openOther(p); });
ipcMain.handle('stat-path', async (e, p) => { try { const st = await fsp.stat(p); return { exists: true, dir: st.isDirectory() }; } catch { return { exists: false, dir: false }; } });
// Renderer reports its tab set after every change; main mirrors it into watchers, title-bar proxy icon and dirty state.
ipcMain.on('tabs', (e, { paths, active, dirty }) => {
  const w = BrowserWindow.fromWebContents(e.sender); const en = w && wins.get(w.id); if (!en) return;
  const next = new Set(paths);
  for (const p of en.paths) if (!next.has(p)) unwatch(en, p);
  for (const p of next) watch(en, p);
  en.paths = next; en.active = active || null;
  en.dirty = dirty.some(Boolean); w.setDocumentEdited(en.dirty);
  prefs.session = { paths, active: active || null }; savePrefs();
  w.setRepresentedFilename(active || '');
});
ipcMain.handle('confirm-discard', (e, name) => {
  const r = dialog.showMessageBoxSync(BrowserWindow.fromWebContents(e.sender), { type: 'warning', buttons: ['Save', "Don't Save", 'Cancel'], defaultId: 0, cancelId: 2, message: `Save changes to ${name}?`, detail: 'Your changes will be lost if you close this tab without saving.' });
  return ['save', 'discard', 'cancel'][r];
});

// ---------- menu ----------
function send(cmd) { const w = BrowserWindow.getFocusedWindow(); if (w) w.webContents.send('cmd', cmd); else if (cmd === 'open') openDialogNew(); }
async function openDialogNew() {
  const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'txt'] }] });
  if (!r.canceled) openPath(r.filePaths[0]);
}
function buildMenu() {
  const tpl = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [
      { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => createWindow(null) },
      { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => send('open') },
      { role: 'recentDocuments', submenu: [{ role: 'clearRecentDocuments' }] },
      { type: 'separator' },
      { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
      { label: 'Reveal in Finder', accelerator: 'CmdOrCtrl+Shift+R', click: () => send('reveal') },
      { type: 'separator' },
      { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => send('close-tab') },
      { label: 'Close Window', accelerator: 'CmdOrCtrl+Alt+W', role: 'close' },
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [
      { label: 'Read', accelerator: 'CmdOrCtrl+1', click: () => send('mode:read') },
      { label: 'Edit', accelerator: 'CmdOrCtrl+2', click: () => send('mode:edit') },
      { label: 'Split', accelerator: 'CmdOrCtrl+3', click: () => send('mode:split') },
      { label: 'Toggle Edit', accelerator: 'CmdOrCtrl+E', click: () => send('toggle-edit') },
      { type: 'separator' },
      { label: 'Theme', submenu: [
        { label: 'Paper', click: () => send('theme:paper') },
        { label: 'Studio', click: () => send('theme:studio') },
        { label: 'Sections', click: () => send('theme:sections') },
        { label: 'Mono', click: () => send('theme:mono') },
        { label: 'Next Theme', accelerator: 'CmdOrCtrl+Shift+T', click: () => send('theme:next') },
      ] },
      { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: () => send('tab:next') },
      { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: () => send('tab:prev') },
      { type: 'separator' },
      { label: 'Toggle Files', accelerator: 'CmdOrCtrl+\\', click: () => send('panel:files') },
      { label: 'Toggle Outline', accelerator: 'CmdOrCtrl+/', click: () => send('panel:outline') },
      { type: 'separator' },
      { type: 'separator' },
      { label: 'Larger Text', accelerator: 'CmdOrCtrl+=', click: () => send('zoom:+') },
      { label: 'Smaller Text', accelerator: 'CmdOrCtrl+-', click: () => send('zoom:-') },
      { label: 'Actual Text Size', accelerator: 'CmdOrCtrl+0', click: () => send('zoom:0') },
      { label: 'Cycle Reading Width', accelerator: 'CmdOrCtrl+Shift+W', click: () => send('width:next') },
      { type: 'separator' },
      { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' },
    ] },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

app.whenReady().then(() => {
  buildMenu();
  ready = true;
  const argPaths = process.argv.slice(1).map(pathFromArg).filter(Boolean);
  // Tabs open at the last quit come back (files that vanished meanwhile are dropped). The LAST path opened ends up
  // focused, so the tab that was active at quit goes last -- unless a file was actually asked for now, which wins.
  const sess = prefs.session || {};
  const restore = (sess.paths || []).filter((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  const asked = [...pendingOpens, ...argPaths];
  const order = asked.length
    ? [...restore, ...asked]
    : [...restore.filter((p) => p !== sess.active), ...(restore.includes(sess.active) ? [sess.active] : [])];
  const all = [...new Set(order)];
  if (all.length) all.forEach((p) => openPath(p)); else createWindow(null);
  app.on('activate', () => { if (!wins.size) createWindow(null); });
});
app.on('window-all-closed', () => { if (!isMac) app.quit(); });
