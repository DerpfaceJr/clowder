// Devices > How your phone reaches this computer (plan 5.1): Tailscale first, Quick Tunnel as the fallback. The pure view only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {addressNote,remotePath,remoteStatusText,stable} from '../public/remote-path.js';

const quick = {provider: 'cloudflare', named: false};
const tailnet = {provider: 'tailscale', named: false};
const ADDRESS = 'https://pc-name.tail1234.ts.net';
const done = view => view.tailscale.steps.map(s => s.done);

test('Tailscale leads: while it is checked, then missing, signed out, without HTTPS, and ready to use', () => {
  assert.deepEqual([remotePath(quick, null).tailscale.state, remotePath(quick, null).tailscale.showSteps], ['checking', false]);
  const missing = remotePath(quick, {installed: false, signedIn: false, serve: 'tailscale serve --bg --https=443 http://127.0.0.1:8788'});
  assert.equal(missing.tailscale.line, 'Tailscale is not installed on this computer yet.');
  assert.deepEqual([missing.tailscale.showSteps, missing.tailscale.action, missing.tailscale.address], [true, 'check', null]);
  assert.deepEqual(done(missing), [false, false, false]);
  assert.deepEqual(missing.tailscale.steps.map(s => s.key), ['install', 'sign-in', 'https']);
  assert.match(missing.tailscale.steps[2].text, /tailscale serve/);
  assert.equal(missing.tailscale.steps[0].link, 'https://tailscale.com/download');
  assert.equal(missing.tailscale.serve, 'tailscale serve --bg --https=443 http://127.0.0.1:8788');
  const out = remotePath(quick, {installed: true, signedIn: false});
  assert.deepEqual([out.tailscale.state, out.tailscale.action], ['signed-out', 'check']);
  assert.deepEqual(done(out), [true, false, false]);
  const noHttps = remotePath(quick, {installed: true, signedIn: true, https: false, origin: ADDRESS});
  assert.deepEqual([noHttps.tailscale.state, noHttps.tailscale.action, noHttps.tailscale.address], ['no-https', 'use', null]);
  assert.deepEqual(done(noHttps), [true, true, false]);
  const ready = remotePath(quick, {installed: true, signedIn: true, https: true, origin: ADDRESS});
  assert.deepEqual([ready.tailscale.state, ready.tailscale.showSteps, ready.tailscale.action, ready.tailscale.address], ['ready', false, 'use', ADDRESS]);
  assert.equal(ready.tailscale.line, 'Ready. Your town’s private address will be:');
  assert.equal(remotePath(quick, {installed: true, signedIn: true, origin: ADDRESS}).tailscale.state, 'ready', 'an older client that says nothing about HTTPS is not held back');
  assert.equal(remotePath(quick, {failed: true}).tailscale.state, 'unknown');
});

test('in use and on, Tailscale shows the stable address it serves; Quick Tunnel is offered as the fallback', () => {
  const on = remotePath({...tailnet, origin: ADDRESS}, {installed: true, signedIn: true, https: true, origin: ADDRESS});
  assert.deepEqual([on.tailscale.inUse, on.tailscale.action, on.tailscale.address], [true, null, ADDRESS]);
  assert.equal(on.tailscale.line, 'On. Your town’s private address:');
  assert.deepEqual([on.fallback.inUse, on.fallback.title, on.fallback.use], [false, 'Quick Tunnel', 'Use Quick Tunnel']);
  const broken = remotePath({...tailnet, error: 'Tailscale is not installed.'}, {installed: false, signedIn: false});
  assert.deepEqual([broken.tailscale.action, broken.tailscale.showSteps], ['check', true]);
});

test('the Quick Tunnel copy says the address changes and that phone sign-ins are pasted back; a named tunnel says it stays', () => {
  const view = remotePath(quick, null).fallback;
  assert.deepEqual([view.inUse, view.badge], [true, 'No setup']);
  assert.match(view.lede, /changes each time Clowder restarts/);
  assert.match(view.lede, /paste it back into Clowder/);
  const named = remotePath({provider: 'cloudflare', named: true}, null).fallback;
  assert.deepEqual([named.title, named.badge, named.use], ['Your Cloudflare tunnel', '', 'Use your Cloudflare tunnel']);
  assert.match(named.lede, /stays the same after restarts/);
  assert.doesNotMatch(named.lede, /paste/);
});

test('the status line and the address note use plain words', () => {
  assert.equal(remoteStatusText({...tailnet, origin: ADDRESS}), `Remote access is on: ${ADDRESS}`);
  assert.equal(remoteStatusText({...quick, starting: true}), 'Connecting your town…');
  assert.equal(remoteStatusText({...tailnet, error: 'Tailscale is not signed in.'}), 'Tailscale is not signed in.');
  assert.equal(remoteStatusText(quick), 'Remote access is off.');
  assert.deepEqual([stable(tailnet), stable(quick), stable({provider: 'cloudflare', named: true})], [true, false, true]);
  assert.equal(addressNote(tailnet), 'The address stays the same after restarts.');
  assert.equal(addressNote(quick), 'The address changes when Clowder restarts; make a new pairing link then.');
});
