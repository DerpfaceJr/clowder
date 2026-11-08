// Directors: the Mayor appoints a director for a project; the director recruits up to four reports into the project
// hamlet, delegates only to them, and its report comes back to the Mayor. Scripted models only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store, roadId} from '../src/store.ts';
import {Town} from '../src/engine.ts';
import {allRoles} from '../src/roles.ts';
import {demoProvider, directorTools, mayorTools, workerTools} from '../src/provider.ts';

const config = JSON.parse(readFileSync(new URL('../town.config.json', import.meta.url), 'utf8'));
const fixture = () => {
  const file = join(mkdtempSync(join(tmpdir(), 'directors-')), 'events.jsonl');
  const store = new Store(file, allRoles(config));
  return {store, town: new Town(store, config)};
};
const calls = (...list: [string, unknown][]) => ({role: 'assistant', content: null, tool_calls: list.map(([name, args]) => ({id: `${name}-${Math.random()}`, type: 'function', function: {name, arguments: JSON.stringify(args)}}))});
const say = (content: string) => ({role: 'assistant', content});
const catOf = (messages: any[]) => /CAT_ID=(\w+)/.exec(String(messages[0].content))?.[1] ?? '';
const toolResults = (ctx: {messages: any[]}) => ctx.messages.filter(m => m.role === 'tool').map(m => String(m.content)).join('\n');
const finished = (store: Store, name: string) => store.state.events.filter(e => e.type === 'tool.finished' && e.data.name === name).map(e => String(e.data.result));
// Each cat takes its own script, one step per model call. A step may act on the town before it answers.
function scripted(town: Town, steps: Record<string, Array<(messages: any[], tools: any[]) => any>>) {
  const seen: Record<string, string[][]> = {};
  const at: Record<string, number> = {};
  town.providers.test = async (messages, tools) => {
    const cat = catOf(messages);
    (seen[cat] ??= []).push(tools.map((t: any) => t.function.name));
    const i = at[cat] ?? 0;
    at[cat] = i + 1;
    const step = steps[cat]?.[i];
    return {message: step ? step(messages, tools) : say(`${cat} has nothing more to do.`)};
  };
  return seen;
}
async function runMayor(town: Town, text: string) {
  const task = town.createTask('mayor', 'owner', text, 'test');
  const ctx = town.context(task, 0);
  await town.run(task, ctx);
  return {task, ctx};
}

test('the Mayor appoints a director: it takes the project hamlet, gets the brief, and its report comes back', async () => {
  const {store, town} = fixture();
  const seen = scripted(town, {
    mayor: [() => calls(['appoint_director', {project: 'Viral Instagram', brief: 'Make three reels and post them.'}]), () => say('Project under way.')],
    director_1: [() => say('Status: on track.')],
  });
  const {task, ctx} = await runMayor(town, 'Make viral content and post on Instagram');
  const director = store.state.cats.find(c => c.directs)!;
  assert.equal(director.id, 'director_1');
  assert.equal(director.manager, 'mayor');
  assert.equal(director.directs, task.id, 'directs the owner request that is the project');
  const hamlet = store.state.groups.find(g => g.rootTask === task.id)!;
  assert.ok(hamlet, 'the project founds its own hamlet');
  assert.equal(director.group, hamlet.id, 'the director house settles in the project hamlet');
  assert.notEqual(store.state.cats.find(c => c.id === 'mayor')!.group, hamlet.id);
  assert.equal(hamlet.lead, director.id);
  const child = store.state.tasks.find(t => t.parent === task.id)!;
  assert.equal(child.cat, director.id);
  assert.match(child.text, /Project: Viral Instagram[\s\S]*Make three reels/);
  assert.match(toolResults(ctx), /Status: on track\./, 'the Mayor reads the director’s report');
  assert.ok(seen.mayor[0].includes('appoint_director'));
  assert.ok(seen.director_1[0].includes('create_cat') && seen.director_1[0].includes('delegate'));
  assert.ok(!seen.director_1[0].includes('appoint_director'));
});

test('a director recruits its reports into its hamlet; the fifth recruit is refused', async () => {
  const {store, town} = fixture();
  const recruit = (name: string): [string, unknown] => ['create_cat', {name, role: 'Edit short clips'}];
  scripted(town, {
    mayor: [() => calls(['appoint_director', {project: 'Clips', brief: 'Cut clips.'}]), () => say('Done.')],
    director_1: [() => calls(recruit('Ada'), recruit('Bo'), recruit('Cy'), recruit('Di'), recruit('Ed')), () => say('Status: staffed.')],
  });
  await runMayor(town, 'Make short clips');
  const director = store.state.cats.find(c => c.directs)!;
  const reports = store.state.cats.filter(c => c.manager === director.id);
  assert.deepEqual(reports.map(c => c.name), ['Ada', 'Bo', 'Cy', 'Di']);
  for (const r of reports) {
    assert.equal(r.group, director.group, `${r.name} settles in the director's hamlet`);
    assert.ok(store.state.roads.some(x => x.id === roadId(director.id, r.id)), `${r.name} is connected to the director`);
  }
  assert.equal(store.state.cats.find(c => c.id === 'ed'), undefined);
  const results = finished(store, 'create_cat');
  assert.match(results[4], /Tool error: A director has at most 4 reports\./);
});

test('a director delegates to its own reports only; a report cannot recruit; the chain reaches the Mayor', async () => {
  const {store, town} = fixture();
  const seen = scripted(town, {
    mayor: [() => calls(['appoint_director', {project: 'Clips', brief: 'Cut clips.'}]), () => say('Done.')],
    director_1: [
      () => { town.road('mayor', 'director_1', 'scholar'); return calls(['create_cat', {name: 'Ada', role: 'Edit short clips'}]); },
      () => calls(['delegate', {cat: 'ada', task: 'Cut a 30 second clip.'}], ['delegate', {cat: 'scholar', task: 'Research the niche.'}], ['appoint_director', {project: 'Nested', brief: 'No.'}]),
      () => say('Status: clip ready.'),
    ],
    ada: [() => calls(['create_cat', {name: 'Zed', role: 'Recruit'}]), () => say('Clip ready.')],
  });
  const {ctx} = await runMayor(town, 'Make short clips');
  const ada = store.state.cats.find(c => c.id === 'ada')!;
  assert.equal(ada.manager, 'director_1');
  assert.ok(!seen.ada[0].includes('create_cat'), 'a report is not offered create_cat');
  assert.match(finished(store, 'create_cat').at(-1)!, /Only the Mayor and directors can recruit cats\./);
  const delegated = finished(store, 'delegate');
  assert.equal(delegated[0], 'Clip ready.', 'the report’s reply goes back to its director');
  assert.match(delegated[1], /Tool error: A director delegates only to its own reports\./);
  assert.match(finished(store, 'appoint_director')[0], /Tool error: Only the Mayor can appoint a director\./);
  assert.match(toolResults(ctx), /Status: clip ready\./, 'the director’s report reaches the Mayor');
  const adaTask = store.state.tasks.find(t => t.cat === 'ada')!;
  const dirTask = store.state.tasks.find(t => t.id === adaTask.parent)!;
  assert.equal(dirTask.cat, 'director_1');
  assert.equal(store.state.tasks.find(t => t.id === dirTask.parent)!.cat, 'mayor', 'Mayor to director to report');
});

test('each project gets its own hamlet and its own director', async () => {
  const {store, town} = fixture();
  scripted(town, {
    mayor: [
      () => calls(['appoint_director', {project: 'Bakery', brief: 'Open it.'}]), () => say('Bakery under way.'),
      () => calls(['appoint_director', {project: 'Podcast', brief: 'Launch it.'}]), () => say('Podcast under way.'),
    ],
    director_1: [() => say('Status: bakery.')],
    director_2: [() => say('Status: podcast.')],
  });
  const first = await runMayor(town, 'Open a bakery');
  const second = await runMayor(town, 'Start a podcast');
  const d1 = store.state.cats.find(c => c.id === 'director_1')!, d2 = store.state.cats.find(c => c.id === 'director_2')!;
  assert.equal(d1.directs, first.task.id);
  assert.equal(d2.directs, second.task.id);
  assert.notEqual(d1.group, d2.group);
  assert.equal(store.state.groups.find(g => g.id === d1.group)!.rootTask, first.task.id);
  assert.equal(store.state.groups.find(g => g.id === d2.group)!.rootTask, second.task.id);
});

test('a goal keeps one project across its rounds: the director and its reports stay in one hamlet', async () => {
  const {store, town} = fixture();
  scripted(town, {
    mayor: [
      () => calls(['appoint_director', {project: 'Newsletter', brief: 'Write issue one.'}]), () => say('Round one done.'),
      () => calls(['delegate', {cat: 'director_1', task: 'Write issue two.'}]), () => say('Round two done.'),
    ],
    director_1: [() => calls(['create_cat', {name: 'Ivy', role: 'Edit copy'}]), () => say('Status: issue one.'), () => calls(['create_cat', {name: 'Jay', role: 'Lay out pages'}]), () => say('Status: issue two.')],
  });
  for (const text of ['Write the newsletter', 'Write the next issue']) {
    const task = town.createTask('mayor', 'owner', text, 'test', undefined, 'goal-1');
    await town.run(task, town.context(task, 0));
  }
  const director = store.state.cats.find(c => c.id === 'director_1')!;
  assert.equal(director.directs, 'goal-1');
  assert.equal(store.state.groups.filter(g => g.rootTask === 'goal-1').length, 1, 'one hamlet for the goal');
  for (const id of ['ivy', 'jay']) {
    const report = store.state.cats.find(c => c.id === id)!;
    assert.equal(report.manager, 'director_1');
    assert.equal(report.group, director.group);
  }
});

test('tool lists: workers never recruit, directors get their team tools, the Mayor alone appoints', async () => {
  const names = (tools: any[]) => tools.map(t => t.function.name);
  assert.ok(!names(workerTools).includes('create_cat'));
  assert.deepEqual(names(directorTools).sort(), ['assign_skills', 'create_cat', 'delegate', 'read_artifact', 'save_artifact']);
  assert.ok(names(mayorTools('demo')).includes('appoint_director'));
  assert.ok(names(mayorTools('demo')).includes('assign_skills') && !names(workerTools).includes('assign_skills'), 'the Mayor and directors give skills; workers do not');
  assert.ok(!names(workerTools).includes('appoint_director'));
  // The demonstration script ignores the new tools and must still answer for a director and for the Mayor.
  const signal = new AbortController().signal;
  const director = await demoProvider([{role: 'system', content: 'CAT_ID=director_1\nYou are Director 1.'}, {role: 'user', content: 'Make reels'}], directorTools, signal, undefined);
  assert.ok(director.message.content);
  const mayor = await demoProvider([{role: 'system', content: 'CAT_ID=mayor\nIn town now: scholar.'}, {role: 'user', content: 'Make reels'}], mayorTools('demo'), signal, undefined);
  assert.ok(mayor.message.tool_calls?.length || mayor.message.content);
});
