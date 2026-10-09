// Unit checks for JV.edit (core/json.js): each op must change only what it says, byte for byte.
import fs from 'fs'; import vm from 'vm';
const win = {}; vm.runInNewContext(fs.readFileSync(new URL('../core/json.js', import.meta.url), 'utf8'), { window: win, document: {}, TextEncoder });
const JV = win.JV, P = (...p) => JV.pathKey(['doc#0', ...p]);
let fails = 0;
const eq = (name, got, want) => { const ok = got === want; if (!ok) { fails++; console.log('FAIL', name, '\n--- got\n' + got + '\n--- want\n' + want); } else console.log('ok  ', name); };
const E = (t, op, a) => { const r = JV.edit(t, op, a); return r ? r.text : t; };
const src = `{
  "name": "demo",   // the name
  "count": 12,
  "price": 1.50,
  "tags": ["a", "b"],
  "rows": [
    { "id": 1, "state": "passed", "n": 3 },
    { "id": 2, "state": "failed", "n": 10 },
    { "id": 3, "state": "pending" }
  ]
}`;
eq('set string', E(src, 'set', { pk: P('name'), raw: 'new "one"', was: 'string' }), src.replace('"demo"', '"new \\"one\\""'));
eq('set number keeps spelling elsewhere', E(src, 'set', { pk: P('count'), raw: '13', was: 'number' }), src.replace('12', '13'));
eq('number -> text', E(src, 'set', { pk: P('count'), raw: 'N/A', was: 'number' }), src.replace('12', '"N/A"'));
eq('unchanged price is no-op', E(src, 'set', { pk: P('price'), raw: '1.50', was: 'number' }), src);
eq('rename', E(src, 'rename', { pk: P('count'), key: 'total' }), src.replace('"count"', '"total"'));
let threw = ''; try { E(src, 'rename', { pk: P('count'), key: 'name' }); } catch (e) { threw = e.message; } eq('rename clash refused', threw, '"name" is already a key here');
eq('add after count', E(src, 'add', { pk: P('count') }), src.replace('"count": 12,\n', '"count": 12,\n  "new key": "",\n'));
eq('add after last keeps note', E(`{\n  "a": 1  // note\n}`, 'add', { pk: P('a') }), `{\n  "a": 1,  // note\n  "new key": ""\n}`);
eq('add item in inline array', E(src, 'add', { pk: P('tags', 1) }), src.replace('["a", "b"]', '["a", "b", ""]'));
eq('dup key', E(src, 'dup', { pk: P('count') }), src.replace('"count": 12,\n', '"count": 12,\n  "count copy": 12,\n'));
eq('del middle', E(src, 'del', { pks: [P('count')] }), src.replace('  "count": 12,\n', ''));
eq('del last', E(src, 'del', { pks: [P('rows')] }), src.replace(/,\n  "rows": \[[\s\S]*\]\n\}$/, '\n}'));
eq('del only', E('{"a":[1]}', 'del', { pks: [P('a', 0)] }), '{"a":[]}');
eq('move down', E(src, 'move', { pk: P('count'), dir: 1 }), src.replace('"count": 12,\n  "price": 1.50', '"price": 1.50,\n  "count": 12'));
eq('type to string', E(src, 'type', { pk: P('count'), to: 'string' }), src.replace('12', '"12"'));
eq('addInside empty', E('{\n  "a": {}\n}', 'addInside', { pk: P('a') }), '{\n  "a": {\n    "new key": ""\n  }\n}');
// tables
const R = P('rows'), cols = ['id', 'state', 'n'];
eq('cell set', E(src, 'cell', { pk: R, i: 1, col: 'n', raw: '11', cols }), src.replace('"n": 10', '"n": 11'));
eq('cell missing inserted', E(src, 'cell', { pk: R, i: 2, col: 'n', raw: '7', cols }), src.replace('"state": "pending" }', '"state": "pending", "n": 7 }'));
eq('row add blank', E(src, 'rowAdd', { pk: R, at: 1, like: 0 }), src.replace('    { "id": 2', '    { "id": null, "state": "", "n": null },\n    { "id": 2'));
eq('row del 2', E(src, 'rowDel', { pk: R, rows: [0, 1] }), src.replace('    { "id": 1, "state": "passed", "n": 3 },\n    { "id": 2, "state": "failed", "n": 10 },\n', ''));
eq('row move', E(src, 'rowMove', { pk: R, from: 2, to: 0 }), src.replace('{ "id": 1, "state": "passed", "n": 3 },\n    { "id": 2, "state": "failed", "n": 10 },\n    { "id": 3, "state": "pending" }', '{ "id": 3, "state": "pending" },\n    { "id": 1, "state": "passed", "n": 3 },\n    { "id": 2, "state": "failed", "n": 10 }'));
eq('sort n desc (missing last)', E(src, 'sort', { pk: R, col: 'n', dir: -1 }), src.replace('{ "id": 1, "state": "passed", "n": 3 },\n    { "id": 2, "state": "failed", "n": 10 }', '{ "id": 2, "state": "failed", "n": 10 },\n    { "id": 1, "state": "passed", "n": 3 }'));
eq('col rename', E(src, 'colRename', { pk: R, from: 'state', to: 'status' }), src.replace(/"state"/g, '"status"'));
eq('col del 2', E(src, 'colDel', { pk: R, names: ['state', 'n'] }), src.replace(', "state": "passed", "n": 3', '').replace(', "state": "failed", "n": 10', '').replace(', "state": "pending"', ''));
eq('col add at 1', E(src, 'colAdd', { pk: R, at: 1, cols }), src.replace(/\{ "id": (\d),/g, '{ "id": $1, "new column": "",'));
eq('col move n first', E(src, 'colMove', { pk: R, cols, from: 2, to: 0 }), src.replace('{ "id": 1, "state": "passed", "n": 3 }', '{ "n": 3, "id": 1, "state": "passed" }').replace('{ "id": 2, "state": "failed", "n": 10 }', '{ "n": 10, "id": 2, "state": "failed" }'));
const ok = (t) => { try { JSON.parse(t.replace(/\/\/.*$/gm, '')); return true; } catch { return false; } };
eq('strict output stays valid', String(ok(E(E(E(src, 'colAdd', { pk: R, at: 3, cols }), 'rowDel', { pk: R, rows: [2] }), 'del', { pks: [P('tags')] }))), 'true');
console.log(fails ? `${fails} FAILED` : 'ALL OK'); process.exit(fails ? 1 : 0);
