// Team instances (plan 10.1): the folder sits beside the private data folder, and the ports clash with nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname,join,relative,resolve,sep} from 'node:path';

const require=createRequire(import.meta.url);
const {teamDataDir,nextTeam,parseTeams,teamEnv,PORT_STEP}=require('../desktop/teams.cjs');
const config=JSON.parse(readFileSync(new URL('../town.config.json',import.meta.url),'utf8'));
const base={port:Number(config.port),remotePort:Number(config.remote.port)};

test('a team folder is a sibling of the data folder, never inside it', ()=>{
  for(const own of [join('C:','Users','x','AppData','Roaming','Clowder','data'),join('C:','cat-town','data'),resolve('scratch','town')]){
    const dir=teamDataDir(own,'team-1');
    assert.equal(dirname(dir),dirname(resolve(own)));
    assert.ok(!dir.startsWith(resolve(own)+sep),dir);
    assert.notEqual(dir,resolve(own));
    assert.ok(relative(resolve(own),dir).startsWith('..'));
  }
  assert.equal(teamDataDir(resolve('scratch','data'),'team-2'),resolve('scratch','data-team-2'));
});

test('a team name that could leave the parent folder is refused', ()=>{
  for(const slug of ['','..','team-0','team-1/..',`team-1${sep}x`,'../data','team-01','x'])assert.throws(()=>teamDataDir(join('C:','d','data'),slug));
});

test('team ports derive from the config ports and clash with neither the private pair nor another team', ()=>{
  const teams:any[]=[];
  for(let i=0;i<5;i++)teams.push(nextTeam(teams,base));
  assert.deepEqual(teams.map(t=>t.slug),['team-1','team-2','team-3','team-4','team-5']);
  assert.equal(teams[0].port,base.port+PORT_STEP);assert.equal(teams[0].remotePort,base.remotePort+PORT_STEP);
  const all=[base.port,base.remotePort,...teams.flatMap(t=>[t.port,t.remotePort])];
  assert.equal(new Set(all).size,all.length);
  // A removed team's number is reused; a config whose ports are one step apart still gets no clash.
  assert.equal(nextTeam(teams.filter(t=>t.slug!=='team-2'),base).slug,'team-2');
  const tight={port:9000,remotePort:9000+PORT_STEP},t=[nextTeam([],tight)];t.push(nextTeam(t,tight));
  const ports=[tight.port,tight.remotePort,...t.flatMap(x=>[x.port,x.remotePort])];
  assert.equal(new Set(ports).size,ports.length,JSON.stringify(t));
});

test('teams.json drops anything malformed', ()=>{
  const good={slug:'team-1',name:'Team 1',port:8797,remotePort:8798};
  assert.deepEqual(parseTeams(JSON.stringify({teams:[good,{...good,slug:'../x'},{...good,port:'1'},null]})),[good]);
  assert.deepEqual(parseTeams('not json'),[]);
  assert.deepEqual(parseTeams('{"teams":{}}'),[]);
});

test('a team server gets its own folder, ports, key and slug, and never the owner\'s named tunnel', ()=>{
  const env=teamEnv({PATH:'p',PORT:'1',CAT_TOWN_DATA:'own',CAT_TUNNEL_TOKEN:'t',CAT_TUNNEL_ORIGIN:'https://x',CAT_TUNNEL_AUTOSTART:'1'},{slug:'team-1',dataDir:'team',port:8797,remotePort:8798,ownerKey:'k'});
  assert.deepEqual(env,{PATH:'p',PORT:'8797',CAT_REMOTE_PORT:'8798',CAT_TOWN_DATA:'team',CAT_OWNER_KEY:'k',CAT_TEAM:'team-1'});
  assert.throws(()=>teamEnv({},{dataDir:'team',port:8797,remotePort:8798,ownerKey:'k'}),/Not a team name/,'no slug, no server that could take the private town\'s cookie names');
});
