// A Town with one real connector ("Desk") whose MCP client is a stand-in: update_note is a private write, send_email is public.
// ask(tool, args) has the scholar make that one call, then report. Shared by test/notify-actions.test.ts and test/telegram.test.ts.
import {mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConnectorHub} from '../../src/connectors.ts';
import {allRoles} from '../../src/roles.ts';
import {Town} from '../../src/engine.ts';
import {Store} from '../../src/store.ts';
import type {Provider} from '../../src/provider.ts';

const config = JSON.parse(readFileSync(new URL('../../town.config.json', import.meta.url), 'utf8'));
export const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
export async function until(fn: () => boolean) { for (let i = 0; i < 500; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('Timed out waiting for state transition'); }
export const WRITE = 'mcp__desk__update_note', PUBLISH = 'mcp__desk__send_email';

export async function deskTown() {
  const calls: {name: string; args: unknown}[] = [];
  const client = {
    info: {}, close: async () => {},
    listTools: async () => [{name: 'update_note', inputSchema: {type: 'object'}}, {name: 'send_email', inputSchema: {type: 'object'}}],
    callTool: async (name: string, args: unknown) => { calls.push({name, args}); return {text: 'ok', isError: false}; },
  };
  const hub = new ConnectorHub({dataDir: tmp('desk-hub-'), port: 4321, home: tmp('desk-home-'), connect: (async () => client) as any});
  hub.addCustom({name: 'Desk', type: 'http', url: 'https://example.com/mcp'});
  hub.patchConnector('desk', {enabled: true, cats: ['scholar'], tools: {}});
  await until(() => hub.publicConnectors().find(c => c.id === 'desk')?.status === 'connected');
  const provider: Provider = async messages => {
    if (String(messages.at(-1)?.content ?? '').startsWith('Record for the town')) return {message: {role: 'assistant', content: 'Nothing new to record.'}};
    // The call is in the task's own text (the newest one: earlier tasks can be in the context too); once it has a tool result the scholar reports.
    const spec = messages.filter(m => m.role === 'user').map(m => /DESK (\[.*\])/.exec(String(m.content ?? ''))?.[1]).filter(Boolean).at(-1);
    if (!spec || messages.some(m => m.role === 'tool')) return {message: {role: 'assistant', content: 'Report.'}};
    const [name, args] = JSON.parse(spec);
    return {message: {role: 'assistant', content: null, tool_calls: [{id: 'call-0', type: 'function', function: {name, arguments: JSON.stringify(args)}}]}};
  };
  const store = new Store(join(tmp('desk-'), 'events.jsonl'), allRoles(config));
  const town = new Town(store, config, {test: provider});
  town.connectors = () => hub;
  const pending = () => store.state.approvals.filter(a => a.status === 'pending');
  // The scholar's call waits for the owner: resolves with that decision.
  const ask = async (name: string, args: unknown) => { await until(() => !store.state.tasks.some(t => t.cat === 'scholar' && ['running', 'waiting', 'waiting_child'].includes(t.status))); const before = pending().length; town.submit('scholar', `DESK ${JSON.stringify([name, args])}`, 'test'); await until(() => pending().length > before); return pending().at(-1)!; };
  return {hub, store, town, calls, pending, ask, close: async () => { town.dispose(); await hub.dispose(); }};
}
