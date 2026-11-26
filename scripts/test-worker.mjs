import { build } from 'esbuild';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../',import.meta.url));
await mkdir(join(root,'.private'),{recursive:true});
const tempPrefix = join(root,'.private','runtime-test-');
const directory = await mkdtemp(tempPrefix);
try {
  const output = await build({entryPoints:[join(root,'tests/worker-runtime.mjs')],bundle:true,write:false,format:'esm',platform:'browser'});
  await writeFile(join(directory,'worker.mjs'),output.outputFiles[0].contents);
  const config = join(directory,'runtime.capnp');
  await mkdir(join(directory,'state'));
  // A dedicated test-owned disk directory exercises actual SQLite persistence.
  await writeFile(config,`using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [(name = "main", worker = (
    modules = [(name = "worker.mjs", esModule = embed "worker.mjs")],
    compatibilityDate = "2026-11-26",
    bindings = [(name = "USAGE", durableObjectNamespace = "LicenseUsageStore")],
    durableObjectNamespaces = [(className = "LicenseUsageStore", uniqueKey = "license-usage-runtime-test", enableSql = true)],
    durableObjectStorage = (localDisk = "storage")
  )), (name = "storage", disk = (path = ${JSON.stringify(join(directory,'state').replace(/\\/g,'/'))}, writable = true))]
);
`);
  const exitCode = await new Promise((resolve,reject)=>{
    const child = spawn(process.execPath,[join(root,'node_modules/workerd/bin/workerd'),'test',config],{cwd:root,stdio:'inherit',windowsHide:true});
    child.on('error',reject);child.on('close',resolve);
  });
  process.exitCode = exitCode ?? 1;
} finally {
  if(!directory.startsWith(tempPrefix))throw Error('Unsafe runtime test cleanup path.');
  await rm(directory,{recursive:true,force:true});
}
