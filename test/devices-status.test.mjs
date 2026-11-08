import {test} from 'node:test';
import assert from 'node:assert/strict';
import {followText} from '../public/devices-status.js';

test('a device that fetched the relay details reads as reconnecting; one that has not asks for a first open', () => {
  assert.equal(followText({followAt: 1793283051000}), 'Reconnects after restarts');
  assert.equal(followText({}), 'Not set up to reconnect yet: open Clowder on that phone once');
});
