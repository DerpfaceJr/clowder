import test from 'node:test';
import assert from 'node:assert/strict';
import {WORKSHOP_COMMAND, workshopCard} from '../public/models-panel.js';

test('a missing distro shows the one-line installer command and no install button', () => {
  const c = workshopCard({distro:{name:'cat-workshop',present:false},isolated:false,tools:[{id:'cap1',purpose:'read tables',state:'not installed'}]});
  assert.equal(c.badge, 'Not installed');
  assert.equal(c.distro, 'No');
  assert.equal(c.isolated, 'No');
  assert.equal(c.command, WORKSHOP_COMMAND);
  assert.match(c.command, /install-workshop\.ps1$/);
  assert.equal(c.tools[0].action, true);
  assert.equal(c.tools[0].installable, false);
});

test('an isolated distro enables install for approved tools that are not installed', () => {
  const c = workshopCard({distro:{present:true},isolated:true,tools:[
    {id:'cap1',purpose:'read tables',state:'not installed'},
    {id:'cap2',purpose:'done',state:'installed'},
    {id:'cap3',need:'repo',state:'failed',reason:'licence not on allowlist: GPL-3.0'},
  ]});
  assert.equal(c.badge, 'Isolated');
  assert.equal(c.command, null);
  assert.equal(c.tools[0].installable, true);
  assert.equal(c.tools[1].action, false);
  assert.equal(c.tools[2].stateLabel, 'Failed');
  assert.equal(c.tools[2].installable, true);
});

test('a distro that is not isolated never offers install', () => {
  const c = workshopCard({distro:{present:true},isolated:false,tools:[{id:'cap1',purpose:'x',state:'not installed'}]});
  assert.equal(c.badge, 'Not isolated');
  assert.equal(c.tone, 'warn');
  assert.equal(c.tools[0].installable, false);
  assert.match(c.hint, /Nothing is installed or run/);
});

test('an installed repo with no run recipe is labelled as waiting, and says who decides', () => {
  const c = workshopCard({distro:{present:true},isolated:true,tools:[{id:'cap3',need:'repo',state:'not runnable'}]});
  assert.equal(c.tools[0].stateLabel, 'Installed, no run recipe yet');
  assert.equal(c.tools[0].action, false);
  const owner = workshopCard({distro:{present:true},isolated:true,tools:[{id:'cap3',need:'repo',state:'not runnable',recipe:{status:'needs_owner',description:'run it'}}]});
  assert.equal(owner.tools[0].stateLabel, 'Installed, the owner decides its run recipe');
  assert.equal(owner.tools[0].decidable, true);
  const approved = workshopCard({distro:{present:true},isolated:true,tools:[{id:'cap3',need:'repo',state:'not runnable',recipe:{status:'approved',description:'run it',long:true}}]});
  assert.equal(approved.tools[0].action, true);
  assert.equal(approved.tools[0].installable, true);
});

test('the setup card shows progress, a failure, and the WSL prompt only when WSL is missing', () => {
  const running = workshopCard({distro:{present:false},isolated:false,setup:{status:'running',lines:['a','b'],wsl:true},tools:[]});
  assert.equal(running.badge, 'Setting up');
  assert.equal(running.setup.running, true);
  assert.equal(running.setup.canCreate, false);
  const failed = workshopCard({distro:{present:false},isolated:false,setup:{status:'failed',error:'exit code 1',wsl:true},tools:[]});
  assert.equal(failed.setup.failure, 'exit code 1');
  assert.equal(failed.setup.canCreate, true);
  const noWsl = workshopCard({distro:{present:false},isolated:false,setup:{status:'idle',wsl:false},tools:[]});
  assert.equal(noWsl.setup.canCreate, false);
  assert.equal(noWsl.setup.canInstallWsl, true);
  assert.equal(workshopCard({distro:{present:false},isolated:false,settings:{autoSetup:false}}).autoSetup, false);
  assert.equal(workshopCard({distro:{present:false},isolated:false}).autoSetup, true);
});
