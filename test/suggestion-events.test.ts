// For you cards in the journal (plan 9.2), on copies of the golden journal: raise, close, dismiss and start replay to the right card,
// the rest of the state still hashes golden, and the cards never reach small() or /api/state's snapshot.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {appendFileSync, copyFileSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store, openSuggestions, suggestionRaised, SUGGESTION_SUBJECT_MAX} from '../src/store.ts';
import {stateHash} from './fixtures/golden/state-hash.ts';

const GOLDEN = new URL('./fixtures/golden/', import.meta.url);
const goldenText = readFileSync(new URL('events.jsonl', GOLDEN), 'utf8');
const goldenHash = readFileSync(new URL('state.sha256', GOLDEN), 'utf8').trim();
const goldenCount = goldenText.split('\n').filter(Boolean).length;
const AT = '2026-11-08T09:00:00.000Z';
const line = (id: string, type: string, data: unknown) => JSON.stringify({id, at: AT, type, data}) + '\n';
const raised = (id: string, extra: object = {}) => suggestionRaised({id, source: 'gmail', account: 'made-up-account', sourceId: `thread-${id}`, category: 'reply', subject: 'Made-up subject', person: 'person-1', sourceAt: '2026-11-08T08:00:00.000Z', ...extra});

function withCopy(fn: (file: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'suggestion-events-'));
  try {
    const file = join(dir, 'events.jsonl');
    copyFileSync(new URL('events.jsonl', GOLDEN), file);
    fn(file);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}
// The golden state with the test's lines taken back out, so the rest compares with the frozen hash.
const restHash = (state: any) => stateHash({...Object.fromEntries(Object.entries(state).filter(([k]) => k !== 'suggestions' && k !== 'skipped')), events: state.events.slice(0, goldenCount)});

test('raise, close, dismiss and start replay to the right cards, and nothing else in the state moves', () => {
  withCopy(file => {
    appendFileSync(file, ['a', 'b', 'c', 'd'].map(id => line(`raise-${id}`, 'suggestion.raised', raised(id))).join('')
      + line('close-a', 'suggestion.closed', {id: 'a', why: 'replied'})
      + line('dismiss-b', 'suggestion.dismissed', {id: 'b', reason: 'person'})
      + line('start-c', 'suggestion.started', {id: 'c', task: 'task-1'})
      + line('dismiss-unknown', 'suggestion.dismissed', {id: 'nope', reason: null}));
    const store = new Store(file, []);
    const cards = store.state.suggestions!;
    assert.deepEqual([cards.a!.status, cards.a!.why, cards.a!.endedAt], ['closed', 'replied', AT]);
    assert.deepEqual([cards.b!.status, cards.b!.reason], ['dismissed', 'person']);
    assert.deepEqual([cards.c!.status, cards.c!.task], ['started', 'task-1']);
    assert.deepEqual(openSuggestions(store.state).map(c => c.id), ['d']);
    assert.deepEqual(cards.d, {...raised('d'), status: 'open', raisedAt: AT});
    assert.deepEqual(store.state.skipped, {'suggestion.dismissed': 1}, 'an end for a card that is not there is skipped and counted');
    assert.equal(store.state.unknown, undefined, 'all four types are known');
    assert.equal(restHash(store.state), goldenHash, 'nothing else moved');
  });
});

test('a re-raise reopens a dismissed card with no leftover reason, and a dismiss with no reason keeps null', () => {
  withCopy(file => {
    const store = new Store(file, []);
    store.emit('suggestion.raised', raised('a'));
    store.emit('suggestion.dismissed', {id: 'a'});
    assert.equal(store.state.suggestions!.a!.reason, null);
    store.emit('suggestion.raised', raised('a', {sourceAt: '2026-11-08T10:00:00.000Z'}));
    const card = store.state.suggestions!.a!;
    assert.deepEqual([card.status, card.sourceAt, 'reason' in card, 'endedAt' in card], ['open', '2026-11-08T10:00:00.000Z', false, false]);
    assert.deepEqual(new Store(file, []).state.suggestions, store.state.suggestions, 'a reopened store rebuilds the same cards');
    assert.ok(!readFileSync(file, 'utf8').includes('"v":'), 'every new type is written at v1');
  });
});

test('suggestionRaised keeps only its eight fields and cuts the subject', () => {
  const data = suggestionRaised({...raised('a'), subject: 'x'.repeat(200), body: 'secret text', snippet: 'more'} as any);
  assert.deepEqual(Object.keys(data).sort(), ['account', 'category', 'id', 'person', 'source', 'sourceAt', 'sourceId', 'subject']);
  assert.equal(data.subject.length, SUGGESTION_SUBJECT_MAX);
  assert.equal(suggestionRaised({id: 'b', source: 'clowder', sourceId: 'goal-1', category: 'quiet-goal', subject: 'Goal', sourceAt: AT}).account, null);
});

test('/api/state does not grow: small() is byte-equal and the snapshot differs only in seq, with 0 and with 50 open suggestions', () => {
  withCopy(file => {
    const store = new Store(file, []);
    const limits = {messages: 50, events: 50, approvals: 10};
    const small0 = JSON.stringify(store.small()), snap0 = store.snapshot(limits);
    for (let i = 0; i < 50; i++) store.emit('suggestion.raised', raised(`card-${i}`));
    assert.equal(openSuggestions(store.state).length, 50);
    assert.equal(JSON.stringify(store.small()), small0, 'small(), which every SSE patch diffs, is byte-equal');
    const snap50 = store.snapshot(limits);
    assert.equal(snap50.seq, snap0.seq + 50, 'seq is the journal position, so it counts the 50 events');
    const noSeq = ({seq: _seq, ...rest}: any) => JSON.stringify(rest);
    assert.equal(noSeq(snap50), noSeq(snap0), 'everything else in the snapshot is byte-equal');
  });
});
