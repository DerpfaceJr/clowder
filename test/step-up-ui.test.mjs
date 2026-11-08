// Plan 5.5, the browser side of the passkey step-up: hidden where it is not offered (a Quick Tunnel), plain words for each state, and
// WebAuthn's binary fields carried as base64url both ways. The server's checks are in test/step-up.test.ts.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createStepUp,creationFromJson,credentialJson,fromB64url,passkeyError,passkeyLine,requestFromJson,stepUpView,toB64url} from '../public/step-up.js';

const NOW = 1_800_000_000_000;
const tailnet = {provider: 'tailscale', named: false, stable: true, origin: 'https://pc-name.tail1234.ts.net'};
const quick = {provider: 'cloudflare', named: false, stable: false, origin: 'https://cheap-words-here.trycloudflare.com'};

test('the ☰ Passkey entry stays hidden where the server does not offer a passkey, such as a Quick Tunnel', async () => {
  const button = {hidden: true, addEventListener() {}};
  const answer = body => async () => ({ok: true, json: async () => body});
  const quickPhone = createStepUp({button, doc: null, win: {}, fetchImpl: answer({available: false})});
  await quickPhone.probe();
  assert.equal(button.hidden, true);
  const tailnetPhone = createStepUp({button, doc: null, win: {}, fetchImpl: answer({available: true, passkey: false, canAdd: false, until: null})});
  await tailnetPhone.probe();
  assert.equal(button.hidden, false);
  const host = createStepUp({button, doc: null, win: {}, fetchImpl: async () => ({ok: false, json: async () => ({})})});
  await host.probe();
  assert.equal(button.hidden, true, 'the computer itself has no step-up route');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const entry = html.match(/<button id="step-up-open"[^>]*>/)?.[0] ?? '';
  assert.match(entry, /\bhidden\b/);assert.match(entry, /data-owner/);
  assert.doesNotMatch(entry, /data-host/, 'a phone must see it: data-host hides an entry on every remote device');
});

test('the phone says what to do next in plain words', () => {
  assert.deepEqual(stepUpView({available: false}), {line: 'Passkeys need an address that stays the same, such as Tailscale.', action: null});
  assert.equal(stepUpView({available: true}, {supported: false}).action, null);
  assert.match(stepUpView({available: true}, {supported: false}).line, /cannot use passkeys/);
  const none = stepUpView({available: true, passkey: false, canAdd: false});
  assert.equal(none.action, 'check');assert.match(none.line, /On your computer, open Devices and choose Allow a passkey/);
  assert.equal(stepUpView({available: true, passkey: false, canAdd: true}).action, 'add');
  assert.equal(stepUpView({available: true, passkey: true, canAdd: false, until: null}).action, 'confirm');
  assert.equal(stepUpView({available: true, passkey: true, until: NOW - 1}, {now: NOW}).action, 'confirm', 'a finished step-up asks again');
  const fresh = stepUpView({available: true, passkey: true, until: NOW + 60_000}, {now: NOW, locale: 'en-GB'});
  assert.deepEqual([fresh.action, fresh.fresh], [null, true]);assert.match(fresh.line, /^Confirmed\. Until \d\d:\d\d this phone can change money settings/);
  assert.equal(passkeyError({name: 'NotAllowedError'}), 'The passkey was cancelled or timed out. Try again.');
  assert.equal(passkeyError(new Error('That passkey request expired. Try again.')), 'That passkey request expired. Try again.');
});

test('Devices on the computer offers Allow a passkey for owner devices on a stable address only', () => {
  const owner = {id: 'p1', name: 'Phone', permission: 'owner'};
  assert.equal(passkeyLine(owner, quick), null, 'never on a Quick Tunnel');
  assert.equal(passkeyLine(owner, {...tailnet, origin: undefined}), null, 'not while remote access is off');
  assert.equal(passkeyLine({...owner, permission: 'viewer'}, tailnet), null);
  assert.deepEqual(passkeyLine(owner, tailnet, {now: NOW}), {text: 'No passkey: this phone cannot change money settings.', action: 'allow'});
  const waiting = passkeyLine({...owner, passkeyAllowedUntil: NOW + 60_000}, tailnet, {now: NOW});
  assert.equal(waiting.action, null);assert.match(waiting.text, /Waiting for the phone to add its passkey/);
  assert.equal(passkeyLine({...owner, passkeyAllowedUntil: NOW - 1}, tailnet, {now: NOW}).action, 'allow', 'an old window offers Allow again');
  assert.equal(passkeyLine({...owner, passkey: {rpId: 'pc-name.tail1234.ts.net', createdAt: NOW}}, tailnet).action, 'remove');
  assert.match(passkeyLine({...owner, passkey: {rpId: 'old-pc.tail1234.ts.net', createdAt: NOW}}, tailnet).text, /another address/);
});

test('WebAuthn binary fields go out as bytes and come back as base64url', () => {
  const bytes = Uint8Array.from([0, 1, 250, 251, 252, 253, 254, 255]);
  assert.equal(toB64url(bytes), 'AAH6-_z9_v8');
  assert.deepEqual(fromB64url('AAH6-_z9_v8'), bytes);
  const create = creationFromJson({challenge: 'AAH6-_z9_v8', rp: {id: 'pc-name.tail1234.ts.net', name: 'Clowder'}, user: {id: 'cDE', name: 'Phone', displayName: 'Phone'}});
  assert.deepEqual([create.challenge, create.user.id, create.rp.id], [bytes, Uint8Array.from([0x70, 0x31]), 'pc-name.tail1234.ts.net']);
  const get = requestFromJson({challenge: 'AAH6-_z9_v8', rpId: 'pc-name.tail1234.ts.net', allowCredentials: [{type: 'public-key', id: 'AAH6-_z9_v8'}]});
  assert.deepEqual(get.allowCredentials[0].id, bytes);
  const buffer = bytes.buffer;
  assert.deepEqual(credentialJson({id: 'abc', type: 'public-key', response: {clientDataJSON: buffer, authenticatorData: buffer, signature: buffer, userHandle: null}}),
    {id: 'abc', type: 'public-key', response: {clientDataJSON: 'AAH6-_z9_v8', authenticatorData: 'AAH6-_z9_v8', signature: 'AAH6-_z9_v8'}});
});
