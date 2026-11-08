import test from 'node:test';
import assert from 'node:assert/strict';
import {SCROLL_LATEST_THRESHOLD, distanceFromBottom, showScrollLatest} from '../public/scroll-latest.js';

const at = scrollTop => ({scrollTop, scrollHeight: 1000, clientHeight: 500});

test('the arrow shows only once the reader is more than 80px above the bottom', () => {
  assert.equal(SCROLL_LATEST_THRESHOLD, 80);
  assert.equal(distanceFromBottom(at(500)), 0);
  assert.equal(showScrollLatest(at(500)), false);
  assert.equal(showScrollLatest(at(420)), false);
  assert.equal(showScrollLatest(at(419)), true);
  assert.equal(showScrollLatest(at(0)), true);
});

test('content shorter than the viewport never shows the arrow', () => {
  assert.equal(showScrollLatest({scrollTop: 0, scrollHeight: 400, clientHeight: 500}), false);
});
