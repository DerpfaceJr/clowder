// Plans 10.6 and 10.7 (docs/for-you-and-teams-plan.md §4.5). A team member's chat starts a tree that is theirs: every event it causes carries `by`,
// its children inherit it, the Mayor reads their words as a team member's, and the chat line carries their name. In that tree a member answers only
// their own decisions on team-scoped accounts; an owner-only account, a money call and the cats' browser are the owner's cards.
// Through a real ConnectorHub on a temp data folder, Always allow set the way a card sets it, and the real decide(); the MCP client and the model are stand-ins.
import {after, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ALLOW_ONCE, EVERY_CAT} from '../src/accounts.ts';
import {ConnectorHub} from '../src/connectors.ts';
import {Town} from '../src/engine.ts';
import {allRoles} from '../src/roles.ts';
import {Store, type Event} from '../src/store.ts';
import type {Provider} from '../src/provider.ts';
import {untilEvery} from './helpers/until.ts';

const config = JSON.parse(readFileSync(new URL('../town.config.json', import.meta.url), 'utf8'));
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const until = untilEvery(10, 15000);
const ANA = 'p-ana', BEN = 'p-ben', NAMES: Record<string, string> = {[ANA]: 'Ana', [BEN]: 'Ben'};
const TOOLS = {read_inbox: 'read', pay_invoice: 'money'} as const;
type Tool = keyof typeof TOOLS;
const fn = (tool: Tool) => `mcp__mail__${tool}`;
const reply = (content: string) => ({message: {role: 'assistant', content}});
const callOf = (name: string, args: unknown, id = `call-${name}`) => ({message: {role: 'assistant', content: null, tool_calls: [{id, type: 'function', function: {name, arguments: JSON.stringify(args)}}]}});
const cleanup: (() => unknown)[] = [];
after(async () => { for (const c of cleanup) await c(); });

// One world: a Mail connector (owner-only until a test marks it team) given to the Mayor with Always allow on every tool, and a model whose Mayor
// reads its orders from the request: "CALL <tool>" or "ASK". prompts keeps every model call's messages.
async function world(opts: {parallel?: number} = {}) {
  const calls: string[] = [];
  const client = {info: {}, close: async () => {}, listTools: async () => Object.keys(TOOLS).map(name => ({name, inputSchema: {type: 'object'}})),
    callTool: async (name: string) => { calls.push(name); return {text: `ok ${name}`, isError: false}; }};
  const hub = new ConnectorHub({dataDir: tmp('member-data-'), port: 4334, home: tmp('member-home-'), connect: (async () => client) as any});
  hub.addCustom({name: 'Mail', type: 'http', url: 'https://example.com/mcp'});
  hub.patchConnector('mail', {enabled: true, cats: ['mayor', 'scholar']});
  await until(() => hub.publicConnectors().find(c => c.id === 'mail')?.status === 'connected');
  for (const t of Object.keys(TOOLS)) hub.allowTool('mail', t);
  const prompts: any[][] = [];
  let hold: Promise<void> | null = null;
  const provider: Provider = async messages => {
    prompts.push([...messages]); // the loop goes on pushing to its own array
    if (hold) await hold;
    const last = String(messages.at(-1)?.content ?? '');
    if (last.startsWith('Record for the town')) return reply('Nothing new to record.');
    const cat = /CAT_ID=(\S+)/.exec(String(messages[0]!.content))?.[1] ?? '';
    const tools = messages.filter(m => m.role === 'tool');
    if (cat === 'scholar') return reply('Scholar report: the inbox holds three notes about the launch, nothing urgent today.');
    const order = /(CALL \w+|ASK|DELEGATE|RECRUIT)/.exec(last)?.[1] ?? '';
    if (tools.length || !order) return reply(`Mayor report: ${String(tools.at(-1)?.content ?? 'nothing to do')}. Everything asked for is done now.`);
    if (order === 'ASK') return callOf('request_approval', {question: 'Blue or green for the launch page?', options: ['Blue', 'Green']});
    if (order === 'DELEGATE') return callOf('delegate', {cat: 'scholar', task: 'Read the inbox and report.'});
    if (order === 'RECRUIT') return callOf('create_cat', {name: 'Quill', role: 'Writes launch notes.'});
    return callOf(fn(order.slice(5) as Tool), {q: 'x'});
  };
  const store = new Store(join(tmp('member-world-'), 'events.jsonl'), allRoles(config));
  // No ledger dedupe or repeat window: the same call twice here is two cards or two runs, never the ledger's answer.
  const town = new Town(store, {...config, maxParallelWork: opts.parallel ?? config.maxParallelWork, effects: {dedupeHours: 0, repeatMinutes: 0}}, {test: provider});
  town.autonomy = () => 'balanced'; town.connectors = () => hub; town.personName = id => NAMES[id];
  cleanup.push(() => town.dispose(), () => hub.dispose());
  const pending = () => store.state.approvals.filter(a => a.status === 'pending');
  const statusOf = (id: string) => store.state.tasks.find(t => t.id === id)?.status ?? '';
  const settled = (id: string) => until(() => ['done', 'failed', 'cancelled'].includes(statusOf(id)) && !store.state.tasks.some(t => ['running', 'waiting', 'waiting_child'].includes(t.status)));
  const block = () => { let open = () => {}; hold = new Promise(r => open = () => { hold = null; r(); }); return open; };
  return {calls, hub, store, town, prompts, pending, statusOf, settled, block};
}
// The tasks of the tree rooted at id, and the events after index from that name one of them (by task, task id, or effect key).
const treeOf = (store: Store, root: string) => { const ids = new Set([root]); for (let grew = true; grew;) { grew = false; for (const t of store.state.tasks) if (t.parent && ids.has(t.parent) && !ids.has(t.id)) { ids.add(t.id); grew = true; } } return ids; };

test('10.6: every event a member\'s chat causes carries by, through a child, a recruit and the record; the owner\'s next chat carries none', async () => {
  const w = await world();
  const from = w.store.state.events.length;
  const root = w.town.submit('mayor', 'DELEGATE the inbox reading, please.', 'test', {by: ANA});
  await w.settled(root);
  const recruitAt = w.store.state.events.length;
  const second = w.town.submit('mayor', 'RECRUIT a writer.', 'test', {by: ANA});
  await w.settled(second);
  await until(() => !w.store.state.tasks.some(t => t.record && ['running', 'waiting'].includes(t.status)));
  const member = w.store.state.events.slice(from);
  const types = new Set(member.map(e => e.type));
  for (const t of ['task.created', 'task.updated', 'message', 'usage', 'tool.started', 'tool.finished', 'cat.created']) assert.ok(types.has(t), `the run wrote ${t}`);
  assert.deepEqual(member.filter(e => e.by !== ANA).map(e => e.type), [], 'every event of the member\'s work carries by');
  // Children inherit by, as origin; actorOf reads it.
  const child = w.store.state.tasks.find(t => t.parent === root)!;
  assert.equal(child.cat, 'scholar');
  assert.equal(child.by, ANA);
  assert.equal(w.town.actorOf(child), ANA);
  assert.ok(w.store.state.tasks.some(t => t.record && t.by === ANA), 'the recorder files the member\'s work as theirs');
  assert.ok(w.store.state.events.slice(recruitAt).some(e => e.type === 'cat.created' && e.data.name === 'Quill' && e.by === ANA), 'a recruit the member\'s Mayor made');
  // Their chat line carries their name; the Mayor's reply and the owner's lines do not.
  const line = w.store.state.messages.find(m => m.task === root && m.from === 'owner');
  assert.equal(line.name, 'Ana');
  assert.ok(w.store.state.messages.filter(m => m.task === root && m.from !== 'owner').every(m => m.name === undefined));
  assert.equal(w.store.chat('mayor', {limit: 50, tasks: 5}).messages.find((m: any) => m.task === root && m.from === 'owner').name, 'Ana', 'the chat page carries it');
  // The Mayor read it as Ana's Request, not the owner's.
  const asked = w.prompts.find(p => String(p.at(-1)?.content).includes('DELEGATE the inbox'))!;
  assert.match(String(asked.at(-1).content), /^A Request from Ana, a team member, not the owner\. [^]*\n<<<\nDELEGATE the inbox reading, please\.\n>>>$/);
  // The owner's next chat: nothing of it carries by, and Ana's words reach the Mayor's history framed as hers.
  const ownerFrom = w.store.state.events.length;
  const mine = w.town.submit('mayor', 'Just say hello.', 'test');
  await w.settled(mine);
  await until(() => !w.store.state.tasks.some(t => t.record && ['running', 'waiting'].includes(t.status)));
  assert.deepEqual(w.store.state.events.slice(ownerFrom).filter(e => e.by !== undefined).map(e => e.type), [], 'no owner event carries by');
  assert.equal(w.store.state.tasks.find(t => t.id === mine)?.by, undefined);
  assert.equal(w.store.state.messages.find(m => m.task === mine && m.from === 'owner').name, undefined);
  const history = [...w.prompts].reverse().find(p => p.at(-1)?.content === 'Just say hello.')!.map((m: any) => String(m.content));
  assert.ok(history.some(c => c.startsWith('Earlier, to mayor: A Request from Ana, a team member, not the owner.') && c.includes('DELEGATE the inbox')), 'Ana\'s words in the owner\'s history are framed as hers');
  assert.ok(!history.some(c => c.startsWith('Earlier owner to mayor: DELEGATE')), 'never as the owner\'s');
});

test('10.6: an owner message queued behind a member\'s work, picked up inside it, carries no by', async () => {
  const w = await world({parallel: 1});
  const open = w.block();
  const from = w.store.state.events.length;
  const member = w.town.submit('mayor', 'Report on the launch.', 'test', {by: ANA});
  await until(() => w.prompts.length > 0);
  const queued = w.town.submit('mayor', 'Owner here: report too.', 'test');
  assert.equal(w.statusOf(queued), 'queued', 'one slot: the owner\'s message waits in the inbox');
  // Its own drain check runs now and finds no slot, so the pickup comes from the drain check the member's last emit arms, inside their work.
  await new Promise(r => setImmediate(r));
  open();
  await w.settled(member); await w.settled(queued);
  await until(() => !w.store.state.tasks.some(t => t.record && ['running', 'waiting'].includes(t.status)));
  const tree = (id: string) => treeOf(w.store, id);
  const ana = tree(member), own = tree(queued);
  const of = (ids: Set<string>) => (e: Event) => ids.has(e.data?.task) || (e.type.startsWith('task.') && ids.has(e.data?.id));
  const events = w.store.state.events.slice(from);
  assert.ok(events.filter(of(own)).length >= 4);
  assert.deepEqual(events.filter(of(own)).filter(e => e.by).map(e => e.type), [], 'the owner\'s pickup and run carry no by');
  assert.deepEqual(events.filter(of(ana)).filter(e => e.by !== ANA).map(e => e.type), []);
});

test('10.7: the member\'s own decision: a question in their tree, answered by them, journaled as theirs', async () => {
  const w = await world();
  const id = w.town.submit('mayor', 'ASK me which colour.', 'test', {by: ANA});
  await until(() => w.pending().length > 0);
  const [card] = w.pending();
  assert.equal(card!.gate, undefined);
  assert.equal(w.town.mayDecide(card!, ANA), true);
  w.town.decide(card!.id, 'Blue', true, 'ana-phone', ANA);
  await w.settled(id);
  const resolved = w.store.state.events.find(e => e.type === 'approval.resolved' && e.data.id === card!.id)!;
  assert.equal(resolved.by, ANA, 'the answer is Ana\'s');
  assert.equal(w.store.state.messages.find(m => m.task === id && m.text === 'Approved: Blue')?.name, 'Ana');
  assert.equal(w.statusOf(id), 'done');
});

test('10.7: someone else\'s decision: the owner\'s question and another member\'s wait for their own answer; the owner answers any, as the owner', async () => {
  const w = await world();
  const owners = w.town.submit('mayor', 'ASK me which colour.', 'test');
  await until(() => w.pending().length === 1);
  const own = w.pending()[0]!;
  assert.equal(w.town.mayDecide(own, ANA), false);
  assert.throws(() => w.town.decide(own.id, 'Blue', true, 'ana-phone', ANA), (e: any) => e.statusCode === 403 && /waits for the owner/.test(e.message));
  w.town.decide(own.id, 'Green', true);
  await w.settled(owners);
  const bens = w.town.submit('mayor', 'ASK me which colour.', 'test', {by: BEN});
  await until(() => w.pending().length === 1);
  const ben = w.pending()[0]!;
  assert.throws(() => w.town.decide(ben.id, 'Blue', true, 'ana-phone', ANA), /waits for the owner/, 'Ana cannot answer Ben\'s');
  assert.equal(w.pending().length, 1, 'nothing was answered');
  w.town.decide(ben.id, 'Blue', true);
  await w.settled(bens);
  for (const id of [own.id, ben.id]) assert.equal(w.store.state.events.find(e => e.type === 'approval.resolved' && e.data.id === id)?.by, undefined, 'the owner\'s answer carries no by');
  assert.equal(w.store.state.messages.find(m => m.task === bens && m.text === 'Approved: Blue')?.name, undefined, 'the owner said it, not Ben');
});

test('10.7: an owner-only account in a member\'s tree is the owner\'s card, whatever Always allow says; a team-scoped one is the member\'s, Allow once only', async () => {
  const w = await world();
  const id = w.town.submit('mayor', 'CALL read_inbox now.', 'test', {by: ANA});
  await until(() => w.pending().length > 0);
  const [card] = w.pending();
  assert.equal(card!.ownerOnly, true);
  assert.deepEqual(w.calls, [], 'nothing ran under Always allow');
  assert.throws(() => w.town.decide(card!.id, ALLOW_ONCE, true, 'ana-phone', ANA), /waits for the owner/);
  w.town.decide(card!.id, ALLOW_ONCE, true);
  await w.settled(id);
  assert.deepEqual(w.calls, ['read_inbox']);
  assert.equal(w.store.state.events.find(e => e.type === 'tool.finished' && e.data.task === id && e.data.name === fn('read_inbox'))?.by, ANA, 'the run it resumed is still Ana\'s');
  // Team-scoped, with the tool on ask: Ana's card, but an Always allow from her would change the owner's settings.
  w.hub.setScope('mail', 'team');
  w.hub.patchConnector('mail', {tools: {read_inbox: 'ask'}});
  const again = w.town.submit('mayor', 'CALL read_inbox again.', 'test', {by: ANA});
  await until(() => w.pending().length > 0);
  const team = w.pending()[0]!;
  assert.equal(team.ownerOnly, undefined);
  assert.equal(w.town.mayDecide(team, ANA), true);
  assert.equal(w.town.mayDecide(team, BEN), false, 'not Ben\'s');
  assert.throws(() => w.town.decide(team.id, EVERY_CAT, true, 'ana-phone', ANA), /Only the owner can choose Always allow/);
  assert.equal(w.hub.resolve('mayor', fn('read_inbox'))?.permission, 'ask', 'the setting did not change');
  w.town.decide(team.id, ALLOW_ONCE, true, 'ana-phone', ANA);
  await w.settled(again);
  assert.deepEqual(w.calls, ['read_inbox', 'read_inbox']);
});

test('10.7: a money call in a member\'s tree is Allow once and the owner\'s, even on a team-scoped account under Always allow; a purchase skips Autopay', async () => {
  const w = await world();
  w.hub.setScope('mail', 'team');
  // The control: the owner's own call runs at once under Always allow.
  const owners = w.town.submit('mayor', 'CALL pay_invoice for me.', 'test');
  await w.settled(owners);
  assert.deepEqual(w.calls, ['pay_invoice']);
  const id = w.town.submit('mayor', 'CALL pay_invoice for the team.', 'test', {by: ANA});
  await until(() => w.pending().length > 0);
  const [card] = w.pending();
  assert.equal(card!.effectClass, 'money');
  assert.deepEqual(card!.options, [ALLOW_ONCE, 'Deny'], 'no Always allow');
  assert.equal(card!.ownerOnly, true);
  assert.match(card!.question, /A team member’s work asked for this money call/);
  assert.throws(() => w.town.decide(card!.id, ALLOW_ONCE, true, 'ana-phone', ANA), /waits for the owner/);
  assert.deepEqual(w.calls, ['pay_invoice'], 'nothing ran');
  w.town.decide(card!.id, ALLOW_ONCE, true);
  await w.settled(id);
  assert.deepEqual(w.calls, ['pay_invoice', 'pay_invoice']);
  // A real-money purchase in a member's tree skipping Autopay: test/real-money.test.ts, beside the For you one.
});

test('10.7: browse in a member\'s tree asks every time and only the owner answers; Hermes mode and other cats are refused to a member', async () => {
  const w = await world();
  w.town.claudePlan = () => ({kind: 'claude', defaultModel: 'm'} as any);
  w.town.browserWindow = async () => 'ws://127.0.0.1:1/devtools';
  const browse: Provider = async messages => messages.some(m => m.role === 'tool') || String(messages.at(-1)?.content ?? '').startsWith('Record for the town') ? reply('ok') : callOf('browse', {task: 'Look', url: 'https://site.example/'});
  w.town.providers.browse = browse;
  w.hub.patchConnector('browser:site.example', {tools: {browse: 'allow'}});
  const id = w.town.submit('mayor', 'Look at the site.', 'browse', {by: ANA});
  await until(() => w.pending().length > 0);
  const [card] = w.pending();
  assert.equal(card!.ownerOnly, true);
  assert.deepEqual(card!.options, [ALLOW_ONCE, 'Deny']);
  assert.throws(() => w.town.decide(card!.id, ALLOW_ONCE, true, 'ana-phone', ANA), /waits for the owner/);
  w.town.decide(card!.id, 'Deny', false);
  await w.settled(id);
  assert.throws(() => w.town.submit('mayor', 'Hi', 'hermes', {by: ANA}), /Clowder model/);
  assert.throws(() => w.town.submit('scholar', 'Hi', 'test', {by: ANA}), /talk to the Mayor/);
  assert.throws(() => w.town.submit('mayor', 'Hi', 'test', {by: 'owner'}), /talk to the Mayor/, 'by is never the owner');
});

// The 19 owner checks of §4.5 (18 in engine.ts, 1 in council.ts). A member's actor value is their person id, which is never 'owner' nor a cat id,
// so each one refuses it before it changes anything.
test('10.7: a member actor fails closed at every owner check in the engine and the council', async () => {
  const w = await world();
  const t = w.town, M = ANA, cat = 'scholar';
  const checks: [string, () => unknown, RegExp][] = [
    ['cancelQueued', () => t.cancelQueued(M, 'x'), /Only the owner can cancel/],
    ['road', () => t.road(M, 'mayor', cat), /Only the Mayor or owner can connect/],
    ['recruit', () => t.recruit(M, 'Mallory', 'Spy'), /Only the Mayor or owner can recruit/],
    ['setCatAi', () => t.setCatAi(M, cat, 'claude', {}), /Only the owner can change a cat/],
    ['answerCatAi', () => t.answerCatAi(M, cat, true), /Only the owner can answer a model suggestion/],
    ['styleHome', () => t.styleHome(M, cat, 'cottage'), /Cats can redesign only their own home/],
    ['lookHome', () => t.lookHome(M, cat, {}), /Only the owner can customize homes/],
    ['moveHome', () => t.moveHome(M, cat, 0, 0), /Only the owner can move homes/],
    ['customizeCat', () => t.customizeCat(M, cat, {}), /Only the owner can customize cats/],
    ['goalAction', () => t.goalAction(M, 'g', 'pause'), /Only the owner can change a goal\./],
    ['setGoalBudget', () => t.setGoalBudget(M, 'g', {}), /Only the owner can change a goal’s budget/],
    ['archiveGoal', () => t.archiveGoal(M, 'g', 'r'), /Only the owner or the Mayor can remove a goal/],
    ['ownerStepDone', () => t.ownerStepDone(M, 's', ''), /Only the owner can mark a step done/],
    ['ownerStepDismiss', () => t.ownerStepDismiss(M, 's'), /Only the owner can remove a step/],
    ['ownerStepTick', () => t.ownerStepTick(M, 's', 0, true), /Only the owner can tick a step/],
    ['hideQuest', () => t.hideQuest(M, 'q', null), /Only the owner can hide a quest/],
    ['handoffQuest', () => t.handoffQuest(M, 'q'), /Only the owner can hand off a quest/],
    ['stop', () => t.stop(M, 'x'), /Only the owner can stop work/],
    ['setUsageCap', () => t.setUsageCap(M, 1000), /Only the owner can set the token cap/],
    ['council', () => t.council(M, cat, 'r', ['x'], 'test'), /Unknown cat/],
  ];
  assert.equal(checks.length, 20);
  const before = w.store.state.events.length;
  for (const [name, call, refusal] of checks) assert.throws(call, refusal, name);
  assert.equal(w.store.state.events.length, before, 'nothing was written');
  const source = readFileSync(new URL('../src/engine.ts', import.meta.url), 'utf8') + readFileSync(new URL('../src/council.ts', import.meta.url), 'utf8');
  assert.equal(source.match(/actor!=='owner'/g)?.length, 20, 'a new owner check joins this table');
});
