// MdReader -- Electron main process.
// One window per document. Registered as an opener for .md files and for the mdreader:// scheme
// (used by the Chrome extension's "Open in MdReader" button).
const { app, BrowserWindow, ipcMain, dialog, Menu, shell, nativeTheme } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const isMac = process.platform === 'darwin';
// Test runs (they always attach a debugger, or set MDR_TEST_HIDE) keep their windows minimised and never take focus,
// so a build does not throw windows in front of whatever the user is doing.
const TEST_HIDE = !!process.env.MDR_TEST_HIDE || app.commandLine.hasSwitch('remote-debugging-port');
const focusWin = (w) => { if (!TEST_HIDE) w.focus(); };
// Test runs never hand anything to macOS (a .css link click opened Firefox): the request is logged to MDR_OPEN_LOG
// when set, else dropped. Returns true when the caller must stop.
const testSink = (what) => { if (!TEST_HIDE && !process.env.MDR_OPEN_LOG) return false; if (process.env.MDR_OPEN_LOG) { try { fs.appendFileSync(process.env.MDR_OPEN_LOG, what + '\n'); } catch {} } return true; };
if (TEST_HIDE && isMac && app.dock) app.dock.hide(); // no Dock icon, no app activation
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
  if (/\.(md|markdown|mdown|mkd|txt|json|sql|hql|psql|mmd|mermaid)$/i.test(arg) && !arg.startsWith('-')) return path.resolve(arg);
  return null;
}

function createWindow(filePath) {
  // Reuse an untouched empty window if one exists.
  for (const e of wins.values()) if (!e.paths.size && !e.dirty) { focusWin(e.win); return openInWindow(e.win, filePath); }
  const win = new BrowserWindow({
    width: prefs.winW || 1280, height: prefs.winH || 860, minWidth: 640, minHeight: 400,
    titleBarStyle: isMac ? 'hiddenInset' : 'default', trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: { paper: '#f7f3ec', studio: '#0f1216', sections: '#eef2f6', mono: '#f9f8f4' }[prefs.theme] || '#f9f8f4',
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true, backgroundThrottling: !TEST_HIDE },
  });
  const entry = { win, paths: new Set(), active: null, dirty: false, watchers: new Map(), dirWatchers: new Map(), loaded: false, queue: [] };
  wins.set(win.id, entry);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => { if (TEST_HIDE) { win.showInactive(); win.minimize(); } else win.show(); });
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
  win.on('closed', () => { const en = wins.get(win.id); if (en) { for (const w of en.watchers.values()) w.close(); for (const w of en.dirWatchers.values()) w.close(); } wins.delete(win.id); });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url) && !testSink('external ' + url)) shell.openExternal(url); return { action: 'deny' }; });
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
  // our own recent list (the Files pane shows it; the macOS one under File > Open Recent is not readable from the app)
  prefs.recent = [filePath, ...(prefs.recent || []).filter((p) => p !== filePath)].slice(0, 60); savePrefs();
}
function watch(en, p) {
  if (en.watchers.has(p)) return;
  try { en.watchers.set(p, fs.watch(p, { persistent: false }, () => setTimeout(() => !en.win.isDestroyed() && en.win.webContents.send('external-change', p), 120))); } catch {}
}
function unwatch(en, p) { const w = en.watchers.get(p); if (w) { w.close(); en.watchers.delete(p); } }
// Folders shown in the Files pane. The renderer sends the full list whenever it changes; a change inside one of
// them (file created, deleted, renamed) is reported after a short debounce so a burst of writes refreshes once.
function watchDirs(en, dirs) {
  const want = new Set((Array.isArray(dirs) ? dirs : []).filter((d) => typeof d === 'string' && path.isAbsolute(d)).slice(0, 64));
  for (const [d, w] of en.dirWatchers) if (!want.has(d)) { w.close(); clearTimeout(w.mdrTimer); en.dirWatchers.delete(d); }
  for (const d of want) {
    if (en.dirWatchers.has(d)) continue;
    try {
      const w = fs.watch(d, { persistent: false }, () => {
        clearTimeout(w.mdrTimer);
        w.mdrTimer = setTimeout(() => !en.win.isDestroyed() && en.win.webContents.send('dir-change', d), 250);
      });
      w.on('error', () => { w.close(); en.dirWatchers.delete(d); });
      en.dirWatchers.set(d, w);
    } catch { /* unreadable or gone: the focus refresh still covers it */ }
  }
}

const isMarkdownPath = (p) => /\.(md|markdown|mdown|mkd|txt|json|sql|hql|psql|mmd|mermaid)$/i.test(p);
// Anything that is not a markdown/text document (a .py, .csv, a folder) is handed to the OS: default app for files,
// Finder for folders. Falls back to revealing the item when no app claims it.
async function openOther(p) {
  if (testSink(p)) return;
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
  for (const e of wins.values()) if (e.paths.has(p)) { focusWin(e.win); return openInWindow(e.win, p); }
  // Otherwise open as a new tab in the focused window (or the most recent one). Only the very first open creates a window.
  const focused = BrowserWindow.getFocusedWindow();
  const target = (focused && wins.get(focused.id)) || [...wins.values()].pop();
  if (target) { focusWin(target.win); return openInWindow(target.win, p); }
  createWindow(p);
}

// macOS: Finder double-click / "Open With" / drag onto Dock icon
app.on('open-file', (e, p) => { e.preventDefault(); openPath(p); });
app.on('open-url', (e, url) => { e.preventDefault(); openPath(pathFromArg(url)); });

// Single instance so a second launch (from Finder or the mdreader:// scheme) routes here.
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', (e, argv) => { const p = argv.map(pathFromArg).filter(Boolean).pop(); if (p) openPath(p); else if (wins.size) focusWin([...wins.values()][0].win); });
if (!app.isDefaultProtocolClient('mdreader')) app.setAsDefaultProtocolClient('mdreader');

// ---------- IPC ----------
const home = app.getPath('home');
ipcMain.handle('read-file', (e, p) => fsp.readFile(p, 'utf8'));
ipcMain.handle('write-file', async (e, p, text, hint) => {
  if (!p) {
    // Untitled tab: the shell hints the extension its content calls for (json for pasted JSON, md otherwise).
    const json = hint && hint.ext === 'json', sql = hint && hint.ext === 'sql', mmd = hint && hint.ext === 'mmd';
    const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), {
      filters: json ? [{ name: 'JSON', extensions: ['json'] }, { name: 'Markdown', extensions: ['md'] }] : sql ? [{ name: 'SQL', extensions: ['sql'] }, { name: 'Markdown', extensions: ['md'] }] : mmd ? [{ name: 'Mermaid diagram', extensions: ['mmd'] }, { name: 'Markdown', extensions: ['md'] }] : [{ name: 'Markdown', extensions: ['md'] }, { name: 'JSON', extensions: ['json'] }, { name: 'SQL', extensions: ['sql'] }, { name: 'Mermaid diagram', extensions: ['mmd'] }],
      defaultPath: path.join(home, 'Documents', json ? 'untitled.json' : sql ? 'untitled.sql' : mmd ? 'untitled.mmd' : 'untitled.md') });
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
// A pasted picture is saved in a folder next to the document (notes.md -> notes-images/pasted-20261014-225340.png)
// and the shell links it with a relative path, so the .md and its pictures move together. Never overwrites a file.
const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
ipcMain.handle('save-image', async (e, docPath, bytes, type) => {
  const ext = IMAGE_EXT[type];
  if (!ext) throw new Error('not a PNG, JPEG, GIF or WebP picture');
  if (typeof docPath !== 'string' || !path.isAbsolute(docPath) || !/\.(md|markdown|mdown|mkd|txt)$/i.test(docPath)) throw new Error('save the file first');
  const buf = Buffer.from(bytes || []);
  if (!buf.length) throw new Error('the picture is empty');
  if (buf.length > 50 * 1024 * 1024) throw new Error('the picture is over 50 MB');
  const base = path.basename(docPath).replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '-').replace(/^[-.]+|-+$/g, '') || 'doc';
  const dirName = base + '-images', dir = path.join(path.dirname(docPath), dirName);
  await fsp.mkdir(dir, { recursive: true });
  const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  for (let i = 0; i < 100; i++) {
    const name = `pasted-${stamp}${i ? '-' + (i + 1) : ''}.${ext}`;
    try { await fsp.writeFile(path.join(dir, name), buf, { flag: 'wx' }); return dirName + '/' + name; } catch (err) { if (err.code !== 'EEXIST') throw err; }
  }
  throw new Error('too many pictures with the same time');
});
// Comments live in a small file next to the document: notes.md -> notes.md.mdr-comments.json. It travels with the
// folder (git, a shared drive), works the same for .md, .json and .sql, and never touches the document itself.
const commentsPath = (p) => p + '.mdr-comments.json';
ipcMain.handle('comments-read', async (e, p) => {
  try { return JSON.parse(await fsp.readFile(commentsPath(p), 'utf8')); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
});
ipcMain.handle('comments-write', async (e, p, data) => {
  const f = commentsPath(p);
  if (!data || ((!data.comments || !data.comments.length) && !data.pippin)) { await fsp.rm(f, { force: true }); return null; } // nothing left to keep: no empty file left behind
  const tmp = f + '.tmp-' + process.pid;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  await fsp.rename(tmp, f); // atomic: a reader never sees half a file
  return f;
});
// Pippin: create a doc from a file, link it, and sync comments (app/pippin.js runs pippin-mcp-server).
const pippin = require('./pippin');
ipcMain.handle('pippin', async (e, op, args) => {
  try { return { ok: true, value: await pippin.handle(op, args, TEST_HIDE && !process.env.MDR_PIPPIN_CMD) }; }
  catch (err) { return { ok: false, error: String(err && err.message || err) }; }
});
app.on('will-quit', () => pippin.stop());
// Who is commenting: the Mac login is the id (it decides who may edit a comment), the full name is what others see.
let me = null;
ipcMain.on('whoami', (e) => {
  if (!me) {
    const os = require('os'); const id = os.userInfo().username; let name = id;
    if (process.env.MDR_TEST_USER) name = process.env.MDR_TEST_USER;
    else if (isMac) { try { name = require('child_process').execFileSync('id', ['-F'], { encoding: 'utf8', timeout: 2000 }).trim() || id; } catch {} }
    me = { id: process.env.MDR_TEST_USER_ID || id, name };
  }
  e.returnValue = me;
});
ipcMain.handle('list-dir', async (e, dir) => {
  const ents = await fsp.readdir(dir, { withFileTypes: true });
  return ents.map((d) => ({ name: d.name, path: path.join(dir, d.name), dir: d.isDirectory() }));
});
ipcMain.handle('open-dialog', async (e) => {
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { properties: ['openFile'], filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'txt', 'json', 'sql', 'mmd', 'mermaid'] }] });
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
ipcMain.on('open-external', (e, url) => { if (/^https?:/.test(url) && !testSink('external ' + url)) shell.openExternal(url); });
ipcMain.on('close-window', (e) => { const w = BrowserWindow.fromWebContents(e.sender); const en = wins.get(w.id); if (en) en.dirty = false; w.close(); });
ipcMain.on('reveal', (e, p) => { if (!p) return; if (testSink('reveal ' + p)) return; shell.showItemInFolder(p); });
ipcMain.handle('get-recent', () => { const ok = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }; return { files: (prefs.recent || []).filter(ok), lastSession: (prefs.lastSession && prefs.lastSession.paths || []).filter(ok) }; });
ipcMain.on('open-path', (e, p) => { if (p) openOther(p); });
ipcMain.on('watch-dirs', (e, dirs) => { const w = BrowserWindow.fromWebContents(e.sender); const en = w && wins.get(w.id); if (en) watchDirs(en, dirs); });
ipcMain.handle('stat-path', async (e, p) => { try { const st = await fsp.stat(p); return { exists: true, dir: st.isDirectory() }; } catch { return { exists: false, dir: false }; } });
// Renderer reports its tab set after every change; main mirrors it into watchers, title-bar proxy icon and dirty state.
ipcMain.on('tabs', (e, { paths, active, dirty }) => {
  const w = BrowserWindow.fromWebContents(e.sender); const en = w && wins.get(w.id); if (!en) return;
  const next = new Set(paths);
  for (const p of en.paths) if (!next.has(p)) unwatch(en, p);
  for (const p of next) watch(en, p);
  en.paths = next; en.active = active || null;
  en.dirty = dirty.some(Boolean); w.setDocumentEdited(en.dirty);
  // The saved session is the union over ALL windows (one window reporting an empty set must not wipe the others'),
  // and the last non-empty set is kept as lastSession so "Reopen Last Session" can bring it back after a loss.
  const union = [...new Set([...wins.values()].flatMap((x) => [...x.paths]))];
  if (!union.length && prefs.session && prefs.session.paths && prefs.session.paths.length) prefs.lastSession = { paths: prefs.session.paths, active: prefs.session.active, at: Date.now() };
  prefs.session = { paths: union, active: active || prefs.session && prefs.session.active || null }; savePrefs();
  w.setRepresentedFilename(active || '');
});
ipcMain.handle('confirm-discard', (e, name) => {
  const r = dialog.showMessageBoxSync(BrowserWindow.fromWebContents(e.sender), { type: 'warning', buttons: ['Save', "Don't Save", 'Cancel'], defaultId: 0, cancelId: 2, message: `Save changes to ${name}?`, detail: 'Your changes will be lost if you close this tab without saving.' });
  return ['save', 'discard', 'cancel'][r];
});

// ---------- menu ----------
function send(cmd) { const w = BrowserWindow.getFocusedWindow(); if (w) w.webContents.send('cmd', cmd); else if (cmd === 'open') openDialogNew(); else if (cmd === 'new-tab') { const nw = createWindow(null); nw.webContents.once('did-finish-load', () => nw.webContents.send('cmd', 'new-tab')); } }
async function openDialogNew() {
  const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'txt', 'json', 'sql', 'mmd', 'mermaid'] }] });
  if (!r.canceled) openPath(r.filePaths[0]);
}
function buildMenu() {
  const tpl = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [
      { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => createWindow(null) },
      { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => send('new-tab') },
      { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => send('open') },
      { role: 'recentDocuments', submenu: [{ role: 'clearRecentDocuments' }] },
      { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: () => send('reopen-closed') },
      { label: 'Reopen Last Session', click: () => { const ps = (prefs.lastSession && prefs.lastSession.paths || []).filter((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }); if (!ps.length) return dialog.showMessageBox({ message: 'No earlier session to reopen.' }); ps.forEach((p) => openPath(p)); } },
      { label: 'Recently Opened (Files pane)', click: () => send('show-recent') },
      { type: 'separator' },
      { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
      { label: 'Reveal in Finder', accelerator: 'CmdOrCtrl+Shift+R', click: () => send('reveal') },
      { type: 'separator' },
      { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => send('close-tab') },
      { label: 'Close Window', accelerator: 'CmdOrCtrl+Alt+W', role: 'close' },
    ] },
    { label: 'Edit', submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' }, { role: 'delete' }, { role: 'selectAll' },
      { type: 'separator' },
      { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: () => send('find') },
      { label: 'Find Next', accelerator: 'CmdOrCtrl+G', click: () => send('find:next') },
      { label: 'Find Previous', accelerator: 'CmdOrCtrl+Shift+G', click: () => send('find:prev') },
      { type: 'separator' },
      { label: 'Compare JSON…', accelerator: 'CmdOrCtrl+Shift+D', click: () => send('compare') },
      { label: 'Show / Hide Text Colours', accelerator: 'CmdOrCtrl+Shift+H', click: () => send('textcolours') },
      { label: 'Draw on the Page', accelerator: 'CmdOrCtrl+Shift+E', click: () => send('draw') },
      ...(isMac ? [{ type: 'separator' }, { role: 'startSpeaking' }, { role: 'stopSpeaking' }] : []),
    ] },
    { label: 'View', submenu: [
      { label: 'Read', accelerator: 'CmdOrCtrl+1', click: () => send('mode:read') },
      { label: 'Edit', accelerator: 'CmdOrCtrl+2', click: () => send('mode:edit') },
      { label: 'Split', accelerator: 'CmdOrCtrl+3', click: () => send('mode:split') },
      { label: 'Write (edit the page)', accelerator: 'CmdOrCtrl+4', click: () => send('mode:write') },
      { label: 'Toggle Edit', accelerator: 'CmdOrCtrl+E', click: () => send('toggle-edit') },
      { type: 'separator' },
      { label: 'Theme', submenu: [
        { label: 'Paper', click: () => send('theme:paper') },
        { label: 'Studio', click: () => send('theme:studio') },
        { label: 'Sections', click: () => send('theme:sections') },
        { label: 'Mono', click: () => send('theme:mono') },
        { label: 'Lumen', click: () => send('theme:lumen') },
        { label: 'Next Theme', accelerator: 'CmdOrCtrl+Shift+Y', click: () => send('theme:next') },
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
  // Tabs open at the last quit come back in their saved order (files that vanished meanwhile are dropped). The LAST
  // path opened ends up focused, so the active tab is opened once more at the end (an open tab is only focused, not
  // duplicated) -- unless a file was actually asked for now, which wins.
  const sess = prefs.session || {};
  const restore = (sess.paths || []).filter((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  const asked = [...pendingOpens, ...argPaths];
  const all = [...new Set([...restore, ...asked])];
  if (!asked.length && restore.includes(sess.active) && all[all.length - 1] !== sess.active) all.push(sess.active);
  if (all.length) all.forEach((p) => openPath(p)); else createWindow(null);
  app.on('activate', () => { if (!wins.size) createWindow(null); });
});
app.on('window-all-closed', () => { if (!isMac) app.quit(); });
