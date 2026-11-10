import test from 'node:test';
import assert from 'node:assert/strict';
import {
  statusTone, statusLabel, canRetry, progressPercent, countsLine, usageLine, stamp, siteFocus, nameFor, waitingLabel, snapshotKey, createProjectsPanel,
} from '../public/projects-panel.js';

test('every server status maps to a tone, and an unknown status stays quiet', () => {
  assert.equal(statusTone('running'), 'working');
  assert.equal(statusTone('waiting for you'), 'attention');
  assert.equal(statusTone('done'), 'done');
  assert.equal(statusTone('failed'), 'failed');
  assert.equal(statusTone('stopped'), 'quiet');
  assert.equal(statusTone('something new'), 'quiet');
});

test('progress is clamped to a whole percentage, and unreadable values show as zero', () => {
  assert.equal(progressPercent(0.456), 46);
  assert.equal(progressPercent(1), 100);
  assert.equal(progressPercent(1.4), 100);
  assert.equal(progressPercent(-1), 0);
  assert.equal(progressPercent(undefined), 0);
  assert.equal(progressPercent(Number.NaN), 0);
});

test('the counts line names only the non-zero parts, and singular task for one', () => {
  assert.equal(countsLine({tasks: 1, done: 0, running: 0, waiting: 0, failed: 0}), '1 task');
  assert.equal(countsLine({tasks: 5, done: 3, running: 1, waiting: 0, failed: 1}), '5 tasks · 3 done · 1 running · 1 failed');
  assert.equal(countsLine({tasks: 2, done: 0, running: 1, waiting: 1, failed: 0}), '2 tasks · 1 running · 1 waiting');
});

test('usage says not reported when nothing was reported, and never shows a made-up zero', () => {
  assert.equal(usageLine({input: null, output: null}), 'Tokens: not reported');
  assert.equal(usageLine(undefined), 'Tokens: not reported');
  assert.equal(usageLine({input: 1200, output: null}), `Tokens: ${(1200).toLocaleString()} in · unreported out · provider-reported`);
});

test('a missing or invalid time reads as unknown', () => {
  assert.equal(stamp(null), 'time unknown');
  assert.equal(stamp('not a date'), 'time unknown');
  assert.notEqual(stamp('2026-10-25T09:05:00.000Z'), 'time unknown');
});

test('Show nook only has a target when the request founded a nook with a site', () => {
  assert.deepEqual(siteFocus({site: {index: 2, x: 12, z: -4}}), {x: 12, z: -4});
  assert.equal(siteFocus(null), null);
  assert.equal(siteFocus({site: {x: Number.NaN, z: 1}}), null);
});

test('names come from the project, with You and Town for the owner and the town', () => {
  const project = {cats: [{id: 'gardener', name: 'Gardener'}], group: {members: [{id: 'reviewer', name: 'Reviewer'}]}};
  assert.equal(nameFor(project, 'owner'), 'You');
  assert.equal(nameFor(project, 'system'), 'Town');
  assert.equal(nameFor(project, 'town'), 'Town', 'goal rounds come from the town');
  assert.equal(nameFor(project, 'gardener'), 'Gardener');
  assert.equal(nameFor(project, 'reviewer'), 'Reviewer');
  assert.equal(nameFor(project, 'ghost'), 'ghost');
});

test('the waiting label is one line and keeps the decision readable', () => {
  assert.equal(waitingLabel({question: 'Publish the history page?'}), 'Waiting for you: Publish the history page?');
  assert.ok(waitingLabel({question: 'word '.repeat(80)}).length < 110);
});

test('the snapshot key changes only when the data changes', () => {
  const a = [{id: 'R1', status: 'running'}];
  assert.equal(snapshotKey(a), snapshotKey([{id: 'R1', status: 'running'}]));
  assert.notEqual(snapshotKey(a), snapshotKey([{id: 'R1', status: 'done'}]));
});

test('the panel factory is exported', () => {
  assert.equal(typeof createProjectsPanel, 'function');
});

// Plan 11.13 (F3, F7): Interrupted is its own label with its reason, failed and interrupted requests get Retry, and a load with no
// answer reads in plain words.
test('Interrupted is its own word and reads as broken, not as the owner\'s Stop', () => {
  assert.equal(statusLabel('interrupted'), 'Interrupted');
  assert.equal(statusLabel('stopped'), 'Stopped');
  assert.equal(statusLabel('failed'), 'Failed');
  assert.equal(statusLabel('waiting for you'), 'Waiting for you');
  assert.equal(statusLabel('something new'), 'something new');
  assert.equal(statusTone('interrupted'), 'failed');
});

test('Retry is offered for a failed or interrupted request with nothing of it still running', () => {
  const counts = (running = 0, waiting = 0) => ({tasks: 2, done: 0, running, waiting, failed: 0});
  assert.equal(canRetry({status: 'interrupted', counts: counts()}), true);
  assert.equal(canRetry({status: 'failed', counts: counts()}), true);
  assert.equal(canRetry({status: 'interrupted', counts: counts(1)}), false, 'a retry is running');
  assert.equal(canRetry({status: 'failed', counts: counts(0, 1)}), false);
  for (const status of ['done', 'stopped', 'running', 'queued', 'waiting for you']) assert.equal(canRetry({status, counts: counts()}), false, status);
});

// A small stand-in for the browser DOM: enough for the panel to build its cards in Node.
class FakeNode {
  constructor(tag, doc) {
    const style = {setProperty: (k, v) => { style[k] = v; }};
    Object.assign(this, {tagName: tag.toUpperCase(), ownerDocument: doc, children: [], attributes: {}, listeners: {}, style, className: '', hidden: false, open: false, disabled: false, ownText: '', dataset: {}});
  }
  get textContent() { return this.ownText + this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this.ownText = String(v); this.children = []; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  click() { this.onclick?.({type: 'click'}); }
  all() { return this.children.flatMap(c => [c, ...c.all()]); }
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
const AT = '2026-11-09T12:00:00.000Z', LATER = '2026-11-09T12:05:00.000Z';
const REASON = 'Server restarted during work. Send a new message to retry.';
const request = (extra = {}) => ({id: 'R1', title: 'Draft three names for a cat cafe', status: 'interrupted', reason: REASON, startedAt: AT, updatedAt: LATER, group: null, lead: 'mayor',
  cats: [{id: 'mayor', name: 'Mayor', icon: '', color: '#8c8a7d'}], counts: {tasks: 1, done: 0, running: 0, waiting: 0, failed: 0}, progress: 1, pendingApprovals: [], lastMessage: null,
  usage: {input: null, output: null}, ...extra});

function mount({owner = true, projects = [request()], down = false} = {}) {
  const doc = {querySelector: () => null};
  doc.createElement = tag => new FakeNode(tag, doc);
  doc.createTextNode = text => Object.assign(new FakeNode('#text', doc), {ownText: String(text)});
  doc.head = doc.createElement('head');
  globalThis.document = doc;
  const server = {projects, acted: []};
  const answer = body => ({ok: true, status: 200, json: async () => body});
  const fetchImpl = async url => {
    if (down) throw new TypeError('Failed to fetch');
    if (url === '/api/projects') return answer(server.projects);
    if (url === '/api/goals') return answer({owner, goals: [], reviews: [], week: {tokens: null}});
    return answer({artifacts: []});
  };
  const act = async (path, body) => { server.acted.push([path, body]); server.projects = [request({counts: {tasks: 2, done: 0, running: 1, waiting: 0, failed: 0}})]; return {task: 'R2'}; };
  const body = doc.createElement('div'), status = doc.createElement('p');
  status.hidden = true;
  const panel = createProjectsPanel({panel: {hidden: false}, body, status, fetchImpl, act});
  const find = (tag, text) => body.all().filter(n => n.tagName === tag && (text === undefined || n.textContent === text));
  return {panel, body, status, server, find};
}

test('an interrupted request shows Interrupted, its reason and Retry; Retry posts once and is gone while the retry runs', async () => {
  const {panel, server, find, body} = mount();
  await panel.refresh();
  const card = find('ARTICLE')[0];
  assert.equal(card.getAttribute('data-status'), 'interrupted');
  const chip = card.all().find(n => n.className === 'status-chip');
  assert.equal(chip.textContent, 'Interrupted');
  assert.equal(chip.getAttribute('data-tone'), 'failed');
  assert.equal(card.all().find(n => n.className.includes('request-reason')).textContent, REASON);
  const [retry] = find('BUTTON', 'Retry');
  assert.ok(retry, 'Retry is on the card');
  retry.click();
  retry.click();
  await settle();
  assert.deepEqual(server.acted, [['tasks/R1/retry', {}]], 'two taps, one retry');
  assert.equal(find('BUTTON', 'Retry').length, 0, 'no Retry while the retry runs');
  assert.ok(body.all().some(n => n.className === 'project-counts' && n.textContent.includes('1 running')));
});

test('a failed request gets Retry too; a device that is not the owner\'s gets none', async () => {
  const failed = mount({projects: [request({status: 'failed', reason: null})]});
  await failed.panel.refresh();
  assert.equal(failed.find('BUTTON', 'Retry').length, 1);
  assert.equal(failed.body.all().filter(n => n.className.includes('request-reason')).length, 0, 'only an interrupted request carries a reason');
  const viewer = mount({owner: false});
  await viewer.panel.refresh();
  assert.equal(viewer.find('BUTTON', 'Retry').length, 0);
  const done = mount({projects: [request({status: 'done', reason: null})]});
  await done.panel.refresh();
  assert.equal(done.find('BUTTON', 'Retry').length, 0);
});

test('with the server stopped, the panel says so in plain words, not "Failed to fetch"', async () => {
  const {panel, status} = mount({down: true});
  await panel.refresh();
  assert.equal(status.hidden, false);
  assert.equal(status.textContent, 'Projects could not load. Clowder is not answering. The list comes back when it does.');
  assert.doesNotMatch(status.textContent, /fetch/i);
});
