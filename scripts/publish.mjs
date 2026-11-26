import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initialize, root } from '../local/vault.mjs';
import { readSettings, syncVault } from '../local/github.mjs';
const key=await initialize(),settings=await readSettings(key);
function wrangler(args,input){return new Promise((resolve,reject)=>{const command=process.platform==='win32'?'npm.cmd':'npm';const child=spawn(command,['exec','--yes','--','wrangler',...args],{cwd:root,stdio:[input?'pipe':'inherit','inherit','inherit'],shell:process.platform==='win32',windowsHide:true});if(input)child.stdin.end(input);child.on('error',reject);child.on('close',code=>code===0?resolve():reject(Error(`Wrangler exited with code ${code}.`)));});}
try {
  if(!settings.deliveryToken)throw Error('Save a separate read-only delivery token in Local Studio before publishing. It needs Contents: read access to the private vault only.');
  console.log('Syncing encrypted private vault…');
  console.log((await syncVault(settings)).message);
  const configPath=join(root,'wrangler.jsonc'),config=JSON.parse(await readFile(configPath,'utf8'));
  config.vars.GITHUB_REPOSITORY=settings.repository;config.vars.GITHUB_BRANCH=settings.branch;
  await writeFile(configPath,JSON.stringify(config,null,2)+'\n');
  console.log('Publishing storefront. Downloads stay unavailable until secrets are configured.');
  await wrangler(['deploy']);
  console.log('Configuring private delivery secrets…');
  // Secrets go only through stdin, never command-line arguments or a tracked file.
  await wrangler(['secret','bulk'],JSON.stringify({VAULT_KEY:key,GITHUB_TOKEN:settings.deliveryToken}));
  console.log('Published. Use the workers.dev URL printed by Wrangler.');
} catch(error){console.error(error.message);process.exitCode=1;}
