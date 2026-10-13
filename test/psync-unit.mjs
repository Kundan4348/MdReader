// Unit checks for PSYNC.plan (core/psync.js): the three-way text merge between a .md file and its Pippin doc.
// Pippin is simulated by applying the planned edits to its content the way pippin_update_artifact does
// (exact string, nth occurrence). Fixtures psync-*-pippin.md are real Pippin contents saved on 2026-10-13.
import fs from 'fs'; import vm from 'vm';
const g = {}; vm.runInNewContext(fs.readFileSync(new URL('../core/psync.js', import.meta.url), 'utf8'), { window: g });
const P = g.PSYNC; let fails = 0;
const fx = (n) => fs.readFileSync(new URL('./fixtures/' + n, import.meta.url), 'utf8');
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) { fails++; console.log('FAIL', name, '\n got ', JSON.stringify(got), '\n want', JSON.stringify(want)); } else console.log('ok  ', name); };
const yes = (name, v, info) => { if (!v) { fails++; console.log('FAIL', name, info === undefined ? '' : JSON.stringify(info).slice(0, 600)); } else console.log('ok  ', name); };
const clean = (t) => t.replace(/^\s*<!--\s*mdr-colours\s+\{.*\}\s*-->\s*\n?/gm, '').replace(/<span data-(?:c|hl)="[^"]*"(?: data-(?:c|hl)="[^"]*")?>([\s\S]*?)<\/span>/g, '$1');
function apply(remote, pushes) {
  let s = remote;
  for (const p of pushes) {
    if (p.type === 'append') { s = s.replace(/\n*$/, '') + '\n\n' + p.content + '\n'; continue; }
    let i = -1; for (let k = 0; k < p.occurrence; k++) { i = s.indexOf(p.search, i + 1); if (i < 0) throw new Error('search not found: ' + p.search.slice(0, 60)); }
    const e = i + p.search.length;
    if (p.type === 'string_replace') s = s.slice(0, i) + p.content + s.slice(e);
    else if (p.type === 'insert_after_string') s = s.slice(0, e) + p.content + s.slice(e);
    else if (p.type === 'insert_before_string') s = s.slice(0, i) + p.content + s.slice(i);
  }
  return s;
}
const words = (md) => P.blocks(md).map((b) => P.key(clean(b.raw))).filter(Boolean);
const sameWords = (md, remote) => words(md).join('') === words(P.fromPippin(remote)).join('');
const markers = (t) => (t.match(/<!--\s*comment:[\w-]+\s*-->/g) || []).length;
const ids = (t) => (t.match(/data-id="[^"]+"/g) || []);
const run = (local, remote, base, choices) => P.plan({ local, remote, base, clean, choices });

// ---- small doc: the content Pippin returned after create + 3 anchored comments ----
const SMD = '# MdReader text sync test (safe to delete)\n\nAlpha paragraph with the word giraffe in it.\n\nBravo paragraph stays the same.\n\n| Name | Value |\n|---|---|\n| one | 1 |\n| two | 2 |\n\nPing kunoku@ for help.\n';
const SR = fx('psync-small-pippin.md'), base = { local: SMD, remote: SR };
{ const r = run(SMD, SR, base); eq('nothing changed: nothing to do', [r.pushes.length, r.newLocal, r.conflicts.length], [0, null, 0]); }
{ const r = run(SMD, SR, null); eq('first link, same words: nothing to do, no conflicts', [r.pushes.length, r.newLocal, r.conflicts.length], [0, null, 0]); }
{ // local edit of a commented paragraph: one targeted replace, the comment marker kept around "giraffe"
  const L = SMD.replace('with the word giraffe in it', 'now with the word giraffe in it');
  const r = run(L, SR, base), out = apply(SR, r.pushes);
  eq('local edit -> 1 push, 0 pulls', [r.pushes.length, r.newLocal], [1, null]);
  yes('push keeps the comment marker', /now with the word <!-- comment:4af44d7e[^>]*-->giraffe<!-- \/comment:4af44d7e/.test(out), out);
  eq('all 3 markers still there', markers(out), 3); yes('Pippin now has the same words', sameWords(L, out));
}
{ // remote edit -> pulled into the file, nothing pushed
  const R2 = SR.replace('Bravo paragraph', 'Bravo paragraph, edited on Pippin,');
  const r = run(SMD, R2, base);
  eq('remote edit -> pulled', [r.pushes.length, r.newLocal], [0, SMD.replace('Bravo paragraph', 'Bravo paragraph, edited on Pippin,')]);
}
{ // a comment added on Pippin changes only markers: not a text change
  const R2 = SR.replace('Ping kunoku@', 'Ping <!-- comment:zz -->kunoku@<!-- /comment:zz -->');
  const r = run(SMD, R2, base); eq('new comment marker is not a change', [r.pushes.length, r.newLocal], [0, null]);
}
{ // a colour picked here is not a change either
  const L = SMD.replace('giraffe', '<span data-c="red.strong">giraffe</span>').replace('| two | 2 |\n', '| two | 2 |\n<!-- mdr-colours {"cols":{"Name":"teal"}} -->\n');
  const r = run(L, SR, base); eq('colours are not a change', [r.pushes.length, r.newLocal], [0, null]);
}
{ // both sides edit different paragraphs: one push and one pull
  const L = SMD.replace('Alpha paragraph', 'Alpha (local)'), R2 = SR.replace('Ping kunoku@', 'Please ping kunoku@');
  const r = run(L, R2, base), out = apply(R2, r.pushes);
  eq('different blocks -> push + pull', [r.pushes.length, r.newLocal], [1, L.replace('Ping kunoku@', 'Please ping kunoku@')]);
  yes('Pippin has both edits', sameWords(r.newLocal, out));
}
{ // both edit the same paragraph: a conflict, nothing applied; then each choice resolves it
  const L = SMD.replace('stays the same', 'stays the same (mine)'), R2 = SR.replace('Bravo paragraph', 'Bravo text');
  const r = run(L, R2, base);
  eq('same block on both sides -> 1 conflict, nothing applied', [r.conflicts.length, r.pushes.length, r.newLocal], [1, 0, null]);
  eq('conflict shows both versions', [r.conflicts[0].mine, r.conflicts[0].theirs.replace(/<!--[^>]*-->/g, '')], ['Bravo paragraph stays the same (mine).', 'Bravo text stays the same.']);
  const m = run(L, R2, base, { [r.conflicts[0].id]: 'mine' }), out = apply(R2, m.pushes);
  yes('keep mine -> pushed, marker kept', m.pushes.length === 1 && sameWords(L, out) && markers(out) === 3, out);
  const t = run(L, R2, base, { [r.conflicts[0].id]: 'theirs' });
  eq('keep theirs -> pulled into the file', [t.pushes.length, t.newLocal], [0, SMD.replace('Bravo paragraph stays the same', 'Bravo text stays the same')]);
}
{ // both made the same edit: no conflict
  const L = SMD.replace('Bravo paragraph', 'Bravo para'), R2 = SR.replace('Bravo paragraph', 'Bravo para');
  const r = run(L, R2, base); eq('same edit on both sides -> nothing', [r.conflicts.length, r.pushes.length, r.newLocal], [0, 0, null]);
}
{ // new paragraphs here: inserted after the right block on Pippin; one at the top and one at the end too
  const L = SMD.replace('Bravo paragraph stays the same.\n', 'Bravo paragraph stays the same.\n\nCharlie is new.\n').replace(/\n$/, '\n\nThe very end.\n');
  const r = run(L, SR, base), out = apply(SR, r.pushes);
  eq('2 inserts', r.pushes.map((p) => p.type).sort(), ['insert_after_string', 'insert_after_string']);
  yes('Pippin has them in place', sameWords(L, out), [words(L), words(P.fromPippin(out))]);
}
{ // a deleted paragraph here is deleted on Pippin; one deleted on Pippin is deleted here
  const L = SMD.replace('Alpha paragraph with the word giraffe in it.\n\n', ''), R2 = SR.replace('Ping kunoku@ for help.\n', '');
  const r = run(L, R2, base), out = apply(R2, r.pushes);
  eq('delete both ways', r.newLocal, '# MdReader text sync test (safe to delete)\n\nBravo paragraph stays the same.\n\n| Name | Value |\n|---|---|\n| one | 1 |\n| two | 2 |\n\n');
  yes('Pippin lost Alpha too', sameWords(r.newLocal, out) && !out.includes('giraffe'), out);
}
{ // table cell edited here: same cell ids, only that cell changes, the marker on "two" kept
  const L = SMD.replace('| one | 1 |', '| one | 11 |');
  const r = run(L, SR, base), out = apply(SR, r.pushes);
  eq('cell edit keeps every id', ids(out), ids(SR));
  yes('cell text changed', out.includes('data-id="PUbdCJS9KV">11</td>') && markers(out) === 3, out);
}
{ // a new row and a bold cell here: old ids kept, new row has none (Pippin gives it some)
  const L = SMD.replace('| two | 2 |', '| two | **2** |\n| three | `3` |');
  const r = run(L, SR, base), out = apply(SR, r.pushes);
  yes('row added', out.includes('<td>three</td>') && out.includes('<td><code>3</code></td>') && out.includes('data-id="lBqhZ39UYC"><strong>2</strong></td>'), out);
  yes('all old ids kept', ids(SR).every((x) => out.includes(x)));
}
{ // table cell edited on Pippin: the Markdown table is updated, colour line kept under it
  const L = SMD.replace('| two | 2 |\n', '| two | 2 |\n<!-- mdr-colours {"cols":{"Name":"teal"}} -->\n');
  const R2 = SR.replace('data-id="lBqhZ39UYC">2</td>', 'data-id="lBqhZ39UYC"><strong>2</strong> (from Pippin)</td>');
  const r = run(L, R2, { local: L, remote: SR });
  eq('Pippin cell edit -> Markdown table', r.newLocal, L.replace('| two | 2 |', '| two | **2** (from Pippin) |'));
}
{ // Pippin re-writing Markdown its own way (`*x*` -> `_x_`, `---` -> `***`, `@` -> `\@`) is not a change
  const T = fx('psync-tricky.md'), TR = fx('psync-tricky-pippin.md');
  const r = run(T, TR, null);
  eq('tricky doc linked for the first time: Pippin\'s own re-writing is not a conflict', r.conflicts.length, 0);
}
// ---- the real one-pager and its real Pippin copy ----
const OL = fx('psync-onepager.md'), OR = fx('psync-onepager-pippin.md');
{ const r = run(OL, OR, null); eq('one-pager: exactly the ~5.41M paragraph conflicts', r.conflicts.map((c) => c.theirs.includes('~5.41M')), [true]); }
{ const r = run(OL, OR, { local: OL, remote: OR }); eq('one-pager: synced state -> nothing', [r.pushes.length, r.newLocal], [0, null]); }
{ // edit one table cell and one commented heading paragraph area
  const L = OL.replace('DC receiving', 'DC receiving dock');
  const r = run(L, OR, { local: OL, remote: OR }), out = apply(OR, r.pushes);
  eq('one-pager cell edit: ids and markers kept', [ids(out).length, markers(out)], [ids(OR).length, markers(OR)]);
  yes('one-pager cell edit: same words', sameWords(L.replace('the switch records', 'the ~5.41M switch records'), out));
  let diffs = 0; const a = OR.split('\n'), b = out.split('\n'); for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) diffs++;
  eq('one-pager cell edit: one line changes on Pippin', diffs, 1);
}
{ // every paragraph edited here at once still lands, markers kept wherever their words survive
  const L = OL.replace(/^(?!\||#|\s*$|<!--)(.+)$/gm, '$1 (v2)');
  const r = run(L, OR, { local: OL, remote: OR }), out = apply(OR, r.pushes);
  yes('one-pager mass edit: Pippin has the same words', sameWords(L, out), [words(L).length, words(P.fromPippin(out)).length]);
  eq('one-pager mass edit: markers kept', markers(out), markers(OR));
}
console.log(fails ? `${fails} FAILED` : 'all psync checks passed');
process.exit(fails ? 1 : 0);
