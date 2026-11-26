import { mkdir, readFile, writeFile, rename, access } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { encrypt, decrypt, decode, utf8, hashCode } from '../shared/crypto.mjs';
export const root = fileURLToPath(new URL('../', import.meta.url));
export const privateRoot = join(root, '.private');
export const vaultRoot = join(privateRoot, 'vault');
export const catalogPath = join(root, 'public/catalog.json');
export const MAX_MODEL = 16 * 1024 * 1024;
export async function atomic(path, content) {
  await mkdir(dirname(path), {recursive:true});
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, content, {mode:0o600}); await rename(temp, path);
}
export async function initialize() {
  await mkdir(vaultRoot, {recursive:true});
  const keyPath = join(privateRoot, 'vault.key');
  try { await access(keyPath); } catch { await writeFile(keyPath, randomBytes(32).toString('base64'), {mode:0o600, flag:'wx'}); }
  return (await readFile(keyPath,'utf8')).trim();
}
export const readCatalog = async () => JSON.parse(await readFile(catalogPath,'utf8'));
export const writeCatalog = async catalog => atomic(catalogPath, JSON.stringify(catalog,null,2)+'\n');
export async function readState(secret) {
  try { return JSON.parse(decode(await decrypt(await readFile(join(vaultRoot,'owner.enc'),'utf8'),secret,'owner'))); }
  catch (error) { if (error.code === 'ENOENT') return {products:{},licenses:[]}; throw error; }
}
export async function writeState(state, secret) {
  // owner.enc includes customer notes and full codes; never fetched by the public Worker.
  await atomic(join(vaultRoot,'owner.enc'), await encrypt(utf8(JSON.stringify(state)),secret,'owner'));
  for (const [id, product] of Object.entries(state.products)) {
    const licenses = {};
    for (const license of state.licenses.filter(l => l.productId === id)) {
      licenses[await hashCode(id,license.code)] = {file:license.file,active:license.active,expiresAt:license.expiresAt};
    }
    await atomic(join(vaultRoot,`${id}.enc`),await encrypt(utf8(JSON.stringify({version:1,access:product.access,freeFile:product.freeFile || null,extension:product.extension,licenses})),secret,`index:${id}`));
  }
}
export function generateCode() { return `BRV-${randomBytes(20).toString('hex').toUpperCase().match(/.{1,8}/g).join('-')}`; }
export async function stampModel(bytes, code, extension) {
  return new Promise((resolve,reject) => {
    const child = spawn(process.env.PYTHON || 'python',['-I',join(root,'local/stamp.py')], {windowsHide:true,stdio:['pipe','pipe','pipe']});
    const chunks = []; let size = 0;
    const timer = setTimeout(() => {child.kill();reject(Error('Model processing timed out.'));},60000);
    child.stdout.on('data',chunk => { size += chunk.length; if (size > MAX_MODEL * 12) child.kill(); else chunks.push(chunk); });
    child.stderr.resume(); child.on('error',error => {clearTimeout(timer);reject(Error(`Cannot start Python: ${error.message}`));});
    child.stdin.on('error',()=>{});
    child.on('close',() => { clearTimeout(timer); try { const result=JSON.parse(Buffer.concat(chunks)); if(result.error) throw Error(result.error); resolve({bytes:Buffer.from(result.data,'base64'),changed:result.changed}); } catch(error){reject(error);} });
    child.stdin.end(JSON.stringify({data:Buffer.from(bytes).toString('base64'),license:code,extension}));
  });
}
export async function storeFile(bytes, secret) {
  const id = randomUUID(); await atomic(join(vaultRoot,`${id}.enc`),await encrypt(bytes,secret,`file:${id}`)); return id;
}
export async function getFile(id, secret) { return decrypt(await readFile(join(vaultRoot,`${id}.enc`),'utf8'),secret,`file:${id}`); }
export const modelExtension = name => {const extension=extname(name).toLowerCase();if(!['.rbxm','.rbxmx'].includes(extension))throw Error('Upload a .rbxm or .rbxmx Roblox model.');return extension;};
