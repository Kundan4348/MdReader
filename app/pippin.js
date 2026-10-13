// Pippin bridge for the desktop app: runs the Builder Toolbox `pippin-mcp-server` (the same server the Kiro agents
// use) as a child process and talks MCP over its stdin/stdout. It authenticates with the user's own Midway session,
// so nothing here holds a credential. One process per app, started on first use, restarted if it dies.
// Test runs must point MDR_PIPPIN_CMD at a fake server: a test run never reaches the real Pippin.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const realCmd = () => path.join(os.homedir(), '.toolbox/bin/pippin-mcp-server');
let proc = null, buf = '', seq = 0, ready = null;
const pend = new Map();

function command(testMode) {
  if (process.env.MDR_PIPPIN_CMD) return process.env.MDR_PIPPIN_CMD.split(' ');
  if (testMode) return null;
  return [realCmd()];
}
function available(testMode) {
  const c = command(testMode); if (!c) return { ok: false, why: 'Pippin is switched off during test runs' };
  if (c[0] === 'node' || fs.existsSync(c[0])) return { ok: true };
  return { ok: false, why: 'pippin-mcp-server is not installed. In Terminal run: toolbox install aim && aim mcp install pippin-mcp' };
}
function start(testMode) {
  if (ready) return ready;
  const c = command(testMode); if (!c) return Promise.reject(new Error('Pippin is switched off during test runs'));
  ready = new Promise((resolve, reject) => {
    proc = spawn(c[0], c.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    let err = '';
    proc.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    proc.stdout.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id != null && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); clearTimeout(p.t); p.resolve(m); }
      }
    });
    const dead = (why) => { proc = null; ready = null; buf = ''; for (const [, p] of pend) { clearTimeout(p.t); p.reject(new Error(why)); } pend.clear(); };
    proc.on('error', (e) => { dead('Could not start pippin-mcp-server: ' + e.message); reject(e); });
    proc.on('exit', (code) => dead('pippin-mcp-server stopped' + (code ? ' (exit ' + code + ')' : '') + (err.trim() ? ': ' + err.trim().split('\n').pop().slice(0, 300) : '')));
    raw('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'MdReader', version: '1' } }, 60000)
      .then(() => { proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'); resolve(); }, (e) => { stop(); reject(e); });
  });
  return ready;
}
function raw(method, params, ms) {
  return new Promise((resolve, reject) => {
    if (!proc) return reject(new Error('pippin-mcp-server is not running'));
    const id = ++seq;
    const t = setTimeout(() => { pend.delete(id); reject(new Error('Pippin did not answer within ' + Math.round(ms / 1000) + ' s')); }, ms);
    pend.set(id, { resolve, reject, t });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
// Call one tool; returns its JSON result, throws with Pippin's own message on failure.
async function call(name, args, testMode) {
  await start(testMode);
  const m = await raw('tools/call', { name, arguments: args }, 90000);
  if (m.error) throw new Error(m.error.message || 'Pippin error');
  const text = (m.result && m.result.content || []).map((c) => c.text || '').join('');
  let j; try { j = JSON.parse(text); } catch { j = text; }
  if (m.result && m.result.isError) {
    const msg = typeof j === 'string' ? j : (j && (j.message || j.error)) || text;
    throw new Error(/midway|401|403|unauthori|expired|credential|cookie/i.test(msg) ? 'Pippin sign-in expired: run mwinit -o in Terminal, then try again' : String(msg).slice(0, 400));
  }
  return j;
}
function stop() { if (proc) { try { proc.kill(); } catch {} } proc = null; ready = null; }

// The few operations MdReader needs, each with the arguments it is allowed to pass (the renderer never names a tool).
const docUrl = (projectId, designId) => `https://pippin.amazon.dev/architect/${encodeURIComponent(projectId)}?artifact=${encodeURIComponent(designId)}`;
const str = (v, max = 20000) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const ops = {
  status: async (a, t) => available(t),
  folders: async (a, t) => {
    const j = await call('pippin_list_accessible_folders', {}, t);
    return (j.folders || []).filter((f) => f.status === 'ACTIVE' && !f.isQuickCreate).map((f) => ({ id: f.projectId, name: f.name, mine: (f.accessVia || []).includes('owned'), by: f.createdBy, private: !!f.isPrivate }))
      .sort((x, y) => (y.mine - x.mine) || x.name.localeCompare(y.name));
  },
  create: async (a, t) => {
    const args = { name: str(a.name, 200) || 'Untitled', content: str(a.content, 2000000) || '' };
    if (a.projectId) args.projectId = str(a.projectId, 64); else args.quick_create = true;
    const j = await call('pippin_create_artifact', args, t);
    const pr = j.project || {}, d = j.design || j.artifact || j;
    const projectId = d.projectId || pr.projectId, designId = d.designId || pr.quickCreateDesignId;
    if (!projectId || !designId) throw new Error('Pippin created the document but did not say where: ' + JSON.stringify(j).slice(0, 300));
    return { projectId, designId, url: docUrl(projectId, designId), name: args.name };
  },
  resolve: async (a, t) => { // a pasted Pippin link -> its ids and name
    const j = await call('pippin_get_artifact', { url: str(a.url, 2000) }, t);
    const d = j.design || j.artifact || j;
    if (!d.projectId || !d.designId) throw new Error('That link is not a Pippin document');
    return { projectId: d.projectId, designId: d.designId, url: docUrl(d.projectId, d.designId), name: d.name || d.title || 'Pippin document' };
  },
  content: async (a, t) => { const j = await call('pippin_get_artifact', { projectId: str(a.projectId, 64), designId: str(a.designId, 64) }, t); const d = j.design || j.artifact || j; return String(d.content || ''); },
  comments: async (a, t) => call('pippin_get_artifact_comments', { projectId: str(a.projectId, 64), designId: str(a.designId, 64) }, t),
  post: async (a, t) => {
    const args = { projectId: str(a.projectId, 64), designId: str(a.designId, 64), comment: str(a.comment, 20000) };
    if (a.replyToCommentId) args.replyToCommentId = str(a.replyToCommentId, 128);
    else if (a.anchorText) { args.anchorText = str(a.anchorText, 2000); if (a.contextBefore) args.contextBefore = str(a.contextBefore, 256); if (a.contextAfter) args.contextAfter = str(a.contextAfter, 256); }
    return call('pippin_post_artifact_comment', args, t);
  },
};
async function handle(op, args, testMode) {
  if (!Object.prototype.hasOwnProperty.call(ops, op)) throw new Error('Unknown Pippin operation');
  return ops[op](args || {}, testMode);
}
module.exports = { handle, stop, docUrl };
