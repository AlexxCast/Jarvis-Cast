import test from 'node:test';
import assert from 'node:assert/strict';
import { layout2d, pcbTrace, pointAt } from '../../web/net2d.js';

test('rete 2D: piste a 45° e poi dritte', () => {
  const p = pcbTrace({ x: 0, y: 0 }, { x: 3, y: 1 });
  assert.deepEqual(p, [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 3, y: 1 }]);
  assert.equal(pcbTrace({ x: 0, y: 0 }, { x: 2, y: 2 }).length, 2);
  assert.deepEqual(pointAt(p, 1), { x: 3, y: 1 });
});

test('rete 2D: rami interni più vicini a Jarvis, tutto dentro il cerchio, sotto-foglie attaccate alla loro foglia', () => {
  const branches = [
    { id: 'dieta', ring: 0, children: [{ id: 'a' }, { id: 'b' }, { id: 'c', parent: 'a' }] },
    { id: 'lontano', ring: 4, children: Array.from({ length: 20 }, (_, i) => ({ id: 'l' + i })) },
    { id: 'vuoto', ring: 1, children: [] },
  ];
  const out = layout2d(branches);
  const d = (id) => { const b = out.find(x => x.id === id); return Math.hypot(b.hub.x, b.hub.y); };
  assert.ok(d('dieta') < d('vuoto') && d('vuoto') < d('lontano'));
  for (const b of out) for (const l of b.leaves) assert.ok(Math.hypot(l.x, l.y) <= 0.961);
  assert.equal(out.find(x => x.id === 'lontano').leaves.length, 10);
  const dieta = out.find(x => x.id === 'dieta'), sub = dieta.leaves.find(l => l.id === 'c'), host = dieta.leaves.find(l => l.id === 'a');
  assert.equal(sub.host, 'a');
  assert.deepEqual(sub.path[0], { x: host.x, y: host.y });
  assert.deepEqual(layout2d([]), []);
});
