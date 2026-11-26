import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,cp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { root } from '../local/vault.mjs';
test('local admin: authentication, upload, personal issue, edit, revoke and secret isolation',async()=>{
  const temp=await mkdtemp(join(tmpdir(),'brevvsky-test-'));
  try {
    for(const dir of ['local','shared','public'])await cp(join(root,dir),join(temp,dir),{recursive:true});
    await cp(join(root,'tests/server-scenario.mjs'),join(temp,'scenario.mjs'));
    const result=await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[join(temp,'scenario.mjs')],{windowsHide:true,stdio:['ignore','pipe','pipe']});
      let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));
    });
    assert.equal(result.code,0,result.stdout+result.stderr);
    assert.match(result.stdout,/Request pipeline verified/);
  } finally {
    if(!temp.startsWith(join(tmpdir(),'brevvsky-test-')))throw Error('Unsafe test cleanup path.');
    await rm(temp,{recursive:true,force:true});
  }
});
