import test from 'node:test';
import assert from 'node:assert/strict';
import {tunnelCommand} from '../src/tunnel.ts';
const token='tok_secret_value_123';
const named={CAT_TUNNEL_TOKEN:token,CAT_TUNNEL_ORIGIN:'https://Town.example.com/'};

test('quick tunnel arguments stay unchanged without named-tunnel variables',()=>{
  const command=tunnelCommand(8788,{},'quick-tunnel.yml');
  assert.deepEqual(command.args,['tunnel','--config','quick-tunnel.yml','--no-autoupdate','--url','http://127.0.0.1:8788']);
  assert.deepEqual(command.env,{});assert.equal(command.origin,undefined);assert.equal(command.named,false);
});

test('named tunnel passes the token only in the environment and normalizes the origin',()=>{
  const command=tunnelCommand(8788,named,'quick-tunnel.yml');
  assert.deepEqual(command.args,['tunnel','--no-autoupdate','run']);
  assert.ok(!command.args.some(arg=>arg.includes(token)));
  assert.deepEqual(command.env,{TUNNEL_TOKEN:token});
  assert.equal(command.origin,'https://town.example.com');assert.equal(command.named,true);
});

test('named tunnel rejects non-https and path-bearing origins',()=>{
  assert.throws(()=>tunnelCommand(8788,{...named,CAT_TUNNEL_ORIGIN:'http://town.example.com'},'quick-tunnel.yml'),/https:\/\/ origin/);
  assert.throws(()=>tunnelCommand(8788,{...named,CAT_TUNNEL_ORIGIN:'https://town.example.com/app'},'quick-tunnel.yml'),/no path/);
  assert.throws(()=>tunnelCommand(8788,{...named,CAT_TUNNEL_ORIGIN:'not a url'},'quick-tunnel.yml'),/https:\/\/ origin/);
});

test('named tunnel requires both variables',()=>{
  assert.throws(()=>tunnelCommand(8788,{CAT_TUNNEL_TOKEN:token},'quick-tunnel.yml'),/Set both/);
  assert.throws(()=>tunnelCommand(8788,{CAT_TUNNEL_ORIGIN:'https://town.example.com'},'quick-tunnel.yml'),/Set both/);
});
