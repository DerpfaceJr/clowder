import test from 'node:test';
import assert from 'node:assert/strict';
import {anthropicProvider, toAnthropicMessages} from '../src/provider.ts';

// A fake fetch that records each request and answers with a canned Messages API body.
function fakeFetch(reply: any, status = 200) {
  const calls: {url: string; init: any; body: any}[] = [];
  const fn = (async (url: any, init: any) => {
    calls.push({url: String(url), init, body: JSON.parse(init.body)});
    return new Response(JSON.stringify(reply), {status, headers: {'content-type': 'application/json'}});
  }) as unknown as typeof fetch;
  return {fn, calls};
}

const tools = [{type: 'function', function: {name: 'lookup', description: 'Find a record', parameters: {type: 'object', properties: {query: {type: 'string'}}, required: ['query']}}}];

test('tool_calls and role tool results map to tool_use and tool_result blocks and back', async () => {
  const history = [
    {role: 'system', content: 'You are the Mayor.'},
    {role: 'user', content: 'Who runs the bakery?'},
    {role: 'assistant', content: null, tool_calls: [{id: 'toolu_1', type: 'function', function: {name: 'lookup', arguments: '{"query":"bakery"}'}}]},
    {role: 'tool', tool_call_id: 'toolu_1', content: 'Mara runs it.'},
    {role: 'tool', tool_call_id: 'toolu_2', content: 'Second result.'},
  ];
  const mapped = toAnthropicMessages(history);
  assert.equal(mapped.system?.[0].text, 'You are the Mayor.');
  assert.deepEqual(mapped.messages[1], {role: 'assistant', content: [{type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {query: 'bakery'}}]});
  // Both tool results join one user turn, so the roles still alternate.
  assert.deepEqual(mapped.messages[2], {role: 'user', content: [
    {type: 'tool_result', tool_use_id: 'toolu_1', content: 'Mara runs it.'},
    {type: 'tool_result', tool_use_id: 'toolu_2', content: 'Second result.'},
  ]});

  const reply = {content: [{type: 'text', text: 'Checking.'}, {type: 'tool_use', id: 'toolu_3', name: 'lookup', input: {query: 'mara'}}],
    usage: {input_tokens: 10, output_tokens: 4}};
  const {fn, calls} = fakeFetch(reply);
  const out = await anthropicProvider('claude-sonnet-5-5', 5000, 'sk-test', undefined, fn)(history, tools, new AbortController().signal);
  assert.deepEqual(out.message.tool_calls, [{id: 'toolu_3', type: 'function', function: {name: 'lookup', arguments: '{"query":"mara"}'}}]);
  assert.equal(out.message.content, 'Checking.');
  assert.equal(calls[0].body.tools[0].name, 'lookup');
  assert.deepEqual(calls[0].body.tools[0].input_schema, tools[0].function.parameters);
});

test('system prompt is sent as a cached content block with the Messages headers', async () => {
  const {fn, calls} = fakeFetch({content: [{type: 'text', text: 'ok'}], usage: {input_tokens: 1, output_tokens: 1}});
  await anthropicProvider('claude-sonnet-5-5', 5000, 'sk-test', undefined, fn)(
    [{role: 'system', content: 'Long stable prompt'}, {role: 'user', content: 'hi'}], [], new AbortController().signal);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].init.headers['x-api-key'], 'sk-test');
  assert.equal(calls[0].init.headers['anthropic-version'], '2023-06-01');
  assert.deepEqual(calls[0].body.system, [{type: 'text', text: 'Long stable prompt', cache_control: {type: 'ephemeral'}}]);
  assert.equal(calls[0].body.messages.some((m: any) => m.role === 'system'), false);
  assert.equal(calls[0].body.tools, undefined);
});

test('usage maps cache reads and writes into prompt_tokens', async () => {
  const {fn} = fakeFetch({content: [{type: 'text', text: 'ok'}],
    usage: {input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: 7}});
  const out = await anthropicProvider('claude-sonnet-5-5', 5000, 'k', undefined, fn)([{role: 'user', content: 'hi'}], [], new AbortController().signal);
  assert.deepEqual(out.usage, {prompt_tokens: 125, completion_tokens: 7, total_tokens: 132});
});

test('an HTTP error gives a plain message without the response body', async () => {
  const {fn} = fakeFetch({error: {message: 'secret detail sk-test'}}, 401);
  await assert.rejects(
    anthropicProvider('claude-sonnet-5-5', 5000, 'sk-test', undefined, fn)([{role: 'user', content: 'hi'}], [], new AbortController().signal),
    {message: 'Model request failed (401). Check the configured model and provider.'});
});

test('abort stops the call and the timeout does too', async () => {
  // A fetch that never answers and rejects when its signal aborts, as the real one does.
  const hang = (async (_url: any, init: any) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))) as unknown as typeof fetch;
  const controller = new AbortController();
  const pending = anthropicProvider('claude-sonnet-5-5', 60_000, 'k', undefined, hang)([{role: 'user', content: 'hi'}], [], controller.signal);
  controller.abort(new Error('owner stopped'));
  await assert.rejects(pending, /owner stopped/);

  await assert.rejects(
    anthropicProvider('claude-sonnet-5-5', 10, 'k', undefined, hang)([{role: 'user', content: 'hi'}], [], new AbortController().signal),
    (err: any) => err.name === 'TimeoutError');
});
