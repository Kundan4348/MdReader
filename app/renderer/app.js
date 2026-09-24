// Renderer bootstrap: adapts the Electron bridge to the shell's adapter interface.
const api = window.mdreader;
const home = api.home || '';
const app = document.getElementById('app');
const empty = document.getElementById('empty');
if (api.platform === 'darwin') document.body.classList.add('mac');
const showEmpty = (on) => { empty.style.display = on ? 'flex' : 'none'; app.style.visibility = on ? 'hidden' : 'visible'; };

const adapter = {
  readFile: api.readFile,
  writeFile: api.writeFile,
  canSave: () => true,
  listDir: api.listDir,
  openDialog: api.openDialog,
  getPref: api.getPref,
  setPref: api.setPref,
  openExternal: api.openExternal,
  onExternalChange: api.onExternalChange,
  onDirty: api.setDirty,
  onTabsChanged: (st) => { api.tabsChanged(st); if (st.dirty.length) showEmpty(false); }, // dirty has one entry per tab, untitled included
  confirmDiscard: api.confirmDiscard,
  onLastTabClosed: () => showEmpty(true),
  displayPath(p) {
    const dir = p.slice(0, p.lastIndexOf('/')) || '/';
    const inHome = home && p.startsWith(home + '/');
    const rel = inHome ? p.slice(home.length + 1) : p;
    const parts = rel.split('/').filter(Boolean);
    const folders = parts.slice(0, -1);
    // One absolute folder path per crumb so the shell can re-root the Files tree there; '~' stands for home.
    const base = inHome ? home : '';
    const crumbPaths = folders.map((_, i) => base + '/' + folders.slice(0, i + 1).join('/'));
    return {
      crumbs: inHome ? ['~', ...folders] : folders,
      crumbPaths: inHome ? [home, ...crumbPaths] : crumbPaths,
      name: parts[parts.length - 1] || p,
      dir,
    };
  },
  reveal: (p) => p && api.reveal(p),
  openPath: (p) => p && api.openPath(p),
  statPath: api.statPath,
  home,
};

const shell = MdShell.mount(app, adapter);
app.classList.add('always-tabs');
showEmpty(true);

// Opens are serialised so several files handed over at once (a restored session, Finder multi-select) land as
// tabs in the order they were sent and the LAST one ends up focused, instead of read-completion order.
let opening = Promise.resolve();
function open(p) { opening = opening.then(() => shell.loadFile(p)).then(() => showEmpty(false), (e) => console.warn(e)); return opening; }
api.onOpenFile(open);
document.getElementById('emptyOpen').onclick = async () => { const p = await api.openDialog(); if (p) open(p); };
document.getElementById('emptyNew').onclick = () => { shell.newTab(); showEmpty(false); };
const isUntitled = (p) => !p || /^untitled:/.test(p);

api.onCmd(async (cmd) => {
  const S = shell.state;
  if (cmd === 'save') shell.save();
  else if (cmd === 'new-tab') { shell.newTab(); showEmpty(false); }
  else if (cmd === 'save-all-and-close') { try { await shell.saveAll(); api.closeWindow(); } catch (e) { console.warn(e); } }
  else if (cmd === 'close-tab') { if (shell.state.tabs.length) shell.closeTab(); else api.closeWindow(); }
  else if (cmd === 'tab:next') shell.nextTab(1);
  else if (cmd === 'tab:prev') shell.nextTab(-1);
  else if (cmd === 'open') { const p = await api.openDialog(); if (p) open(p); }
  else if (cmd === 'reveal') { if (!isUntitled(S.path)) api.reveal(S.path); }
  else if (cmd === 'toggle-edit') shell.setMode(S.mode === 'read' ? 'edit' : 'read');
  else if (cmd.startsWith('mode:')) shell.setMode(cmd.slice(5));
  else if (cmd === 'theme:next') { const i = MdShell.THEMES.findIndex((t) => t.id === S.theme); shell.setTheme(MdShell.THEMES[(i + 1) % MdShell.THEMES.length].id); }
  else if (cmd.startsWith('theme:')) shell.setTheme(cmd.slice(6));
  else if (cmd === 'zoom:+') shell.stepZoom(1);
  else if (cmd === 'zoom:-') shell.stepZoom(-1);
  else if (cmd === 'zoom:0') shell.resetZoom();
  else if (cmd === 'width:next') shell.cycleWidth();
  else if (cmd.startsWith('panel:')) { const p = cmd.slice(6); const btn = document.querySelector('.' + p + '-toggle'); btn && btn.click(); }
});

// Drag & drop a file anywhere in the window.
addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dropping'); });
addEventListener('dragleave', () => document.body.classList.remove('dropping'));
addEventListener('drop', (e) => {
  e.preventDefault(); document.body.classList.remove('dropping');
  const f = e.dataTransfer.files[0]; if (!f) return;
  const p = api.pathForFile(f); if (p && /\.(md|markdown|mdown|mkd|txt|json)$/i.test(p)) open(p);
});
// Block the browser's own ⌘R etc. from reloading while editing is fine; nothing to do.
