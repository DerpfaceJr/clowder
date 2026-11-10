// Plans 10.9 and 10.12 (docs/for-you-and-teams-plan.md §4.5). A team member past their monthly token budget is held at their next turn boundary
// with one owner card; the owner and other members keep running. Thread participants name the owner and each member whose tree it is.
// Through the real Town, People (people.json on a temp folder) and decide(); the model is a stand-in that reports token counts.
import {after, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Town} from '../src/engine.ts';
import {People} from '../src/people.ts';
import {Pairing} from '../src/pairing.ts';
import {allRoles} from '../src/roles.ts';
import {Store} from '../src/store.ts';
import {usageReport} from '../src/usage.ts';
import type {Provider} from '../src/provider.ts';
import {untilEvery} from './helpers/until.ts';

// No recorder: its follow-up tasks would spend the stand-in's tokens too.
const config = {...JSON.parse(readFileSync(new URL('../town.config.json', import.meta.url), 'utf8')), recorder: null};
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const cleanup: (() => unknown)[] = [];
after(async () => { for (const c of cleanup) await c(); });
const until = untilEvery(10, 15000);

// Every model reply spends 700 + 300 tokens, so one finished task is 1000 tokens of usage.
const spend: Provider = async () => ({message: {role: 'assistant', content: 'Done with it.'}, usage: {prompt_tokens: 700, completion_tokens: 300}});

function world() {
  const dir = tmp('member-budget-');
  const store = new Store(join(dir, 'events.jsonl'), allRoles(config));
  const pairing = new Pairing(join(dir, 'pairing.json'), config.remote);
  const people = new People(join(dir, 'people.json'), pairing);
  const town = new Town(store, config, {test: spend});
  town.autonomy = () => 'balanced';
  town.members = {budgetOf: id => people.budgetOf(id), setBudget: (actor, id, tokens) => people.setBudget(actor, id, tokens)};
  town.personName = id => people.name(id);
  cleanup.push(() => town.dispose());
  const statusOf = (id: string) => store.state.tasks.find(t => t.id === id)?.status ?? '';
  const heldOf = (id: string) => store.state.tasks.find(t => t.id === id)?.held ?? null;
  const cards = (person: string) => store.state.approvals.filter(a => a.gate === 'budget' && a.person === person);
  return {store, town, people, statusOf, heldOf, cards};
}

test('10.9: a member past budget is held with one owner card; the owner and another member keep running', async () => {
  const w = world();
  const ana = w.people.add('Ana', 'member').id, ben = w.people.add('Ben', 'member').id;
  w.town.setMemberBudget('owner', ana, 1000);

  // Ana's first task spends the budget (700 + 300 tokens), so her second one is held at its first boundary, before any model call.
  const first = w.town.submit('mayor', 'First thing, please.', 'test', {by: ana});
  await until(() => w.statusOf(first) === 'done');
  const second = w.town.submit('mayor', 'Second thing, please.', 'test', {by: ana});
  await until(() => w.heldOf(second) === 'budget' && w.statusOf(second) === 'waiting');
  assert.equal(w.cards(ana).length, 1, 'one owner card for the member');
  assert.equal(w.cards(ana)[0]!.status, 'pending');
  assert.equal(w.cards(ana)[0]!.options[0], 'Raise the budget');

  // A third task for the same member is held too, and files no second card.
  const third = w.town.submit('mayor', 'Third thing, please.', 'test', {by: ana});
  await until(() => w.heldOf(third) === 'budget');
  assert.equal(w.cards(ana).length, 1, 'still exactly one card for the month');

  // The owner and another member are not held.
  const benTask = w.town.submit('mayor', 'Ben here.', 'test', {by: ben});
  const ownerTask = w.town.submit('mayor', 'Owner here.', 'test');
  await until(() => w.statusOf(benTask) === 'done' && w.statusOf(ownerTask) === 'done');
  assert.equal(w.statusOf(second), 'waiting', 'Ana stays held while over budget');

  // The owner raises the budget on the card: the held work resumes from its checkpoint and finishes.
  const card = w.cards(ana)[0]!;
  w.town.decide(card.id, '5000', true);
  await until(() => w.statusOf(second) === 'done' && w.statusOf(third) === 'done');
  assert.equal(w.people.budgetOf(ana), 5000);
  assert.equal(w.cards(ana).length, 1);
  assert.equal(w.store.state.approvals.find(a => a.id === card.id)?.status, 'approved');
});

test('10.9: the usage tally counts each member apart, the owner under OWNER', async () => {
  const w = world();
  const ana = w.people.add('Ana', 'member').id;
  const ownerTask = w.town.submit('mayor', 'Owner first.', 'test');
  await until(() => w.statusOf(ownerTask) === 'done');
  const anaTask = w.town.submit('mayor', 'Ana first.', 'test', {by: ana});
  await until(() => w.statusOf(anaTask) === 'done');
  const {current} = usageReport(w.store.state);
  assert.equal(current.people[ana]?.tokens, 1000);
  assert.equal(current.people.owner?.tokens, 1000);
  assert.equal(Object.values(current.people).reduce((n, t) => n + t.tokens, 0), current.total.tokens, 'the tally adds to the total');
});

test('10.12: a thread with the owner and one member lists both, named', async () => {
  const w = world();
  const ana = w.people.add('Ana', 'member').id;
  const root = w.town.submit('mayor', 'Ana asks.', 'test', {by: ana});
  await until(() => w.statusOf(root) === 'done');
  const thread = w.store.thread(root, {limit: 50, name: id => w.people.name(id)})!;
  assert.deepEqual(thread.participants, [{id: 'owner', name: 'Owner'}, {id: ana, name: 'Ana'}]);

  const ownerOnly = w.town.submit('mayor', 'Owner asks.', 'test');
  await until(() => w.statusOf(ownerOnly) === 'done');
  assert.deepEqual(w.store.thread(ownerOnly, {limit: 50})!.participants, [{id: 'owner', name: 'Owner'}]);
});
