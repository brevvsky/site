import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { vaultRoot, privateRoot, atomic } from './vault.mjs';
import { encrypt, decrypt, decode, utf8 } from '../shared/crypto.mjs';
export async function readSettings(key) {
  try{return JSON.parse(decode(await decrypt(await readFile(join(privateRoot,'settings.enc'),'utf8'),key,'settings')));}catch(error){if(error.code==='ENOENT')return {};throw error;}
}
export async function writeSettings(settings,key){await atomic(join(privateRoot,'settings.enc'),await encrypt(utf8(JSON.stringify(settings)),key,'settings'));}
export async function github(settings,path,options={}) {
  const response=await fetch(`https://api.github.com${path}`,{...options,headers:{Authorization:`Bearer ${settings.token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'brevvsky-local-admin',...(options.body?{'Content-Type':'application/json'}:{})},signal:AbortSignal.timeout(60000),redirect:'error'});
  if(!response.ok)throw Error(`GitHub returned ${response.status}. Check the repository and token permissions.`);
  return response.json();
}
export async function syncVault(settings) {
  if(!/^[\w.-]+\/[\w.-]+$/.test(settings.repository||'') || !settings.token)throw Error('Configure your private GitHub repository first.');
  const base=`/repos/${settings.repository}`;
  const repo=await github(settings,base);
  if(!repo.private)throw Error('The vault repository must be PRIVATE. Nothing was uploaded.');
  const branch=settings.branch||repo.default_branch||'main';
  if(!/^[\w./-]+$/.test(branch))throw Error('Invalid branch.');
  let ref;
  try {ref=await github(settings,`${base}/git/ref/heads/${encodeURIComponent(branch)}`);}catch {throw Error('Initialize the private repository with a README before syncing.');}
  const commit=await github(settings,`${base}/git/commits/${ref.object.sha}`);
  const tree=await github(settings,`${base}/git/trees/${commit.tree.sha}?recursive=1`);
  if(tree.truncated)throw Error('Repository is too large to sync safely. Use a dedicated vault repository.');
  const existing=new Map(tree.tree.map(entry=>[entry.path,entry.sha])), changes=[];
  for(const name of (await readdir(vaultRoot)).filter(name=>/^[a-z0-9-]+\.enc$/.test(name))) {
    const bytes=await readFile(join(vaultRoot,name));
    const sha=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if(existing.get(`vault/${name}`)===sha)continue;
    const blob=await github(settings,`${base}/git/blobs`,{method:'POST',body:JSON.stringify({content:bytes.toString('base64'),encoding:'base64'})});
    changes.push({path:`vault/${name}`,mode:'100644',type:'blob',sha:blob.sha});
  }
  if(!changes.length)return {message:'Private vault is already up to date.',branch};
  const nextTree=await github(settings,`${base}/git/trees`,{method:'POST',body:JSON.stringify({base_tree:commit.tree.sha,tree:changes})});
  const nextCommit=await github(settings,`${base}/git/commits`,{method:'POST',body:JSON.stringify({message:'Update encrypted asset vault',tree:nextTree.sha,parents:[ref.object.sha]})});
  await github(settings,`${base}/git/refs/heads/${encodeURIComponent(branch)}`,{method:'PATCH',body:JSON.stringify({sha:nextCommit.sha,force:false})});
  return {message:`Synced ${changes.length} encrypted files to your private repository.`,branch};
}
