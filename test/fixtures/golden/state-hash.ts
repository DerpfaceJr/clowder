// The golden journal's state hash: sorted-key JSON of the replayed state (no read model), so the same events always give the same hash.
import {createHash} from 'node:crypto';
import {sorted} from '../../../src/store.ts';

export const stateHash = (state: unknown): string =>
  createHash('sha256').update(JSON.stringify(sorted(state))).digest('hex');
