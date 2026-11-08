import test from 'node:test';
import assert from 'node:assert/strict';
import {catGroups, groupIsOpen} from '../public/cat-groups.js';

// Shapes copied from a real town journal (cat.created, group.founded, goal.created): role text in full, directs as a goal id or a request's root task id.
const REEL_GOAL = '4c2aaf41-e838-4587-a357-9e5432c288b0';
const LAUNCH = '3e41e037-ec81-45c9-84cc-495d33fe75f6';
const cat = (id, name, role, extra = {}) => ({id, name, role, color: '#fff', icon: '*', ...extra});
const cats = [
  cat('mayor', 'Mayor', 'Coordinate the town. Delegate by expertise.', {group: 'main'}),
  cat('director_reel', 'Director Reel', 'Directs the Instagram launch: niche strategy, content production, and growth plan. Delivers drafts only; the owner publishes.', {manager: 'mayor', directs: REEL_GOAL, group: 'g1'}),
  cat('scout_trend', 'Scout Trend', 'Researcher for the Instagram launch.', {manager: 'director_reel', group: 'g1'}),
  cat('frame_weaver', 'Frame Weaver', 'Content and visual creator for the Instagram launch.', {manager: 'director_reel', group: 'g1'}),
  cat('cut_critic', 'Cut Critic', 'Critic for the Instagram launch. Reviews drafts.', {manager: 'director_reel', group: 'g1'}),
  cat('scholar', 'Scholar', 'Research opportunities. Distinguish verified facts.', {group: 'main'}),
  cat('draft_paw', 'Draft Paw', 'High-volume content drafter for the Instagram launch.', {group: 'g2'}),
  cat('archivist', 'Archivist', 'Summarize evidence and lessons with provenance.', {group: 'main'}),
  cat('director_splice', 'Director Splice', 'Direct the project “Scrapbook MV Studio: paid edit service”: plan the work, recruit up to 4 reports, delegate to them, and send the Mayor one structured report.', {manager: 'mayor', directs: LAUNCH, group: 'g3'}),
  cat('tier_tag', 'Tier Tag', 'Merchant drafter for the Scrapbook MV Studio paid edit service.', {manager: 'director_splice', group: 'g3'}),
  cat('cue_sheet', 'Cue Sheet', 'Operator for the Scrapbook MV Studio paid edit service.', {manager: 'director_splice', group: 'g3'}),
  cat('frame_check', 'Frame Check', 'Critic for the Scrapbook MV Studio paid edit service.', {manager: 'director_splice', group: 'g3'}),
  cat('director_ledger', 'Director Ledger', 'Direct the project “Liquidity Hunter: paid trading-education product”: plan the work, recruit up to 4 reports, delegate to them, and send the Mayor one structured report.', {manager: 'mayor', directs: LAUNCH, group: 'g3'}),
  cat('ledger_quill', 'Ledger Quill', 'Merchant drafter for the Liquidity Hunter trading-education product.', {manager: 'director_ledger', group: 'g3'}),
  cat('ledger_lens', 'Ledger Lens', 'Critic for the Liquidity Hunter trading-education product.', {manager: 'director_ledger', group: 'g3'}),
  cat('stray', 'Stray Cat', 'Left behind by a retired director.', {manager: 'retired_director', group: 'g4'}),
  cat('loop_a', 'Loop A', 'Reports to loop B.', {manager: 'loop_b', group: 'main'}),
  cat('loop_b', 'Loop B', 'Reports to loop A.', {manager: 'loop_a', group: 'main'}),
];
const groups = [
  {id: 'main', name: 'Town centre', lead: 'mayor', rootTask: null},
  {id: 'g1', name: 'Instagram Launch & Growth', lead: 'director_reel', rootTask: REEL_GOAL},
  {id: 'g2', name: 'Yes decide on what for haiku', lead: 'draft_paw', rootTask: '275189b8-3129-42fd-96be-d55c83a5216c'},
  {id: 'g3', name: 'Scrapbook MV Studio: paid…', lead: 'director_splice', rootTask: LAUNCH},
];
const goals = [{id: REEL_GOAL, title: 'Make an instagram account and go viral with it'}];
const tasks = [{id: LAUNCH, text: 'Build the Scrapbook and Liquidity Hunter paid products'}];
const ids = group => group.cats.map(c => c.id);
const byKey = (list, key) => list.find(g => g.key === key);

test('groups are Town, one per director in order, then Unassigned', () => {
  const list = catGroups(cats, {groups, goals, tasks});
  assert.deepEqual(list.map(g => g.key), ['town', `lead:director_reel`, `lead:director_splice`, `lead:director_ledger`, 'unassigned']);
  assert.deepEqual(list.map(g => g.kind), ['town', 'project', 'project', 'project', 'unassigned']);
});

test('every cat lands in exactly one group', () => {
  const placed = catGroups(cats, {groups, goals, tasks}).flatMap(ids);
  assert.equal(placed.length, cats.length);
  assert.deepEqual([...placed].sort(), cats.map(c => c.id).sort());
});

test('Town holds the Mayor first, then the town-centre cats', () => {
  assert.deepEqual(ids(byKey(catGroups(cats, {groups, goals, tasks}), 'town')), ['mayor', 'scholar', 'archivist']);
  const reordered = catGroups([cats[5], ...cats.slice(0, 5), ...cats.slice(6)], {groups, goals, tasks});
  assert.equal(ids(byKey(reordered, 'town'))[0], 'mayor');
});

test('a director leads its group, followed by its own team', () => {
  const list = catGroups(cats, {groups, goals, tasks});
  assert.deepEqual(ids(byKey(list, 'lead:director_reel')), ['director_reel', 'scout_trend', 'frame_weaver', 'cut_critic']);
  assert.deepEqual(ids(byKey(list, 'lead:director_splice')), ['director_splice', 'tier_tag', 'cue_sheet', 'frame_check']);
  assert.equal(byKey(list, 'lead:director_splice').lead.id, 'director_splice');
});

test('two directors sharing one project key stay in separate groups', () => {
  const list = catGroups(cats, {groups, goals, tasks});
  assert.deepEqual(ids(byKey(list, 'lead:director_ledger')), ['director_ledger', 'ledger_quill', 'ledger_lens']);
  assert.ok(!ids(byKey(list, 'lead:director_splice')).includes('ledger_quill'));
});

test('titles: the Mayor-given project name, else the goal, else the hamlet name', () => {
  const list = catGroups(cats, {groups, goals, tasks});
  assert.equal(byKey(list, 'lead:director_splice').title, 'Scrapbook MV Studio: paid edit service');
  assert.equal(byKey(list, 'lead:director_ledger').title, 'Liquidity Hunter: paid trading-education product');
  assert.equal(byKey(list, 'lead:director_reel').title, 'Make an instagram account and go viral with it');
  assert.equal(byKey(list, 'town').title, 'Town');
  assert.equal(byKey(list, 'unassigned').title, 'Unassigned');
});

test('the hamlet name is the last resort for a custom role with no goal', () => {
  const plain = [cat('director_x', 'Director X', 'Runs a thing.', {manager: 'mayor', directs: 'req-1', group: 'g9'})];
  const list = catGroups(plain, {groups: [{id: 'g9', name: 'Quiet Hamlet', lead: 'director_x', rootTask: 'req-1'}]});
  assert.equal(list[0].title, 'Quiet Hamlet');
});

test('Unassigned: a retired manager, a manager loop, and a manager-less cat in a project hamlet', () => {
  const list = catGroups(cats, {groups, goals, tasks});
  assert.deepEqual(ids(byKey(list, 'unassigned')), ['draft_paw', 'stray', 'loop_a', 'loop_b']);
});

test('a working cat marks its group, and nothing else', () => {
  const list = catGroups(cats, {groups, goals, tasks, isWorking: id => id === 'cut_critic'});
  assert.equal(byKey(list, 'lead:director_reel').working, true);
  assert.equal(byKey(list, 'lead:director_splice').working, false);
  assert.equal(byKey(list, 'town').working, false);
});

test('a filter matches name or role and drops groups with no match', () => {
  const list = catGroups(cats, {groups, goals, tasks, query: '  CRITIC '});
  assert.deepEqual(list.map(g => g.key), ['lead:director_reel', 'lead:director_splice', 'lead:director_ledger']);
  assert.deepEqual(list.map(ids), [['cut_critic'], ['frame_check'], ['ledger_lens']]);
  assert.equal(catGroups(cats, {groups, goals, tasks, query: 'zzz'}).length, 0);
  assert.deepEqual(ids(byKey(catGroups(cats, {groups, goals, tasks, query: 'reel'}), 'lead:director_reel')), ['director_reel']);
});

test('a group opens when its saved choice says so, else when a cat in it works', () => {
  const idle = {key: 'town', working: false};
  const busy = {key: 'lead:x', working: true};
  assert.equal(groupIsOpen(idle), false);
  assert.equal(groupIsOpen(busy), true);
  assert.equal(groupIsOpen(busy, {saved: 'closed'}), false);
  assert.equal(groupIsOpen(idle, {saved: 'open'}), true);
  assert.equal(groupIsOpen(idle, {saved: 'closed', query: 'cat'}), true);
});
