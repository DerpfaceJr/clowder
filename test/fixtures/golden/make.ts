// Regenerates the golden journal: `npx tsx test/fixtures/golden/make.ts`.
// Runs Store + Town on a throwaway journal with scripted providers and made-up names, then adds, through Store.emit, every event type
// the run did not produce, so apply() sees each type. Never reads %APPDATA% or any real world.
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {allRoles} from '../../../src/roles.ts';
import {Town} from '../../../src/engine.ts';
import {Store, roadId} from '../../../src/store.ts';
import type {Provider} from '../../../src/provider.ts';
import {stateHash} from './state-hash.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(HERE, '..', '..', '..', 'town.config.json'), 'utf8'));
const reply = (content: string) => ({message: {role: 'assistant', content}});
const provider: Provider = async () => reply('Made-up report: the scholar read three invented notes about a made-up river.');
const until = async (fn: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('Timed out waiting for the scripted run.');
};

const dir = mkdtempSync(join(tmpdir(), 'golden-'));
const file = join(dir, 'events.jsonl');
const store = new Store(file, allRoles(config));
const town = new Town(store, config, {test: provider});
town.connectors = () => null;

const statusOf = (id: string) => store.state.tasks.find(t => t.id === id)?.status ?? '';
const finished = ['done', 'failed', 'cancelled', 'interrupted'];
const first = town.submit('mayor', 'Summarise the made-up river notes.', 'test');
const second = town.submit('scholar', 'Read the invented notes.', 'test');
await until(() => finished.includes(statusOf(first)) && finished.includes(statusOf(second)));
town.dispose();

// Every type the run did not emit is added here, with made-up data, through the same emit path a real event takes.
const seen = () => new Set(store.state.events.map(e => e.type));
const scripted = seen().size;
const ensure = (type: string, data: any) => { if (!seen().has(type)) store.emit(type, data); };
const taskId = store.state.tasks[0]!.id;
const home = {x: 4, z: 6, style: 'cottage'};
const sage = {id: 'sage', name: 'Sage', role: 'Keep the made-up herbarium.', color: '#7fb07f', icon: '*'};
const sageRoads = [{id: roadId('mayor', 'sage'), a: 'mayor', b: 'sage', messages: 0}];

ensure('cat.created', sage);
ensure('cat.customized', {id: 'scholar', appearance: {chroma: 'mint'}});
ensure('cat.ai', {id: 'scholar', provider: 'local', model: 'made-up-model', effort: 'low'});
ensure('cat.ai.suggested', {id: 'sage', suggestion: {provider: 'local', model: 'made-up-model', reason: 'Made-up reason.'}});
ensure('cat.skills', {id: 'scholar', skills: ['writing']});
ensure('road.created', {id: roadId('archivist', 'scholar'), a: 'archivist', b: 'scholar'});
ensure('group.founded', {id: 'group-river', name: 'Riverside', lead: 'scholar', site: {index: 1, x: 0, z: 0}, rootTask: null});
ensure('town.planned', {groups: store.state.groups, homes: [], version: store.state.layoutVersion});
ensure('homes.planned', {homes: [{id: 'archivist', home, group: 'main'}]});
ensure('looks.planned', {looks: [{id: 'sage', look: {chroma: 'mint'}}]});
ensure('home.styled', {id: 'scholar', style: 'cottage', color: '#c08050', icon: '#'});
ensure('home.moved', {id: 'scholar', home});
ensure('home.looked', {id: 'scholar'});
ensure('message', {from: 'mayor', to: 'scholar', text: 'Made-up note for the scholar.', task: taskId, mode: 'test'});
ensure('approval.requested', {id: 'approval-1', task: taskId, cat: 'scholar', question: 'Made-up question?', options: ['Allow once', 'Deny'], status: 'pending', toolCallId: 'call-1', turn: 1, depth: 0});
ensure('approval.resolved', {id: 'approval-1', status: 'cancelled', answer: 'Made-up answer.'});
ensure('paused', {value: true});
ensure('paused', {value: false});
ensure('usage', {task: taskId, cat: 'scholar', mode: 'test', input: 120, output: 40, cost: null});
ensure('usage.cap', {tokens: 1000000});
ensure('usage.cap.override', {month: '2026-11'});
ensure('treasury.recorded', {amountMinor: 1200, currency: 'USD', note: 'Made-up note.', source: 'owner-recorded'});
ensure('purchase.paid', {key: 'purchase-1', currency: 'USD', paidMinor: 300});
ensure('owner.step', {id: 'step-1', goal: null, cat: 'scholar', title: 'Made-up step', steps: 'Open the made-up page.', blocking: false, kind: 'account'});
ensure('owner.step', {id: 'step-2', goal: null, cat: 'scholar', title: 'Second made-up step', steps: 'Ignore it.', blocking: false, kind: 'design'});
ensure('owner.step.sign-in', {id: 'step-1'});
ensure('owner.step.done', {id: 'step-1', note: 'Done.'});
ensure('owner.step.dismissed', {id: 'step-2'});
ensure('quest.hidden', {id: 'quest-1', at: '2026-11-07T00:00:00.000Z'});
ensure('quest.handoff', {id: 'quest-1'});
ensure('goal.created', {id: 'goal-1', title: 'Made-up goal', success: 'Made-up success.', status: 'active', mode: 'test', rounds: 0, roundsToday: 0, day: '2026-11-07', failures: 0, log: [], summary: null});
ensure('goal.updated', {id: 'goal-1', status: 'paused', logLine: 'Made-up line.'});
ensure('goal.archived', {id: 'goal-1'});
ensure('effect.intended', {key: 'effect-1', account: 'made-up-account', tool: 'publish', hash: '0'.repeat(64), kind: 'public', cat: 'scholar', task: taskId});
ensure('effect.done', {key: 'effect-1', result: 'ok'});
ensure('effect.intended', {key: 'effect-2', account: 'made-up-account', tool: 'publish', hash: '1'.repeat(64), kind: 'public', cat: 'scholar', task: taskId});
ensure('effect.failed', {key: 'effect-2', error: 'Made-up error.'});
ensure('effect.intended', {key: 'effect-3', account: 'made-up-account', tool: 'publish', hash: '2'.repeat(64), kind: 'public', cat: 'scholar', task: taskId});
ensure('effect.unknown', {key: 'effect-3', error: 'Made-up timeout.'});
ensure('account.state', {id: 'made-up-account', to: 'ok', from: 'unknown', service: 'made-up', label: 'Made-up account', identity: null, expected: null, reason: 'Made-up.', by: 'probe', since: 0, step: null});
ensure('routine.saved', {id: 'routine-1', title: 'Made-up routine', prompt: 'Made-up prompt.', cat: 'scholar', schedule: null, mode: 'test', tokenBudget: null, enabled: false});
ensure('routine.ran', {id: 'routine-1', lastRunAt: '2026-11-07T00:00:00.000Z', note: null, task: taskId});
ensure('routine.saved', {id: 'routine-2', title: 'Second made-up routine', prompt: 'Unused.', cat: 'scholar', schedule: null, mode: 'test', tokenBudget: null, enabled: false});
ensure('routine.removed', {id: 'routine-2'});
ensure('council.opened', {id: 'council-1', target: 'sage', proposer: 'mayor', reason: 'Made-up reason.', evidence: [], electorate: ['scholar'], mode: 'test'});
ensure('council.voted', {id: 'council-1', ballot: {cat: 'scholar', vote: 'retire', reason: 'Made-up reason.'}});
ensure('council.closed', {id: 'council-1', status: 'retired', result: 'Made-up result.'});
ensure('cat.restored', {cat: sage, roads: sageRoads});
ensure('task.created', {id: 'task-extra', cat: 'scholar', from: 'owner', text: 'Made-up extra task.', mode: 'test', status: 'done'});
ensure('task.updated', {id: 'task-extra', result: 'Made-up result.'});

writeFileSync(join(HERE, 'events.jsonl'), readFileSync(file));
writeFileSync(join(HERE, 'state.sha256'), stateHash(store.state) + '\n');
rmSync(dir, {recursive: true, force: true});
console.log(`wrote ${store.state.events.length} events (${scripted} types from the scripted run, the rest through emit), state ${stateHash(store.state).slice(0, 12)}`);
