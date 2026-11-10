import {test} from 'node:test';
import assert from 'node:assert/strict';
import {followText, mcpCommand, tokenLine} from '../public/devices-status.js';

test('a device that fetched the relay details reads as reconnecting; one that has not asks for a first open', () => {
  assert.equal(followText({followAt: 1793283051000}), 'Reconnects after restarts');
  assert.equal(followText({}), 'Not set up to reconnect yet: open Clowder on that phone once');
});

test('11.28: an owner token reads when it was made and last used; the command adds the endpoint with it', () => {
  assert.equal(tokenLine({createdAt: '2026-11-09T10:00:00.000Z', lastUsedAt: null}, 'en-GB'), 'Made 9 Nov · never used');
  assert.equal(tokenLine({createdAt: '2026-11-09T10:00:00.000Z', lastUsedAt: '2026-11-10T10:00:00.000Z'}, 'en-GB'), 'Made 9 Nov · last used 10 Nov');
  assert.equal(mcpCommand('http://127.0.0.1:8790', 'clw_owner_abc'), 'claude mcp add --transport http clowder http://127.0.0.1:8790/mcp --header "Authorization: Bearer clw_owner_abc"');
});
