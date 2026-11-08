import {test} from 'node:test';
import assert from 'node:assert/strict';
import {plan} from '../scripts/compact-journals.mjs';

const line=(type,data)=>JSON.stringify({id:`${type}-${Math.random()}`,at:'2026-11-06T00:00:00.000Z',type,data});

test('compaction strips every copy except the newest checkpoint of a task still waiting', () => {
  const ctx=n=>({messages:[{role:'user',content:'x'.repeat(n)}],calls:[],turn:1,depth:0});
  const lines=[
    line('task.created',{id:'done',status:'running'}),
    line('task.updated',{id:'done',status:'waiting_child',context:ctx(10)}),
    line('task.updated',{id:'done',status:'done',context:null}),
    line('task.created',{id:'wait',status:'running'}),
    line('task.updated',{id:'wait',status:'waiting_child',context:ctx(20)}),
    line('task.updated',{id:'wait',status:'running',context:null}),
    line('task.updated',{id:'wait',status:'waiting',context:ctx(30)}),
    line('approval.requested',{id:'a',task:'wait',messages:ctx(40).messages,status:'pending'}),
    '',
  ];
  const {out,kept,count}=plan(lines.join('\n'));
  assert.equal(count,8);
  assert.equal(kept,1);
  assert.equal(out.length,lines.length);
  const events=out.filter(Boolean).map(l=>JSON.parse(l));
  assert.deepEqual(events.map(e=>e.id),lines.filter(Boolean).map(l=>JSON.parse(l).id),'same events, same order');
  const withContext=events.filter(e=>e.data.context);
  assert.deepEqual(withContext.map(e=>[e.data.id,e.data.status]),[['wait','waiting']],'only the live checkpoint stays');
  assert.ok(!('messages' in events.at(-1).data));
  assert.equal(out[0],lines[0],'untouched lines are kept byte for byte');
});

test('compaction passes a newer build\'s events through byte for byte: a v above 1 and an unknown type', () => {
  const ctx={messages:[{role:'user',content:'x'}]};
  const lines=[
    line('task.created',{id:'t',status:'running'}),
    JSON.stringify({id:'v2',at:'2026-11-06T00:00:00.000Z',type:'task.updated',v:2,data:{id:'t',status:'done',context:ctx}}),
    line('garden.planted',{id:'t',context:ctx,messages:ctx.messages}),
    line('approval.requested',{id:'a',task:'t',messages:ctx.messages}),
  ];
  const {out,count}=plan(lines.join('\n'));
  assert.equal(count,4);
  assert.deepEqual(out.slice(0,3),lines.slice(0,3));
  assert.ok(!('messages' in JSON.parse(out[3]).data),'a v1 line is still compacted');
});
