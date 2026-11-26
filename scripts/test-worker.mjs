import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../',import.meta.url));
const tempPrefix = join(tmpdir(),'brevvsky-runtime-');
const directory = await mkdtemp(tempPrefix);
try {
  const output = await build({entryPoints:[join(root,'tests/worker-runtime.mjs')],bundle:true,write:false,format:'esm',platform:'browser'});
  await writeFile(join(directory,'worker.mjs'),output.outputFiles[0].contents);
  const config = join(directory,'wrangler.json');
  await writeFile(config,JSON.stringify({main:'worker.mjs',compatibility_date:'2026-11-26',no_bundle:true}));
  const exitCode = await new Promise((resolve,reject)=>{
    const child = spawn(process.execPath,[join(root,'node_modules/workerd/bin/workerd'),'test',config],{cwd:root,stdio:'inherit',windowsHide:true});
    child.on('error',reject);child.on('close',resolve);
  });
  process.exitCode = exitCode ?? 1;
} finally {
  if(!directory.startsWith(tempPrefix))throw Error('Unsafe runtime test cleanup path.');
  await rm(directory,{recursive:true,force:true});
}
