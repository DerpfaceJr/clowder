import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {easeStep, EASE_RATE} from '../public/camera-flight.js';
import {MessageVisits} from '../public/world-motion.js';
import {linkFromHash, approvalFromHash} from '../public/notify.js';

// Plan 8.10 without a browser: the town's ease is time-based, replay takes a work row's messages, what a live visit does during a replay,
// and the #thread= / #cat= links. The camera, the 375 px strip and a link opening after load are test/town-links-ui.test.mjs.
const read = name => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const vec = (x, y, z) => ({x, y, z, set(a, b, c) { this.x = a; this.y = b; this.z = c; }});
const rig = () => ({camera: {position: vec(30, 40, 30), zoom: 1.4, updateProjectionMatrix() {}}, controls: {target: vec(0, .6, 0)}});
const goal = {position: vec(12, 1.6, -8), zoom: 3.2};
function run(fps, seconds, step) {
  const {camera, controls} = rig();let frames = 0, arrived = null;
  for (let i = 0; i < Math.round(fps * seconds); i++) { frames++; if (step(camera, controls, 1 / fps) && arrived === null) arrived = frames / fps; }
  return {x: controls.target.x, z: controls.target.z, cam: camera.position.x, zoom: camera.zoom, arrived};
}

test('the ease is time-based: the same pose after the same time at 30 fps and at 120 fps; the old fixed 0.12 a frame is not', () => {
  for (const seconds of [.5, 1, 2]) {
    const slow = run(30, seconds, (c, k, dt) => easeStep(c, k, goal, dt)), fast = run(120, seconds, (c, k, dt) => easeStep(c, k, goal, dt));
    for (const key of ['x', 'z', 'cam', 'zoom']) assert.ok(Math.abs(slow[key] - fast[key]) < 1e-9, `${seconds} s: ${key} ${slow[key]} at 30 fps vs ${fast[key]} at 120 fps`);
  }
  // The same check against the step it replaces, so this test can tell the two apart.
  const fixed = (c, k) => { const d = {x: (goal.position.x - k.target.x) * .12}; k.target.x += d.x; c.position.x += d.x; return false; };
  assert.ok(Math.abs(run(30, .5, fixed).x - run(120, .5, fixed).x) > 1, 'a fixed share a frame moves four times as far at 120 fps');
  // Its speed matches the old step at 60 fps: 0.12 of the gap a frame.
  const {camera, controls} = rig();easeStep(camera, controls, goal, 1 / 60);
  assert.ok(Math.abs(controls.target.x / goal.position.x - .12) < .002, `one 60 fps frame closes ${(controls.target.x / goal.position.x).toFixed(4)} of the gap`);
  assert.ok(EASE_RATE > 7 && EASE_RATE < 8.5);
  // It arrives (and town.js drops focusTarget) at the same time whatever the frame rate, within a frame.
  const a = run(30, 3, (c, k, dt) => easeStep(c, k, goal, dt)).arrived, b = run(120, 3, (c, k, dt) => easeStep(c, k, goal, dt)).arrived;
  assert.ok(a && b && Math.abs(a - b) <= 1 / 30, `arrives at ${a} s (30 fps) and ${b} s (120 fps)`);
});

test('reduced motion snaps in one frame; camera and target move together, so the view angle never changes', () => {
  const {camera, controls} = rig();
  assert.equal(easeStep(camera, controls, goal, 1 / 60, {reduced: true}), true);
  assert.deepEqual([controls.target.x, controls.target.y, controls.target.z, camera.zoom], [12, 1.6, -8, 3.2]);
  assert.deepEqual([camera.position.x, camera.position.y, camera.position.z], [42, 41, 22], 'the camera keeps its offset from the target');
});

test('town.js: the frame loop uses easeStep, focus and frameCat share one shift, replay(msgs) takes a row\'s messages, the drag still wins', () => {
  const town = read('town.js');
  assert.match(town, /if\(flight\.step\(\)\)focusTarget=undefined;else if\(focusTarget&&easeStep\(camera,controls,focusTarget,dt,\{reduced\}\)\)focusTarget=undefined;/, 'a flight is never stacked on the ease');
  assert.ok(!/multiplyScalar\(reduced\?1:\.12\)/.test(town), 'the fixed 0.12 a frame is gone');
  assert.match(town, /replay:msgs=>\{if\(snapshot\)\{visits\.replay\(msgs\?\?snapshot\.messages,snapshot\.cats\);\}\}/);
  assert.match(town, /function focus\(id,\{inset=0\}=\{\}\)\{const r=residents\.get\(id\);if\(r\)aimAt\(r\.catModel\.position,3\.2,\{inset\}\);\}/, 'focus never saves a studioView and never flies');
  assert.match(town, /function frameCat\(id,\{side='left',inset=0,save=true\}=\{\}\)\{[\s\S]*?if\(save&&!studioView\)studioView=[\s\S]*?aimAt\(r\.base,3,\{side,inset\}\);/);
  assert.match(town, /canvas\.addEventListener\('pointerdown',e=>\{focusTarget=undefined;/, 'any press on the town cancels the ease');
  assert.match(town, /select:\(id,o\)=>\{[^}]*focus\(id,o\);\}/);
});

test('app.js: a chat open eases with the pane\'s inset from 900 px, a work row replays, and the links open after load', () => {
  const app = read('app.js');
  assert.match(app, /function select\(id\)\{selected=id;render\(\);showPane\('inspector'\);if\(scene\)scene\.select\(id,\{inset:paneInset\(\)\}\);else townAim=id;\}/);
  assert.match(app, /function paneInset\(\)\{if\(matchMedia\(COMPACT_QUERY\)\.matches\)return 0;/, 'under 900 px the chat is a sheet: no inset');
  assert.match(app, /focusCat:id=>aimTown\(id\),replay:messages=>scene\?\.replay\(messages\)/);
  assert.match(app, /if\(townAim\)\{scene\[townAim===selected\?'select':'focus'\]\(townAim,\{inset:paneInset\(\)\}\);townAim=null;\}/, 'a link read before the town loaded eases once it has (a #cat= link also marks that cat’s label)');
  assert.match(app, /if\(kind==='thread'\)\{showPane\('inspector'\);chatThread\.open\(\{kind:'request',id\}\);return;\}/);
  assert.match(app, /else takeLink\(\);\}\);/, 'a link tapped while Clowder is open (only the fragment changes) opens too');
  assert.ok(!/flyTo/.test(app.slice(app.indexOf('function select('), app.indexOf('function aimTown(') + 120)), 'no flight on a chat move');
});

test('#thread=<task> and #cat=<id> links, beside #approval=', () => {
  assert.deepEqual(linkFromHash('#thread=t-12_ab'), {kind: 'thread', id: 't-12_ab'});
  assert.deepEqual(linkFromHash('cat=scholar'), {kind: 'cat', id: 'scholar'});
  assert.deepEqual(linkFromHash('#approval=a1'), {kind: 'approval', id: 'a1'});
  assert.deepEqual(linkFromHash('#approval=a1&thread=t1'), {kind: 'approval', id: 'a1'}, 'a decision first');
  assert.equal(linkFromHash('#thread=<script>'), null, 'only the server\'s id characters');
  assert.equal(linkFromHash(`#cat=${'a'.repeat(81)}`), null);
  assert.equal(linkFromHash('#pair=ABCD'), null);
  assert.equal(linkFromHash(''), null);
  assert.equal(approvalFromHash('#thread=t1'), null, 'a thread link is not a decision');
  assert.equal(approvalFromHash('#approval=a1'), 'a1');
});

// UNVERIFIED in the 8.10 notes: does a live visit that arrives during a replay get dropped, since ingest keeps a cursor? Measured here.
const cats = [{id: 'mayor', home: {x: 0, z: 0}}, {id: 'scholar', home: {x: 6, z: 0}}, {id: 'critic', home: {x: 0, z: 6}}];
const m = (id, from, to) => ({id, from, to, text: id});
test('a live visit that arrives during a replay is queued behind it, not dropped (replay never moves ingest\'s cursor)', () => {
  const v = new MessageVisits(), history = [m('h1', 'mayor', 'scholar'), m('h2', 'scholar', 'mayor'), m('h3', 'owner', 'mayor')];
  v.ingest(history, cats);
  assert.deepEqual(v.queue, [], 'the first state is the baseline');
  v.replay([history[0], history[1]], cats);
  assert.deepEqual(v.queue.map(q => q.id), ['h1', 'h2']);
  v.start(cats, null);
  assert.equal(v.current.message.id, 'h1', 'the replay is under way');
  v.ingest([...history, m('n1', 'mayor', 'critic')], cats);
  assert.deepEqual(v.queue.map(q => q.id), ['h2', 'n1'], 'the new visit waits behind the rest of the replay');
  v.ingest([...history, m('n1', 'mayor', 'critic')], cats);
  assert.deepEqual(v.queue.map(q => q.id), ['h2', 'n1'], 'and is not queued twice');
});

// A live visit already queued (not yet walking) when a work row is opened survives it, queued after the replayed ones.
test('a live visit queued but not yet started when a replay begins survives it', () => {
  const v = new MessageVisits(), history = [m('h1', 'mayor', 'scholar')];
  v.ingest(history, cats);
  v.ingest([...history, m('n1', 'mayor', 'critic')], cats);
  assert.deepEqual(v.queue.map(q => q.id), ['n1']);
  v.replay(history, cats);
  assert.deepEqual(v.queue.map(q => q.id), ['h1', 'n1']);
});
