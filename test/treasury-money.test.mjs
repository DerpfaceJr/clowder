import test from 'node:test';
import assert from 'node:assert/strict';
import {tokensUsedHtml} from '../public/treasury-view.js';

const esc = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

test('the Money section is headed Tokens used, totals the chat ledger and seasons, and escapes season names', () => {
  const usage = [{mode: 'local', input: 1200, output: 300}, {mode: 'demo', input: 5, output: 5}, {mode: 'plan', input: 100, output: 100}];
  const seasons = [{name: '<s1>', tokens: {input: 1000, output: 500, calls: 2, unknown: 0}}];
  const html = tokensUsedHtml(usage, seasons, esc);
  assert.ok(html.startsWith('<h3>Tokens used</h3>'));
  assert.ok(html.includes('3,200 <span>tokens so far in this world</span>'));
  assert.ok(html.includes('<span>Local AI</span>'));
  assert.ok(html.includes('<span>Claude plan</span>'));
  assert.ok(html.includes('<span>Season &lt;s1&gt;</span>'));
  assert.ok(!html.includes('<s1>'));
});

test('with no model tokens the section says so instead of showing a total', () => {
  const html = tokensUsedHtml([{mode: 'demo', input: 9, output: 9}], [], esc);
  assert.ok(html.includes('No model tokens yet. The scripted demo uses none.'));
  assert.ok(!html.includes('tokens so far'));
});
