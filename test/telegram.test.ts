// Plan 3.5: the Telegram channel against a fake Bot API. A real Town and ConnectorHub (only the MCP client is a stand-in) and real Pairing.
import test from 'node:test';
import {withSecrets} from '../src/secret-store.ts';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {Pairing,type RemoteConfig} from '../src/pairing.ts';
import {TelegramChannel,botApi,type BotApi} from '../src/telegram.ts';
import {deskTown,tmp,until,PUBLISH,WRITE} from './fixtures/desk-town.ts';

const remoteConfig:RemoteConfig=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8')).remote;
const TOKEN='123456789:AAE-fake-token-for-tests-only-0123456';
const OWNER=4242,STRANGER=666;

// The Bot API as Telegram answers it. updates: what the next getUpdates returns. sent: every other call, in order.
function fakeBot(){
  const sent:{method:string;body:any}[]=[];let updates:any[]=[],next=1;
  const api:BotApi=async(method,body)=>{
    if(method==='getMe')return {id:1,is_bot:true,username:'clowder_test_bot'};
    if(method==='getUpdates'){const out=updates;updates=[];return out;}
    sent.push({method,body});return method==='sendMessage'?{message_id:sent.length}:true;
  };
  const text=(chat:number,t:string)=>({update_id:next++,message:{message_id:next,chat:{id:chat,type:'private'},from:{id:chat},text:t}});
  const tap=(chat:number,data:string)=>({update_id:next++,callback_query:{id:`cb${next}`,from:{id:chat},data,message:{message_id:7,chat:{id:chat,type:'private'}}}});
  return {api,sent,queue:(...u:any[])=>{updates.push(...u);},text,tap,to:(chat:number)=>sent.filter(s=>s.method==='sendMessage'&&s.body.chat_id===chat)};
}

test('Telegram: owner-only pairing by code, inbox, inline buttons by class, recipient line, and Mayor replies relayed',async()=>{
  const desk=await deskTown(),bot=fakeBot(),data=tmp('telegram-');
  const pairing=new Pairing(join(data,'devices.json'),remoteConfig);
  const channel=new TelegramChannel({dataDir:data,pairing,town:()=>desk.town,mode:()=>'test',api:()=>bot.api});
  channel.attach({state:desk.store.state,listeners:desk.store.listeners as Set<any>});
  try{
    await channel.setToken(TOKEN);channel.stop();// polled by hand below
    assert.deepEqual(channel.status(),{configured:true,bot:'@clowder_test_bot',paired:false,polling:false,error:null});
    assert.equal(JSON.parse(readFileSync(join(data,'telegram.json'),'utf8')).token,undefined,'telegram.json holds no token');
    assert.equal(withSecrets(join(data,'telegram.json'),JSON.parse(readFileSync(join(data,'telegram.json'),'utf8'))).token,TOKEN,'the token is in the SecretStore (secretRef telegram.json#token)');
    assert.equal(channel.secret(),TOKEN);

    // Before pairing, nothing reaches the town and nobody is answered.
    const tasksBefore=desk.store.state.tasks.length;
    bot.queue(bot.text(STRANGER,'hello mayor'),bot.text(STRANGER,'AAAA-BBBB-CCCC-DDDD'));await channel.pollOnce();
    assert.equal(desk.store.state.tasks.length,tasksBefore);assert.equal(bot.sent.length,0);

    // The owner sends the code from Clowder. The same code from another chat afterwards does nothing: it worked once.
    const {code}=channel.pairCode();
    bot.queue(bot.text(OWNER,`/start ${code}`));await channel.pollOnce();
    assert.equal(channel.status().paired,true);
    assert.equal(pairing.list().find(d=>d.name==='Telegram')?.permission,'owner','the chat is an owner device in Devices');
    assert.match(bot.to(OWNER)[0]!.body.text,/^Paired with Clowder/);
    bot.queue(bot.text(STRANGER,code));await channel.pollOnce();
    assert.equal(bot.to(STRANGER).length,0);assert.equal(pairing.list().filter(d=>d.name==='Telegram').length,1);

    // A stranger's text and a stranger's button are ignored.
    bot.queue(bot.text(STRANGER,'delete everything'));await channel.pollOnce();
    assert.ok(!desk.store.state.tasks.some(t=>t.text==='delete everything'));

    // The owner's text reaches the Mayor's inbox, shown in chat as from the owner.
    bot.queue(bot.text(OWNER,'Plan my week'));await channel.pollOnce();
    const inbox=desk.store.state.tasks.find(t=>t.text==='Plan my week')!;
    assert.equal(inbox.cat,'mayor');assert.equal(inbox.from,'owner');assert.deepEqual(inbox.inbox,{goal:false});
    assert.ok(desk.store.state.messages.some(m=>m.from==='owner'&&m.to==='mayor'&&m.text==='Plan my week'));
    // The Mailman delivers it: his line to the Mayor comes just before the owner's, so the town draws his visit.
    const at=desk.store.state.messages.findIndex(m=>m.from==='owner'&&m.text==='Plan my week');
    assert.deepEqual([desk.store.state.messages[at-1].from,desk.store.state.messages[at-1].to,desk.store.state.messages[at-1].text],['mailman','mayor','Post for you, by Telegram.']);
    // The Mayor's reply to that message comes back to the chat; a reply to an in-app message does not.
    desk.town.message('mayor','owner','Here is your week.',inbox.id);
    desk.town.message('mayor','owner','In-app only.','some-other-task');
    assert.ok(bot.to(OWNER).some(s=>s.body.text==='Here is your week.'));
    assert.ok(!bot.to(OWNER).some(s=>s.body.text==='In-app only.'));

    // A private write: Allow and Deny buttons. The stranger's tap does nothing; the owner's tap resolves it with device 'telegram'.
    const write=await desk.ask(WRITE,{note:'groceries'});
    const notice=bot.to(OWNER).find(m=>/update_note/.test(m.body.text))!;
    assert.match(notice.body.text,/Needs you: .*update_note/i);
    assert.deepEqual(notice.body.reply_markup,{inline_keyboard:[[{text:'Allow once',callback_data:`a:${write.id}:0`},{text:'Deny',callback_data:`a:${write.id}:1`}]]});
    bot.queue(bot.tap(STRANGER,`a:${write.id}:0`));await channel.pollOnce();
    assert.equal(desk.pending().some(a=>a.id===write.id),true,'a stranger cannot answer');
    bot.queue(bot.tap(OWNER,`a:${write.id}:0`));await channel.pollOnce();
    assert.deepEqual(desk.store.state.events.find(e=>e.type==='approval.resolved'&&e.data.id===write.id)!.data,{id:write.id,status:'approved',answer:'Allow once',device:'telegram'});
    assert.ok(bot.sent.some(s=>s.method==='answerCallbackQuery'&&s.body.text==='Allow once: sent.'));
    await until(()=>desk.calls.length===1);

    // A publish: no buttons, and the message names the recipient as the card's lines do. A made-up button for it is refused.
    const publish=await desk.ask(PUBLISH,{to:'alice@example.com',subject:'Hello'});
    const pub=bot.to(OWNER).find(m=>/send_email/.test(m.body.text))!;
    assert.equal(pub.body.reply_markup,undefined);
    assert.match(pub.body.text,/to: alice@example\.com/);
    assert.match(pub.body.text,/Open Clowder to answer\.$/);
    bot.queue(bot.tap(OWNER,`a:${publish.id}:0`));await channel.pollOnce();
    assert.equal(desk.pending().some(a=>a.id===publish.id),true,'a publish is answered only on the card');
    assert.equal(desk.calls.length,1);

    // Revoking Telegram in Devices ends the pairing: nothing more is sent or taken.
    pairing.revoke(pairing.list().find(d=>d.name==='Telegram')!.id);
    const count=bot.sent.length;
    bot.queue(bot.text(OWNER,'still there?'));await channel.pollOnce();
    desk.town.message('mayor','owner','late reply',inbox.id);
    assert.equal(bot.sent.length,count);assert.ok(!desk.store.state.tasks.some(t=>t.text==='still there?'));

    channel.remove();
    assert.equal(existsSync(join(data,'telegram.json')),false);assert.equal(channel.status().configured,false);
  }finally{channel.stop();await desk.close();}
});

test('Telegram: a token that is not a bot token is refused before any call',async()=>{
  const data=tmp('telegram-bad-');let called=0;
  const channel=new TelegramChannel({dataDir:data,pairing:new Pairing(join(data,'devices.json'),remoteConfig),town:()=>{throw new Error('unused');},mode:()=>'demo',api:()=>async()=>{called++;return {};}});
  await assert.rejects(channel.setToken('not a token'),/BotFather/);
  assert.equal(called,0);assert.equal(existsSync(join(data,'telegram.json')),false);
});

test('Telegram: the real Bot API wrapper posts JSON to the bot URL, and its errors never carry the token',async()=>{
  const seen:{url:string;init:RequestInit}[]=[];
  const fetchOk=(async(url:string,init:RequestInit)=>{seen.push({url,init});return new Response(JSON.stringify({ok:true,result:{id:1}}));}) as unknown as typeof fetch;
  assert.deepEqual(await botApi(TOKEN,fetchOk)('getMe',{}),{id:1});
  assert.equal(seen[0]!.url,`https://api.telegram.org/bot${TOKEN}/getMe`);assert.equal(seen[0]!.init.method,'POST');assert.equal(seen[0]!.init.body,'{}');
  const fetch401=(async()=>new Response(JSON.stringify({ok:false,description:'Unauthorized'}),{status:401})) as unknown as typeof fetch;
  await assert.rejects(botApi(TOKEN,fetch401)('getMe',{}),(err:Error)=>err.message==='Telegram 401: Unauthorized'&&!err.message.includes(TOKEN));
  const offline=(async(url:string)=>{throw new TypeError(`fetch failed for ${url}`);}) as unknown as typeof fetch;
  await assert.rejects(botApi(TOKEN,offline)('getMe',{}),(err:Error)=>err.message==='Telegram is unreachable.');
});
