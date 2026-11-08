// Plan 3.5 (D7): the Discord channel against a fake Gateway socket and a fake REST API. A real Town and ConnectorHub (only the MCP client
// is a stand-in) and real Pairing, as in test/telegram.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {DiscordChannel,restApi,type Rest,type Sock} from '../src/discord.ts';
import {withSecrets} from '../src/secret-store.ts';
import {Pairing,type RemoteConfig} from '../src/pairing.ts';
import {deskTown,tmp,until,PUBLISH,WRITE} from './fixtures/desk-town.ts';

const remoteConfig:RemoteConfig=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8')).remote;
const TOKEN='MTIzNDU2Nzg5MDEyMzQ1Njc4.GabcDE.fake-token-for-tests-only-0123456789';
const BOT='900',OWNER='4242',OWNER_DM='5000',STRANGER='666',STRANGER_DM='6000',GUILD='7000';

// The Gateway as Discord speaks it: frames pushed in, payloads sent out, and the close code the channel used.
class FakeSocket implements Sock{
  sent:any[]=[];closedWith?:number;seq=0;
  onmessage:Sock['onmessage']=null;onclose:Sock['onclose']=null;onerror:Sock['onerror']=null;
  constructor(public url:string){}
  send(data:string){this.sent.push(JSON.parse(data));}
  close(code?:number){this.closedWith=code;}
  push(p:object){this.onmessage?.({data:JSON.stringify(p)});}
  hello(){this.push({op:10,d:{heartbeat_interval:60_000}});}
  dispatch(t:string,d:object){this.push({op:0,s:++this.seq,t,d});}
}
function fakeDiscord(){
  const sockets:FakeSocket[]=[],calls:{method:string;path:string;body:any}[]=[];
  const rest:Rest=async(method,path,body)=>{
    if(path==='/users/@me')return {id:BOT,username:'clowder_test',bot:true};
    calls.push({method,path,body});return {id:String(calls.length)};
  };
  const ws=()=>sockets.at(-1)!;
  const dm=(user:string,channel:string,content:string,extra:object={})=>ws().dispatch('MESSAGE_CREATE',{id:'1',channel_id:channel,author:{id:user},content,...extra});
  const tap=(user:string,channel:string,custom_id:string)=>ws().dispatch('INTERACTION_CREATE',{id:'111',token:'itoken',type:3,channel_id:channel,user:{id:user},data:{custom_id},message:{id:'9',content:'the notice'}});
  return {sockets,calls,rest,ws,dm,tap,socket:(url:string)=>{const s=new FakeSocket(url);sockets.push(s);return s;},to:(channel:string)=>calls.filter(c=>c.path===`/channels/${channel}/messages`)};
}

test('Discord: owner-only DM pairing by code, inbox, buttons by class, recipient line, guilds and strangers ignored',async()=>{
  const desk=await deskTown(),fake=fakeDiscord(),data=tmp('discord-');
  const pairing=new Pairing(join(data,'devices.json'),remoteConfig);
  const channel=new DiscordChannel({dataDir:data,pairing,town:()=>desk.town,mode:()=>'test',rest:()=>fake.rest,socket:fake.socket,retryMs:1});
  channel.attach({state:desk.store.state,listeners:desk.store.listeners as Set<any>});
  try{
    await channel.setToken(TOKEN);
    assert.deepEqual(channel.status(),{configured:true,bot:'clowder_test',paired:false,connected:false,error:null});
    assert.equal(withSecrets(join(data,'discord.json'),JSON.parse(readFileSync(join(data,'discord.json'),'utf8'))).token,TOKEN,'the token is in the SecretStore (secretRef discord.json#token)');
    assert.equal(channel.secret(),TOKEN);

    // Hello, then identify with the direct-messages intent only; READY means connected.
    assert.equal(fake.ws().url,'wss://gateway.discord.gg/?v=10&encoding=json');
    fake.ws().hello();
    assert.deepEqual(fake.ws().sent[0],{op:2,d:{token:TOKEN,intents:4096,properties:{os:process.platform,browser:'clowder',device:'clowder'}}});
    fake.ws().dispatch('READY',{session_id:'s1',resume_gateway_url:'wss://gateway-us-east1-b.discord.gg',user:{id:BOT}});
    assert.equal(channel.status().connected,true);

    // Before pairing, nothing reaches the town and nobody is answered.
    const tasksBefore=desk.store.state.tasks.length;
    fake.dm(STRANGER,STRANGER_DM,'hello mayor');fake.dm(STRANGER,STRANGER_DM,'AAAA-BBBB-CCCC-DDDD');
    assert.equal(desk.store.state.tasks.length,tasksBefore);assert.equal(fake.calls.length,0);

    // The owner sends the code from Clowder in a DM. The same code from someone else afterwards does nothing: it worked once.
    const {code}=channel.pairCode();
    fake.dm(OWNER,OWNER_DM,code);
    assert.equal(channel.status().paired,true);
    assert.equal(pairing.list().find(d=>d.name==='Discord')?.permission,'owner','the DM is an owner device in Devices');
    assert.match(fake.to(OWNER_DM)[0]!.body.content,/^Paired with Clowder/);
    assert.deepEqual(fake.to(OWNER_DM)[0]!.body.allowed_mentions,{parse:[]});
    fake.dm(STRANGER,STRANGER_DM,code);
    assert.equal(fake.to(STRANGER_DM).length,0);assert.equal(pairing.list().filter(d=>d.name==='Discord').length,1);

    // A stranger's DM, the owner in a server, and the bot's own echo in the DM are all ignored.
    fake.dm(STRANGER,STRANGER_DM,'delete everything');
    fake.dm(OWNER,OWNER_DM,'from a server',{guild_id:GUILD});// the DM's own channel id, so only the guild check stops it
    fake.dm(BOT,OWNER_DM,'my own echo',{author:{id:BOT,bot:true}});
    for(const t of ['delete everything','from a server','my own echo'])assert.ok(!desk.store.state.tasks.some(x=>x.text===t),t);

    // The owner's DM reaches the Mayor's inbox, shown in chat as from the owner; the Mayor's reply to it comes back, an in-app one does not.
    fake.dm(OWNER,OWNER_DM,'Plan my week');
    const inbox=desk.store.state.tasks.find(t=>t.text==='Plan my week')!;
    assert.equal(inbox.cat,'mayor');assert.equal(inbox.from,'owner');assert.deepEqual(inbox.inbox,{goal:false});
    desk.town.message('mayor','owner','Here is your week.',inbox.id);
    desk.town.message('mayor','owner','In-app only.','some-other-task');
    assert.ok(fake.to(OWNER_DM).some(c=>c.body.content==='Here is your week.'));
    assert.ok(!fake.to(OWNER_DM).some(c=>c.body.content==='In-app only.'));

    // A private write: Allow and Deny buttons. The stranger's tap gets nothing; the owner's tap resolves it with device 'discord' and clears the buttons.
    const write=await desk.ask(WRITE,{note:'groceries'});
    const notice=fake.to(OWNER_DM).find(c=>/update_note/.test(c.body.content))!;
    assert.match(notice.body.content,/Scholar needs you: .*update_note/i);
    assert.deepEqual(notice.body.components,[{type:1,components:[{type:2,style:1,label:'Allow once',custom_id:`a:${write.id}:0`},{type:2,style:2,label:'Deny',custom_id:`a:${write.id}:1`}]}]);
    const before=fake.calls.length;
    fake.tap(STRANGER,STRANGER_DM,`a:${write.id}:0`);
    assert.equal(fake.calls.length,before);assert.equal(desk.pending().some(a=>a.id===write.id),true,'a stranger cannot answer');
    fake.tap(OWNER,OWNER_DM,`a:${write.id}:0`);
    assert.deepEqual(desk.store.state.events.find(e=>e.type==='approval.resolved'&&e.data.id===write.id)!.data,{id:write.id,status:'approved',answer:'Allow once',device:'discord'});
    const answered=fake.calls.find(c=>c.path==='/interactions/111/itoken/callback')!;
    assert.equal(answered.body.type,7);assert.deepEqual(answered.body.data.components,[]);assert.equal(answered.body.data.content,'the notice\n\nAllow once: sent.');
    await until(()=>desk.calls.length===1);

    // A publish: no buttons, and the message names the recipient as the card's lines do. A made-up button for it gets a private refusal.
    const publish=await desk.ask(PUBLISH,{to:'alice@example.com',subject:'Hello'});
    const pub=fake.to(OWNER_DM).find(c=>/send_email/.test(c.body.content))!;
    assert.equal(pub.body.components,undefined);
    assert.match(pub.body.content,/to: alice@example\.com/);
    assert.match(pub.body.content,/Open Clowder to answer\.$/);
    fake.tap(OWNER,OWNER_DM,`a:${publish.id}:0`);
    const refused=fake.calls.at(-1)!;
    assert.equal(refused.body.type,4);assert.equal(refused.body.data.flags,64);assert.match(refused.body.data.content,/Open Clowder/);
    assert.equal(desk.pending().some(a=>a.id===publish.id),true,'a publish is answered only on the card');
    assert.equal(desk.calls.length,1);

    // Revoking Discord in Devices ends the pairing: nothing more is sent or taken.
    pairing.revoke(pairing.list().find(d=>d.name==='Discord')!.id);
    const count=fake.calls.length;
    fake.dm(OWNER,OWNER_DM,'still there?');
    desk.town.message('mayor','owner','late reply',inbox.id);
    assert.equal(fake.calls.length,count);assert.ok(!desk.store.state.tasks.some(t=>t.text==='still there?'));

    channel.remove();
    assert.equal(fake.sockets[0]!.closedWith,1000,'removing ends the Gateway session');
    assert.equal(existsSync(join(data,'discord.json')),false);assert.equal(channel.status().configured,false);
  }finally{channel.stop();await desk.close();}
});

test('Discord: a dropped socket reconnects and resumes the session; an invalid session identifies again; a refused token stops',async()=>{
  const fake=fakeDiscord(),data=tmp('discord-gw-');
  const channel=new DiscordChannel({dataDir:data,pairing:new Pairing(join(data,'devices.json'),remoteConfig),town:()=>{throw new Error('unused');},mode:()=>'demo',rest:()=>fake.rest,socket:fake.socket,retryMs:1});
  try{
    await channel.setToken(TOKEN);
    fake.ws().hello();fake.ws().dispatch('READY',{session_id:'s1',resume_gateway_url:'wss://gateway-us-east1-b.discord.gg'});
    fake.dm(STRANGER,STRANGER_DM,'ignored, but it moves the sequence');
    fake.ws().push({op:1});
    assert.deepEqual(fake.ws().sent.at(-1),{op:1,d:2},'a heartbeat asked for carries the last sequence');

    // The socket drops: a new one on the resume address resumes the session at the last sequence.
    fake.ws().onclose!({code:1006});
    assert.equal(channel.status().connected,false);
    await until(()=>fake.sockets.length===2);
    assert.equal(fake.ws().url,'wss://gateway-us-east1-b.discord.gg/?v=10&encoding=json');
    fake.ws().hello();
    assert.deepEqual(fake.ws().sent[0],{op:6,d:{token:TOKEN,session_id:'s1',seq:2}});
    fake.ws().dispatch('RESUMED',{});
    assert.equal(channel.status().connected,true);

    // Discord says the session cannot be resumed: the next socket identifies afresh on the main address.
    fake.ws().push({op:9,d:false});
    assert.equal(fake.sockets[1]!.closedWith,4000,'a reconnect keeps the close code that does not end a session');
    await until(()=>fake.sockets.length===3);
    assert.equal(fake.ws().url,'wss://gateway.discord.gg/?v=10&encoding=json');
    fake.ws().hello();assert.equal(fake.ws().sent[0].op,2);

    // A refused token fails on every retry, so it is not retried.
    fake.ws().onclose!({code:4004});
    await new Promise(r=>setTimeout(r,30));
    assert.equal(fake.sockets.length,3);assert.match(channel.status().error!,/refused the bot token/);
  }finally{channel.stop();}
});

test('Discord: a token of the wrong shape is refused before any call; the REST wrapper sends the token only in its header',async()=>{
  const data=tmp('discord-bad-');let called=0;
  const channel=new DiscordChannel({dataDir:data,pairing:new Pairing(join(data,'devices.json'),remoteConfig),town:()=>{throw new Error('unused');},mode:()=>'demo',rest:()=>async()=>{called++;return {};},socket:()=>{throw new Error('unused');}});
  await assert.rejects(channel.setToken('not a token'),/Developer Portal/);
  assert.equal(called,0);assert.equal(existsSync(join(data,'discord.json')),false);

  const seen:{url:string;init:RequestInit}[]=[];
  const fetchOk=(async(url:string,init:RequestInit)=>{seen.push({url,init});return new Response(JSON.stringify({id:BOT}));}) as unknown as typeof fetch;
  assert.deepEqual(await restApi(TOKEN,fetchOk)('POST','/channels/1/messages',{content:'hi'}),{id:BOT});
  assert.equal(seen[0]!.url,'https://discord.com/api/v10/channels/1/messages');assert.equal(seen[0]!.init.body,'{"content":"hi"}');
  assert.equal((seen[0]!.init.headers as Record<string,string>).Authorization,`Bot ${TOKEN}`);
  const fetch401=(async()=>new Response(JSON.stringify({message:'401: Unauthorized',code:0}),{status:401})) as unknown as typeof fetch;
  await assert.rejects(restApi(TOKEN,fetch401)('GET','/users/@me'),(err:Error)=>err.message==='Discord 401: 401: Unauthorized'&&!err.message.includes(TOKEN));
  const offline=(async(url:string)=>{throw new TypeError(`fetch failed for ${url}`);}) as unknown as typeof fetch;
  await assert.rejects(restApi(TOKEN,offline)('GET','/users/@me'),(err:Error)=>err.message==='Discord is unreachable.');
});
