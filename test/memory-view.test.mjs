import test from 'node:test';
import assert from 'node:assert/strict';
import {MAX_STEPS, buildSim, layoutStep, stepLayout} from '../public/memory-view.js';

const finiteAll = sim => sim.nodes.every(p => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.vx) && Number.isFinite(p.vy));

test('the force layout stays finite and bounded, even when every node starts on the same point', () => {
  const nodes = Array.from({length: 300}, (_, i) => ({id: `n${i}`, type: 'task'}));
  const edges = Array.from({length: 400}, (_, i) => ({from: `n${i % 300}`, to: `n${(i * 37 + 11) % 300}`, type: 'part-of', basis: 'EXTRACTED'}));
  const sim = buildSim(nodes, edges, new Map(nodes.map(n => [n.id, {x: 0, y: 0}])));
  let steps = 0;
  while (stepLayout(sim)) steps++;
  assert.equal(steps, MAX_STEPS, 'the step budget is respected');
  assert.ok(finiteAll(sim));
  assert.ok(sim.nodes.every(p => Math.abs(p.x) <= 2000 && Math.abs(p.y) <= 2000));
});

test('a single layout step on non-finite input resets to finite positions', () => {
  const sim = buildSim([{id: 'a'}, {id: 'b'}], [{from: 'a', to: 'b', type: 'owns', basis: 'EXTRACTED'}]);
  sim.nodes[0].x = Number.NaN;
  sim.nodes[1].vx = Number.POSITIVE_INFINITY;
  layoutStep(sim, 1);
  assert.ok(finiteAll(sim));
});

test('focusing keeps positions that a node already had, and drops edges to unknown nodes', () => {
  const previous = new Map([['a', {x: 120, y: -40}]]);
  const sim = buildSim([{id: 'a'}, {id: 'b'}], [{from: 'a', to: 'b', type: 'delegated', basis: 'EXTRACTED'}, {from: 'a', to: 'gone', type: 'owns', basis: 'EXTRACTED'}], previous);
  assert.equal(sim.nodes[0].x, 120);
  assert.equal(sim.nodes[0].y, -40);
  assert.equal(sim.links.length, 1);
  assert.equal(sim.links[0].basis, 'EXTRACTED');
});
