// Stand-in for pippin-mcp-server in tests: same MCP stdio protocol and the same response shapes the real server
// returned on 2026-10-13 (create -> {project:{projectId, quickCreateDesignId}}, post -> {status, commentId, ...},
// comments -> {threads:{open, resolved}}). State is a JSON file (FAKE_PIPPIN_STATE) the test reads and edits.
// FAKE_PIPPIN_FAIL=auth makes every call fail like an expired Midway session.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const F = process.env.FAKE_PIPPIN_STATE;
const load = () => (existsSync(F) ? JSON.parse(readFileSync(F, 'utf8')) : { docs: {}, calls: [], folders: [{ projectId: 'FOLD1', name: 'Asset-Svc-Oncall', status: 'ACTIVE', createdBy: 'rathmegh', isPrivate: true, accessVia: ['manageable'] }, { projectId: 'FOLD2', name: 'My designs', status: 'ACTIVE', createdBy: 'alice', accessVia: ['owned'] }] });
const save = (s) => writeFileSync(F, JSON.stringify(s, null, 2));
const ME = process.env.MDR_TEST_USER_ID || 'alice';
let n = 0; const rid = () => `${Date.now().toString(16)}-${(++n).toString(16)}-fake`;
const tools = {
  pippin_list_accessible_folders: (s) => ({ folders: [...s.folders, { projectId: 'QC', name: 'Quick Create', isQuickCreate: true, status: 'ACTIVE', accessVia: ['owned'] }] }),
  pippin_create_artifact: (s, a) => {
    const projectId = a.projectId || 'QC' + (++n), designId = 'D' + Date.now().toString(36);
    s.docs[designId] = { projectId, designId, name: a.name, content: a.content, quick: !!a.quick_create, threads: [] };
    return a.quick_create ? { project: { projectId, quickCreateDesignId: designId, isQuickCreate: true, name: 'Quick Create', createdBy: ME } } : { design: { projectId, designId, name: a.name } };
  },
  pippin_get_artifact: (s, a) => { const m = a.designId ? [0, a.designId] : /artifact=([\w-]+)/.exec(a.url || '') || /docs\/([\w-]+)/.exec(a.url || ''); const d = m && s.docs[m[1]]; if (!d) throw new Error('Artifact not found'); return { design: { projectId: d.projectId, designId: d.designId, name: d.name, content: d.marked || d.content } }; },
  // same contract as the real tool: exact string, nth occurrence, "not found" refuses the edit
  pippin_update_artifact: (s, a) => {
    const d = s.docs[a.designId]; if (!d) throw new Error('Artifact not found');
    const k = d.marked != null ? 'marked' : 'content'; let t = d[k];
    if (a.updateType === 'append') t = t.replace(/\n*$/, '') + '\n\n' + a.insertContent + '\n';
    else {
      let i = -1; for (let n = 0; n < (a.occurrence || 1); n++) { i = t.indexOf(a.searchString, i + 1); if (i < 0) throw new Error(`Search string not found at occurrence ${a.occurrence || 1}`); }
      const e = i + a.searchString.length;
      if (a.updateType === 'string_replace') t = t.slice(0, i) + a.replacementString + t.slice(e);
      else if (a.updateType === 'insert_after_string') t = t.slice(0, e) + a.insertContent + t.slice(e);
      else if (a.updateType === 'insert_before_string') t = t.slice(0, i) + a.insertContent + t.slice(i);
      else throw new Error('unsupported updateType ' + a.updateType);
    }
    d[k] = t; if (k === 'marked') d.content = t.replace(/<!--\s*\/?comment:[\w-]+\s*-->/g, '');
    d.version = (d.version || 1) + 1;
    return { design: { projectId: d.projectId, designId: d.designId, name: d.name, version: d.version } };
  },
  pippin_get_artifact_comments: (s, a) => {
    const d = s.docs[a.designId]; if (!d) throw new Error('Artifact not found');
    const out = { open: [], resolved: [] };
    for (const t of d.threads) out[t.resolved ? 'resolved' : 'open'].push({ parentComment: t.parent, replies: t.replies, totalCount: 1 + t.replies.length });
    return { threads: out, totalComments: d.threads.reduce((k, t) => k + 1 + t.replies.length, 0) };
  },
  pippin_post_artifact_comment: (s, a) => {
    const d = s.docs[a.designId]; if (!d) throw new Error('Artifact not found');
    const now = Date.now(), commentId = rid();
    const c = { commentId, designId: a.designId, projectId: a.projectId, content: a.comment, createdAt: now, updatedAt: now, createdBy: ME, status: 'ACTIVE' };
    if (a.replyToCommentId) {
      const t = d.threads.find((x) => x.parent.commentId === a.replyToCommentId || x.replies.some((r) => r.commentId === a.replyToCommentId)); if (!t) throw new Error('No such comment');
      t.replies.push({ ...c, parentCommentId: t.parent.commentId, textAnchor: t.parent.textAnchor }); return { status: 'replied', commentId, inReplyTo: a.replyToCommentId, author: ME };
    }
    if (a.anchorText) {
      if (!d.content.includes(a.anchorText)) return { status: 'anchor_not_placed', anchored: false };
      d.threads.push({ parent: { ...c, textAnchor: { selectedText: a.anchorText } }, replies: [] }); return { status: 'anchored', anchored: true, commentId, anchorText: a.anchorText, author: ME };
    }
    d.threads.push({ parent: c, replies: [] }); return { status: 'posted', commentId, author: ME };
  },
};
let buf = '';
process.stdin.on('data', (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1); let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id == null) continue;
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n');
    if (m.method === 'initialize') reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake-pippin', version: '0' } });
    else if (m.method === 'tools/call') {
      const s = load(); s.calls.push({ name: m.params.name, args: m.params.arguments });
      try {
        if (process.env.FAKE_PIPPIN_FAIL === 'auth' || s.failAuth) throw new Error('Midway authentication failed: 401');
        const f = tools[m.params.name]; if (!f) throw new Error('unknown tool ' + m.params.name);
        const r = f(s, m.params.arguments || {}); save(s);
        reply({ content: [{ type: 'text', text: JSON.stringify(r) }] });
      } catch (e) { save(s); reply({ content: [{ type: 'text', text: e.message }], isError: true }); }
    } else reply({});
  }
});
