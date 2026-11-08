import test from 'node:test';
import assert from 'node:assert/strict';
import {fakeDocument} from './fixtures/fake-dom.mjs';
import {emptyState} from '../public/empty-state.js';

test('an empty state is a hidden 48px cat-ear picture with one icon, one sentence and at most one action', () => {
  const doc = fakeDocument();
  const action = doc.createElement('button');
  action.textContent = 'See the diary';
  const box = emptyState(doc, {icon: 'check', text: 'Nothing needs you right now; your cats are on it.', action});
  const [art, line, button] = box.children;
  assert.equal(box.className, 'empty-state');
  assert.equal(art.tagName, 'SVG');
  assert.equal(art.getAttribute('aria-hidden'), 'true', 'the picture is decoration; the sentence carries the meaning');
  assert.equal(art.getAttribute('width'), '48');
  assert.equal(art.querySelectorAll('svg').length, 1, 'one Lucide icon on the tile');
  assert.equal(art.querySelector('use').getAttribute('href'), '#i-check');
  assert.equal(line.textContent, 'Nothing needs you right now; your cats are on it.');
  assert.equal(button, action);
  assert.equal(emptyState(doc, {icon: 'coins', text: 'No season yet.'}).children.length, 2, 'no action, no button');
});
