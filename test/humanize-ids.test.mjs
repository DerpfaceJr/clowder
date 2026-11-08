import test from 'node:test';
import assert from 'node:assert/strict';
import {humanizeIds, humanizeText} from '../public/humanize-ids.js';

const FILED='f5719434-6c08-469f-8645-5613a2ef28b1';
const ART='66ba9744-71ac-4141-b8ae-9c07f07167a9';

test('an unknown full id is dropped with its separator, so the sentence still reads', () => {
  assert.equal(humanizeText(`Filed owner step ${FILED}`, {}), 'Filed owner step');
  assert.equal(humanizeText(`Filed owner step: ${FILED}.`, {}), 'Filed owner step.');
  assert.equal(humanizeText(`Filed owner step (${FILED}) today`, {}), 'Filed owner step today');
});

test('a dangling word before a dropped id is kept', () => {
  assert.equal(humanizeText(`saved the review as artifact ${ART}`, {}), 'saved the review as artifact');
});

test('a known id becomes its title, in place, as a segment', () => {
  const known = {[ART]: {title: 'Cut Critic review'}};
  assert.deepEqual(humanizeIds(`saved the review as artifact ${ART}`, known), [
    {text: 'saved the review as artifact '},
    {id: ART, title: 'Cut Critic review'},
  ]);
  assert.equal(humanizeText(`Done: ${ART}, ok`, known), 'Done: Cut Critic review, ok');
});

test('a Map works like an object, and matching ignores case', () => {
  const known = new Map([[FILED, {title: 'Open the bank page'}]]);
  assert.equal(humanizeText(`Filed owner step ${FILED.toUpperCase()}`, known), 'Filed owner step Open the bank page');
});

test('an href is carried on the segment for a caller that wants a link', () => {
  assert.deepEqual(humanizeIds(ART, {[ART]: {title: 'Review', href: '/archive#x'}}), [{id: ART, title: 'Review', href: '/archive#x'}]);
});

test('an id with no title counts as unknown', () => {
  assert.equal(humanizeText(`Filed ${FILED}`, {[FILED]: {title: ''}}), 'Filed');
});

test('text without a full id is returned unchanged, short ids included', () => {
  assert.equal(humanizeText('Use e8603d80 for $75 in 60-day runs.', {}), 'Use e8603d80 for $75 in 60-day runs.');
  assert.equal(humanizeText('', {}), '');
  assert.equal(humanizeText(undefined, {}), '');
  assert.deepEqual(humanizeIds('plain', {}), [{text: 'plain'}]);
});

test('long runs of spaces stay fast, with or without an id after them', () => {
  const spaces = ' '.repeat(20000), t0 = performance.now();
  assert.equal(humanizeText(`a${spaces}b`, {}), `a${spaces}b`);
  assert.equal(humanizeText(`step${spaces}${FILED}`, {}), 'step');
  assert.ok(performance.now() - t0 < 500, 'linear, not backtracking');
});

test('an unknown id in the middle keeps the words around it apart', () => {
  assert.equal(humanizeText(`saved as artifact ${ART} today`, {}), 'saved as artifact today');
});
