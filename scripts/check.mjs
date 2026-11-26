import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
let failed=false;
async function scan(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isDirectory())await scan(path);else if(/\.(mjs|js)$/.test(path)){const result=spawnSync(process.execPath,['--check',path],{encoding:'utf8'});if(result.status){failed=true;console.error(result.stderr);}}}}
for(const dir of ['local','public','scripts','shared','worker','tests'])await scan(join(root,dir));
const catalog=JSON.parse(await readFile(join(root,'public/catalog.json'),'utf8'));
if(!Array.isArray(catalog.products))throw Error('Invalid catalog.');
const entries=await readdir(join(root,'public'));
if(entries.some(name=>name==='.private'||name==='admin'||name==='vault'||name.endsWith('.enc')))throw Error('Private files found in public output.');
if(failed)process.exitCode=1;else console.log('JavaScript syntax, catalog, and public/private boundary checks passed.');
