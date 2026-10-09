// Unit checks for JD.diff / JD.report (core/jdiff.js).
import fs from 'fs'; import vm from 'vm';
const g = {}; vm.runInNewContext(fs.readFileSync(new URL('../core/jdiff.js', import.meta.url), 'utf8'), { window: g });
const JD = g.JD; let fails = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) { fails++; console.log('FAIL', name, '\n got ', JSON.stringify(got), '\n want', JSON.stringify(want)); } else console.log('ok  ', name); };
const R = (a, b, o) => JD.report(JD.diff(a, b, o || {}), ['A', 'B']).split('\n').slice(2);
eq('same', JD.report(JD.diff({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 }), ['A', 'B']), 'No differences between A and B.');
eq('scalar change + add + remove', R({ a: 1, b: 'x', c: true }, { a: 2, b: 'x', d: null }), ['~ $.a: 1 → 2', '- $.c: true', '+ $.d: null']);
eq('type change', R({ n: 12 }, { n: '12' }), ['~ $.n: 12 → "12"']);
eq('nested', R({ o: { p: { q: 1 } } }, { o: { p: { q: 2, r: 3 } } }), ['~ $.o.p.q: 1 → 2', '+ $.o.p.r: 3']);
eq('insert in list = one add', R([1, 2, 3, 4], [1, 2, 9, 3, 4]), ['+ $[2]: 9']);
eq('remove in list = one remove', R(['a', 'b', 'c'], ['a', 'c']), ['- $[was 1]: "b"']);
eq('changed item in list', R([1, 2, 3], [1, 5, 3]), ['~ $[1]: 2 → 5']);
const A = [{ id: 1, s: 'ok' }, { id: 2, s: 'ok' }, { id: 3, s: 'ok' }];
eq('by id: field change', R(A, [{ id: 1, s: 'ok' }, { id: 2, s: 'bad' }, { id: 3, s: 'ok' }]), ['~ $[id=2].s: "ok" → "bad"']);
eq('by id: insert at top is one add', R(A, [{ id: 0, s: 'new' }, ...A]), ['+ $[id=0]: {"id":0,"s":"new"}']);
eq('by id: real move', R(A, [A[2], A[0], A[1]]), ['↕ $[id=3]: moved from position 2 to 0']);
eq('by id: ignore order', R(A, [A[2], A[0], A[1]], { ignoreOrder: true }), []);
eq('ignore order scalars', R([1, 2, 3], [3, 1, 2], { ignoreOrder: true }), []);
eq('by position', R(A, [{ id: 0, s: 'new' }, ...A], { match: 'position' }).length, 5);
eq('idKey picks shipmentId', JD.idKey([{ shipmentId: 'a', n: 1 }], [{ shipmentId: 'b', n: 1 }]), 'shipmentId');
eq('counts', JD.diff({ a: 1, l: [1, 2] }, { a: 2, l: [1, 2, 3], z: 0 }).n, { changed: 1, added: 2, removed: 0 });
// side by side: each column is the real JSON of its side (valid, equal), and there is one marked row per difference
const ab = [[{ a: 1, l: [{ id: 1, v: 'x' }, { id: 2, v: 'y' }], o: { p: [1, 2] } }, { a: 2, l: [{ id: 0, v: 'n' }, { id: 1, v: 'x' }, { id: 2, v: 'z' }], o: { p: [1, 2, 3] }, q: { deep: true } }],
  [JSON.parse(fs.readFileSync(new URL('./fixtures/cmp-before.json', import.meta.url))), JSON.parse(fs.readFileSync(new URL('./fixtures/cmp-after.json', import.meta.url)))], [[3, 1, 2], [1, 2, 3]], [{ x: 1 }, { x: 1 }]];
ab.forEach(([a, b], n) => {
  const d = JD.diff(a, b), rows = JD.sbsRows(d);
  const L = rows.filter((r) => r.l !== null).map((r) => r.l).join('\n'), Rt = rows.filter((r) => r.r !== null).map((r) => r.r).join('\n');
  eq(`sbs ${n} left is the left JSON`, JSON.parse(L), a); eq(`sbs ${n} right is the right JSON`, JSON.parse(Rt), b);
  eq(`sbs ${n} left is pretty-printed`, L, JSON.stringify(a, null, 2));
  eq(`sbs ${n} one mark per difference`, rows.filter((r) => r.mark).length, JD.changes(d).length);
});
eq('ignore keys anywhere', R({ at: 1, o: { at: 2, v: 1 }, l: [{ id: 1, At: 3 }] }, { at: 9, o: { at: 8, v: 1 }, l: [{ id: 1, At: 4 }] }, { ignoreKeys: new Set(['at']) }), []);
{ const ev = JSON.parse(fs.readFileSync(new URL('./fixtures/cmp-event.json', import.meta.url))), en = JSON.parse(fs.readFileSync(new URL('./fixtures/cmp-entity.json', import.meta.url)));
  eq('no shared top-level keys', JD.overlap(ev, en), 0);
  const bp = JD.bestPair(ev, en); eq('best pair', [bp.a, bp.b], [['event'], ['entity']]);
  eq('inner differences', R(JD.at(ev, bp.a), JD.at(en, bp.b)), ['~ $.serializationToken: "PhysicalAssetService.InventEntityUploaded" → "PhysicalAssetService.PhysicalAssetInvent"', '- $.serializedObject.ownerSupplyChain: "arn:aws:ocean-wave:us-west-2:662631391062:supplyChain/aws-inf-p"', '+ $.serializedObject.currentOwnerArn: "arn:aws:ocean-wave:us-east-1:038462747010:supplyChain/aws-inf-p"']);
  eq('similar shapes get no suggestion need', JD.overlap({ a: 1, b: 2 }, { a: 1, b: 3 }), 1); }
console.log(fails ? `${fails} FAILED` : 'ALL OK'); process.exit(fails ? 1 : 0);
