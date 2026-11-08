import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  statusLabel, missingVars, permissionOf, countsLine, parseLines, argLines, customDraft, importLines, webLink,
  filterDirectory, filterMarketplace, approvalDetail, secretVar, instagramLine,
} from '../public/connectors-panel.js';
import {slashMatches, stepIndex} from '../public/slash-commands.js';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('the status label names the state, and a disabled connector reads Off whatever the server last saw', () => {
  assert.deepEqual(statusLabel({status: 'connected', tools: new Array(12).fill({})}), {tone: 'ok', label: 'Connected · 12 tools'});
  assert.deepEqual(statusLabel({status: 'connected', tools: [{}]}), {tone: 'ok', label: 'Connected · 1 tool'});
  assert.equal(statusLabel({status: 'connecting'}).label, 'Connecting…');
  assert.equal(statusLabel({status: 'needs-auth'}).label, 'Needs sign-in');
  assert.equal(statusLabel({status: 'needs-setup'}).label, 'Needs setup');
  assert.deepEqual(statusLabel({status: 'error', error: 'boom'}), {tone: 'error', label: 'Error'});
  assert.deepEqual(statusLabel({status: 'connected', enabled: false, tools: [{}]}), {tone: 'off', label: 'Off'});
  assert.equal(statusLabel(null).label, 'Off');
});

test('missing variables are the unset ones, by name', () => {
  assert.deepEqual(missingVars({vars: [{name: 'TOKEN', set: false}, {name: 'HOST', set: true}, {name: 'KEY', set: false}]}), ['TOKEN', 'KEY']);
  assert.deepEqual(missingVars({}), []);
});

test('a tool keeps its server permission; without one, read-only tools are allowed and the rest ask', () => {
  assert.equal(permissionOf({permission: 'off', readOnly: true}), 'off');
  assert.equal(permissionOf({permission: 'ask', readOnly: true}), 'ask');
  assert.equal(permissionOf({readOnly: true}), 'allow');
  assert.equal(permissionOf({}), 'ask');
  assert.equal(permissionOf({permission: 'maybe'}), 'ask');
});

test('the counts line lists only the non-zero parts, singular or plural', () => {
  assert.equal(countsLine({skills: [{}, {}, {}], commands: [{}, {}], agents: [{}], connectors: [{}]}),
    '3 skills · 2 commands · 1 agent · 1 connector');
  assert.equal(countsLine({skills: [{}], commands: [], agents: [], connectors: []}), '1 skill');
  assert.equal(countsLine({}), '');
});

test('KEY=value lines split on the first equals sign, skip blank lines, and name the first bad line', () => {
  assert.deepEqual(parseLines('X-Api-Key=abc\n\n  TOKEN = a=b  \r\nEMPTY='), {
    pairs: {'X-Api-Key': 'abc', TOKEN: 'a=b', EMPTY: ''}, error: null,
  });
  assert.deepEqual(parseLines('OK=1\nno equals here'), {pairs: {}, error: 'Line 2 needs KEY=value.'});
  assert.deepEqual(parseLines('bad key=1'), {pairs: {}, error: 'Line 1 needs KEY=value.'});
  assert.deepEqual(parseLines(''), {pairs: {}, error: null});
});

test('a token, key or secret is typed hidden; an account id or a version is typed in the clear', () => {
  for (const name of ['INSTAGRAM_ACCESS_TOKEN', 'X_API_KEY', 'CLIENT_SECRET', 'DB_PASSWORD', 'AUTHORIZATION']) assert.equal(secretVar(name), true, name);
  for (const name of ['INSTAGRAM_ACCOUNT_ID', 'INSTAGRAM_API_VERSION', 'ROOT']) assert.equal(secretVar(name), false, name);
});

test('the Instagram lookup reads as what it found and added, or why it could not', () => {
  assert.equal(instagramLine({accounts: ['@example_cafe', '@example_shop'], added: ['instagram @example_shop']}), 'Found 2 Instagram accounts: @example_cafe, @example_shop. Added instagram @example_shop.');
  assert.equal(instagramLine({accounts: ['@example_cafe'], added: []}), 'Found 1 Instagram account: @example_cafe.');
  assert.match(instagramLine({accounts: [], added: []}), /reaches no Instagram account yet/);
  assert.match(instagramLine({accounts: [], added: [], pages: 0, missing: ['pages_show_list', 'business_management']}), /did not grant it pages_show_list, business_management\. In Graph API Explorer add those permissions/);
  assert.match(instagramLine({accounts: [], added: [], pages: 0, missing: []}), /reaches no Facebook Page/);
  assert.match(instagramLine({accounts: [], added: [], pages: 2, missing: []}), /reaches 2 Facebook Pages, but none has an Instagram/);
  assert.equal(instagramLine({error: 'Facebook did not list your accounts: nope'}), 'Facebook did not list your accounts: nope');
  assert.equal(instagramLine(undefined), '');
});

test('arguments are one per line, trimmed, with blanks dropped', () => {
  assert.deepEqual(argLines(' -y \n\n@scope/server \n'), ['-y', '@scope/server']);
});

test('web links are http or https only', () => {
  assert.equal(webLink('https://example.com/mcp'), 'https://example.com/mcp');
  assert.equal(webLink('http://localhost:8080/x'), 'http://localhost:8080/x');
  assert.equal(webLink('javascript:alert(1)'), null);
  assert.equal(webLink('not a url'), null);
  assert.equal(webLink(undefined), null);
});

test('a web connector becomes an http transport with its headers; a program becomes stdio with its environment', () => {
  assert.deepEqual(customDraft({name: ' Notes ', kind: 'web', url: 'https://notes.example/mcp', secrets: 'Authorization=Bearer t'}), {
    body: {name: 'Notes', type: 'http', url: 'https://notes.example/mcp', headers: {Authorization: 'Bearer t'}},
  });
  assert.deepEqual(customDraft({name: 'Files', kind: 'program', command: ' npx ', args: '-y\n@x/files', secrets: 'ROOT=/tmp'}), {
    body: {name: 'Files', type: 'stdio', command: 'npx', args: ['-y', '@x/files'], env: {ROOT: '/tmp'}},
  });
});

test('a custom connector needs a name, a web address or a command, and valid KEY=value lines', () => {
  assert.equal(customDraft({name: '  ', kind: 'web', url: 'https://x.test'}).error, 'Give the connector a name.');
  assert.equal(customDraft({name: 'A', kind: 'web', url: 'ftp://x.test'}).error, 'Enter a web address that starts with https:// or http://.');
  assert.equal(customDraft({name: 'A', kind: 'program', command: ''}).error, 'Enter the command that starts the program.');
  assert.equal(customDraft({name: 'A', kind: 'web', url: 'https://x.test', secrets: 'nope'}).error, 'Headers: Line 1 needs KEY=value.');
  assert.equal(customDraft({name: 'A', kind: 'program', command: 'x', secrets: 'nope'}).error, 'Environment: Line 1 needs KEY=value.');
});

test('the import result reads as what was added and what was skipped, with the reason', () => {
  assert.deepEqual(importLines({added: ['github', 'maps'], skipped: [{name: 'slack', reason: 'already added'}]}),
    ['Added: github, maps', 'Skipped: slack (already added)']);
  assert.deepEqual(importLines({added: [], skipped: []}), ['Added: nothing new.']);
});

test('the directory and the marketplace filter by text, and the marketplace also by category', () => {
  const directory = [{id: 'a', name: 'Notes', description: 'Write things down'}, {id: 'b', name: 'Maps', description: 'Places'}];
  assert.deepEqual(filterDirectory(directory, 'places').map(d => d.id), ['b']);
  assert.equal(filterDirectory(directory, '').length, 2);
  const market = [{name: 'lint', category: 'code', description: 'Checks'}, {name: 'deploy', category: 'ops', description: 'Ships'}];
  assert.deepEqual(filterMarketplace(market, {query: 'ship', category: ''}).map(p => p.name), ['deploy']);
  assert.deepEqual(filterMarketplace(market, {query: '', category: 'code'}).map(p => p.name), ['lint']);
  assert.deepEqual(filterMarketplace(market, {query: 'ship', category: 'code'}), []);
});

test('only a connector approval shows its arguments, cut to 600 characters', () => {
  assert.equal(approvalDetail({gate: 'connector', detail: '{"q":"x"}'}), '{"q":"x"}');
  assert.equal(approvalDetail({gate: 'purchase', detail: 'anything'}), '');
  assert.equal(approvalDetail({detail: 'no gate'}), '');
  const long = approvalDetail({gate: 'connector', detail: 'a'.repeat(900)});
  assert.equal(long.length, 600);
  assert.ok(long.endsWith('…'));
});

test('an approval reads one line per argument from the full call, so long file contents never hide the repo or file names', () => {
  const files = [{path: 'site/config.js', content: 'x'.repeat(5000)}, {path: 'CREDITS.md', content: 'y'}];
  const args = JSON.stringify({owner: 'DerpfaceJr', repo: 'tower-tiles', branch: 'main', message: 'Add files', files});
  const detail = approvalDetail({gate: 'connector', detail: args.slice(0, 600), call: {function: {name: 'mcp__github__push_files', arguments: args}}});
  assert.equal(detail, 'owner: DerpfaceJr\nrepo: tower-tiles\nbranch: main\nmessage: Add files\nfiles: 2 — site/config.js, CREDITS.md');
  assert.equal(approvalDetail({gate: 'connector', detail: '{}', call: {function: {arguments: '{"name":"cattown-reels","private":false}'}}}), 'name: cattown-reels\nprivate: false');
  assert.equal(approvalDetail({gate: 'connector', detail: 'raw', call: {function: {arguments: 'not json'}}}), 'raw', 'unreadable arguments keep the stored detail');
});

test('the slash list matches the typed name by prefix first, then by containment, and closes after a space', () => {
  const commands = [
    {name: 'review', plugin: 'lint', description: 'Review the diff'},
    {name: 'preview', plugin: 'site', description: 'Open a preview'},
    {name: 'recap', plugin: 'lint', description: 'Summarise'},
  ];
  assert.deepEqual(slashMatches(commands, '/re').map(r => r.name), ['recap', 'review', 'preview']);
  assert.deepEqual(slashMatches(commands, '/rev').map(r => r.name), ['review', 'preview']);
  assert.equal(slashMatches(commands, '/review ').length, 0, 'a space ends the command');
  assert.equal(slashMatches(commands, 'hello').length, 0, 'text without a slash has no list');
  assert.equal(slashMatches(commands, '/zzz').length, 0);
  assert.equal(slashMatches(null, '/').length, 0);
});

test('a name shared by two plugins inserts as plugin:name, and a unique name inserts bare', () => {
  const commands = [{name: 'deploy', plugin: 'ops'}, {name: 'deploy', plugin: 'cloud'}, {name: 'lint', plugin: 'lint'}];
  const rows = slashMatches(commands, '/');
  assert.equal(rows.find(r => r.plugin === 'ops').insert, '/ops:deploy ');
  assert.equal(rows.find(r => r.plugin === 'cloud').insert, '/cloud:deploy ');
  assert.equal(rows.find(r => r.name === 'lint').insert, '/lint ');
  assert.equal(slashMatches(commands, '/ops:d').length, 1, 'the qualified name also matches');
});

test('the slash list shows at most eight rows', () => {
  const commands = Array.from({length: 12}, (_, i) => ({name: `cmd${i}`, plugin: 'p'}));
  assert.equal(slashMatches(commands, '/').length, 8);
});

test('arrow keys wrap through the list', () => {
  assert.equal(stepIndex(0, -1, 3), 2);
  assert.equal(stepIndex(2, 1, 3), 0);
  assert.equal(stepIndex(0, 1, 0), 0);
});

test('the connectors button sits right after AI models, owner and host only, and the approval sheet has the detail block', () => {
  assert.match(html, /<button id="models-open"[^>]*>AI models<\/button><button id="connectors-open" data-owner data-host hidden aria-haspopup="dialog" data-note="Connect apps and add plugins for your cats">Connectors &amp; plugins<\/button>/);
  assert.match(html, /<dialog id="connectors-panel"[^>]*>[\s\S]*?<div id="connectors-body"/);
  assert.ok(html.includes('<details id="approval-detail" class="approval-detail" hidden>'));
  assert.ok(html.includes('<link rel="stylesheet" href="/connectors-panel.css">'));
});
