// Plain-language approval cards (plan 3.6): each template from realistic arguments, the fallback, masking, and the card on the approval event.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConnectorHub} from '../src/connectors.ts';
import {allRoles} from '../src/roles.ts';
import {Town} from '../src/engine.ts';
import {Store} from '../src/store.ts';
import {cardFor} from '../src/card-templates.ts';
import type {Provider} from '../src/provider.ts';

const config = JSON.parse(readFileSync(new URL('../town.config.json', import.meta.url), 'utf8'));
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

test('browse: site and task, masked token, browser named', () => {
  const card = cardFor('browse', {task: 'Find the opening hours of the Cat Cafe on Main St\nthen note them', url: 'https://www.example-cafe.org/hours'}, {browser: "the cats' browser"});
  assert.deepEqual(card, {
    what: 'Browse: Find the opening hours of the Cat Cafe on Main St',
    where: "www.example-cafe.org, the cats' browser",
    who_sees: 'The sites it visits, and anything it types or submits there',
    undo: 'Cannot be undone from Clowder; check the site afterwards',
  });
  const masked = cardFor('browse', {task: 'Log in with access_token=EAAB1234567890abcdefXYZ and check the feed'}, {browser: 'your Chrome'})!;
  assert.match(masked.what, /••••fXYZ/);
  assert.ok(!masked.what.includes('EAAB1234567890'), 'the full token never reaches the card');
});

test('push_files: repo, branch, file count, first three paths', () => {
  const files = ['notes/a.md', 'notes/b.md', 'README.md', 'x/y.md'].map(path => ({path, content: '# hi'}));
  assert.deepEqual(cardFor('push_files', {owner: 'derpfacejr', repo: 'cat-town-notes', branch: 'main', message: 'Sync notes', files}, {label: 'GitHub'}), {
    what: 'Push 4 files: notes/a.md, notes/b.md, README.md and 1 more',
    where: 'GitHub: derpfacejr/cat-town-notes, branch main',
    who_sees: 'Anyone who can see the repo (visibility not checked)',
    undo: 'Revert the commit on GitHub; the old files stay in its history',
  });
});

test('create_repository: private flag decides who sees it', () => {
  const priv = cardFor('create_repository', {name: 'cat-garden', private: true, description: 'Plants'}, {label: 'GitHub'})!;
  assert.deepEqual(priv, {what: 'Create repository cat-garden', where: 'GitHub', who_sees: 'Only you (private repo)', undo: 'Delete the repo on GitHub; its contents go with it'});
  assert.equal(cardFor('create_repository', {name: 'cat-garden'}, {label: 'GitHub'})!.who_sees, 'Anyone on the internet (public repo)');
});

test('create_or_update_file: the path and the branch', () => {
  assert.deepEqual(cardFor('create_or_update_file', {owner: 'derpfacejr', repo: 'cat-town-notes', path: 'docs/plan.md', content: 'x', message: 'Add plan', branch: 'main'}, {label: 'GitHub'}), {
    what: 'Create or update docs/plan.md',
    where: 'GitHub: derpfacejr/cat-town-notes, branch main',
    who_sees: 'Anyone who can see the repo (visibility not checked)',
    undo: 'Revert the commit on GitHub; the old files stay in its history',
  });
});

test('publish_reel: handle from the verified identity, caption first line, public', () => {
  assert.deepEqual(cardFor('publish_reel', {video: 'clip.mp4', caption: 'Cats at dusk\n#catsoftown #cats'}, {label: 'Instagram', identity: '@cattown.daily'}), {
    what: 'Post a reel to @cattown.daily: “Cats at dusk”',
    where: 'Instagram, @cattown.daily',
    who_sees: 'Everyone, public on Instagram',
    undo: 'Delete it in Instagram; anyone who already saw it keeps that',
  });
  assert.equal(cardFor('publish_reel', {video: 'clip.mp4'}, {label: 'Instagram'})!.what, 'Post a reel to the connected account');
});

test('stripe_api_write: object, amount in minor units, undo by method', () => {
  assert.deepEqual(cardFor('stripe_api_write', {method: 'POST', path: '/v1/refunds', params: {charge: 'ch_123', amount: 1250, currency: 'usd'}}, {label: 'Stripe'}), {
    what: 'Create or change refunds, 12.50 USD',
    where: 'Stripe',
    who_sees: 'Your Stripe account, and the customer on the object',
    undo: 'Reverse it in the Stripe dashboard; Clowder does not undo money moves',
  });
  assert.equal(cardFor('stripe_api_write', {method: 'DELETE', path: '/v1/customers/cus_9'}, {label: 'Stripe'})!.what, 'Delete customers');
});

test('unknown tools fall back to today\'s text; a secret from the saved values is masked', () => {
  assert.equal(cardFor('list_issues', {repo: 'x'}), undefined);
  const card = cardFor('publish_reel', {caption: 'Use hunter2-secret-value today'}, {label: 'Instagram', identity: '@cattown.daily', secrets: ['hunter2-secret-value']})!;
  assert.ok(!card.what.includes('hunter2-secret-value'));
  assert.match(card.what, /••••alue/);
});

// The approval event itself: a connector call on Ask carries the card next to question and detail.
function service() {
  const calls: any[] = [];
  const client = {
    info: {}, close: async () => {},
    listTools: async () => [{name: 'publish_reel', inputSchema: {type: 'object'}}],
    callTool: async (_name: string, args: any) => { calls.push(args); return {text: '{"id":"media-1"}', isError: false}; },
  };
  return {client, calls};
}
async function until(fn: () => boolean) { for (let i = 0; i < 500; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); } assert.fail('Timed out waiting for state transition'); }

test('the connector approval event carries card beside question and detail', async () => {
  const svc = service();
  const hub = new ConnectorHub({dataDir: tmp('card-hub-'), port: 4322, home: tmp('card-home-'), connect: (async () => svc.client) as any});
  hub.addCustom({name: 'Instagram', type: 'http', url: 'https://example.com/mcp'});
  hub.patchConnector('instagram', {enabled: true, cats: ['scholar'], tools: {publish_reel: 'ask'}});
  await until(() => hub.publicConnectors().find(c => c.id === 'instagram')?.status === 'connected');
  const plan = [['mcp__instagram__publish_reel', {video: 'clip.mp4', caption: 'Cats at dusk'}]] as const;
  const provider: Provider = async messages => {
    const done = messages.filter(m => m.role === 'tool').length;
    if (done === 0) return {message: {role: 'assistant', content: null, tool_calls: [{id: 'call-0', type: 'function', function: {name: plan[0][0], arguments: JSON.stringify(plan[0][1])}}]}};
    return {message: {role: 'assistant', content: 'Report.'}};
  };
  const store = new Store(join(tmp('card-'), 'events.jsonl'), allRoles(config));
  const town = new Town(store, config, {test: provider});
  town.connectors = () => hub;
  try {
    town.submit('scholar', 'Post a reel', 'test');
    await until(() => store.state.approvals.some(a => a.status === 'pending'));
    const [a] = store.state.approvals.filter(a => a.status === 'pending');
    assert.equal(a.gate, 'connector');
    assert.match(a.question, /wants to use .*: publish_reel$/);
    assert.ok(a.detail?.includes('Cats at dusk'), 'detail stays for old clients');
    assert.deepEqual(Object.keys(a.card!).sort(), ['undo', 'what', 'where', 'who_sees']);
    assert.match(a.card!.what, /^Post a reel to the connected account: “Cats at dusk”$/);
    assert.equal(svc.calls.length, 0, 'nothing runs before the owner answers');
  } finally { await hub.dispose(); }
});
