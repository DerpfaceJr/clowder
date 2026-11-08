// Plan 8.4, the read routes' rules: a thread is the root task with every task it delegated, and only the public projection of each part;
// a decision's quick buttons are the push notice's buttons; search finds a message's words. The routes themselves are in device-roles.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store, publicApproval} from '../src/store.ts';
import {noticeOf} from '../src/push.ts';

const cats = [{id: 'mayor', name: 'Mayor', role: 'Runs the town.', color: '', icon: ''}, {id: 'scout', name: 'Scout', role: 'Finds things.', color: '', icon: ''}];
const open = () => { const dir = mkdtempSync(join(tmpdir(), 'read-routes-')); return new Store(join(dir, 'events.jsonl'), cats, {readModel: join(dir, 'read-model.db')}); };

test('a thread returns the root task, every descendant task and their messages, paged, with no model context', () => {
  const s = open();
  s.emit('task.created', {id: 'root', cat: 'scout', from: 'owner', text: 'root job', mode: 'local', status: 'running', context: 'SECRET-CONTEXT'});
  s.emit('task.created', {id: 'child', cat: 'scout', from: 'scout', text: 'child job', mode: 'local', status: 'running', parent: 'root'});
  s.emit('task.created', {id: 'grand', cat: 'mayor', from: 'scout', text: 'grand job', mode: 'local', status: 'running', parent: 'child'});
  s.emit('task.created', {id: 'other', cat: 'mayor', from: 'owner', text: 'other job', mode: 'local', status: 'running'});
  s.emit('message', {from: 'owner', to: 'scout', text: 'm1', task: 'root'});
  s.emit('message', {from: 'scout', to: 'mayor', text: 'm2', task: 'child'});
  s.emit('message', {from: 'mayor', to: 'owner', text: 'm3', task: 'grand'});
  s.emit('message', {from: 'owner', to: 'mayor', text: 'm4', task: 'other'});
  const all = s.thread('root', {limit: 50})!;
  assert.deepEqual(all.messages.map(m => m.text), ['m1', 'm2', 'm3'], 'every descendant message, not the unrelated task');
  assert.deepEqual(all.tasks.map(t => t.id).sort(), ['child', 'grand', 'root']);
  assert.ok(!JSON.stringify(all).includes('SECRET-CONTEXT'), 'the model context never leaves');
  const page = s.thread('root', {limit: 2})!;
  assert.deepEqual(page.messages.map(m => m.text), ['m2', 'm3']);
  assert.equal(page.more, true);
  const older = s.thread('root', {limit: 2, before: page.messages[0]!.id})!;
  assert.deepEqual(older.messages.map(m => m.text), ['m1']);
  assert.equal(older.more, false);
  assert.equal(s.thread('no-such-task', {limit: 5}), null);
});

test('a decision carries the quick buttons the push notice offers, and no model messages', () => {
  const fixtures: any[] = [
    {id: 'a1', task: 't', cat: 'scout', question: 'Read the inbox?', options: ['Allow once', 'Deny'], status: 'pending', gate: 'connector', effectClass: 'read', toolCallId: 'c1', turn: 1, depth: 0, messages: [{role: 'model'}]},
    {id: 'a2', task: 't', cat: 'scout', question: 'Pick one?', options: ['Yes', 'No'], status: 'pending', toolCallId: 'c2', turn: 1, depth: 0, messages: []},
    {id: 'a3', task: 't', cat: 'scout', question: 'Send money?', options: ['Allow once', 'Deny'], status: 'pending', gate: 'effect', toolCallId: 'c3', turn: 1, depth: 0, messages: []},
  ];
  for (const a of fixtures) {
    const view = publicApproval(a);
    assert.ok(!('messages' in view), 'model messages stay on the host');
    const pushed = noticeOf({type: 'approval.requested', data: a}, cats)?.actions ?? [];
    assert.deepEqual(view.quick, pushed, `${a.id}: quick equals the push buttons`);
  }
  assert.deepEqual(publicApproval(fixtures[0]).quick, [{answer: 'Allow once', approved: true}, {answer: 'Deny', approved: false}]);
  assert.deepEqual(publicApproval(fixtures[2]).quick, [], 'a money gate opens the card');
});

test('search finds a word from a message through the read model', () => {
  const s = open();
  s.emit('message', {from: 'owner', to: 'scout', text: 'bake the marmalade bread'});
  s.readModel!.flush();
  const hits = s.readModel!.search('marmalade', 10);
  assert.equal(hits[0]?.kind, 'message');
  assert.match(hits[0]!.text, /marmalade/);
});
