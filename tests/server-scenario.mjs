// Executes the actual HTTP routing pipeline without opening an outbound socket.
// The execution sandbox blocks loopback client connections.
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { handler,launchToken } from './local/server.mjs';
import { hashCode } from './shared/crypto.mjs';
import { verifyOwner } from './shared/owner-auth.mjs';
const origin='http://127.0.0.1:4317';
async function request(path,data,headers={}) {
  const req=Readable.from(data?[Buffer.from(JSON.stringify(data))]:[]);
  req.method=data?'POST':'GET';req.url=path;req.headers={host:'127.0.0.1:4317','content-type':'application/json',origin,...headers};
  let status,output,responseHeaders;
  const res={headersSent:false,writeHead(code,h){status=code;responseHeaders=h;this.headersSent=true;},end(body){output=body;}};
  await handler(req,res);
  const text=Buffer.isBuffer(output)||output instanceof Uint8Array?Buffer.from(output).toString():output;
  return {status,headers:responseHeaders,text,json:()=>JSON.parse(text)};
}
assert.equal((await request('/local/state')).status,401);
assert.equal((await request('/local/usage')).status,401);
const login=await request('/local/session',{token:launchToken});assert.equal(login.status,200);
const cookie=login.headers['Set-Cookie'].split(';')[0];
const post=(path,data,headers={})=>request(path,data,{cookie,...headers});
assert.equal((await post('/local/license',{}, {origin:'https://evil.test'})).status,403);
assert.equal((await request('/.private/vault.key')).status,404);
assert.equal((await request('/local/../.private/vault.key')).status,404);
const xml='<roblox version="4"><Item class="Part" referent="a"><Properties><string name="Name">Vehicle</string></Properties></Item><Item class="Script" referent="b"><Properties><ProtectedString name="Source">print(1)</ProtectedString></Properties></Item></roblox>';
const saved=await post('/local/product',{id:'test-vehicle',title:'Test vehicle',category:'Vehicle',access:'paid',description:'Test asset',model:{name:'car.rbxmx',data:Buffer.from(xml).toString('base64')}});assert.equal(saved.status,200,saved.text);
const issued=await post('/local/license',{productId:'test-vehicle',buyer:'Buyer one',notes:'private-order',active:true});assert.equal(issued.status,200,issued.text);const {license}=issued.json();assert.equal(license.parts,2);
const ownerKey=(await readFile(new URL('./.private/vault.key',import.meta.url),'utf8')).trim();
const digest=await hashCode(license.productId,license.code),previousFetch=globalThis.fetch;
globalThis.fetch=async(url,options)=>{
  assert.equal(new URL(url).pathname,'/api/owner/usage');assert(!options.body.includes(license.code));
  assert.equal(await verifyOwner(new Request(url,options),options.body,ownerKey),true);
  return Response.json({usages:{[digest]:{downloads:6,lastDownloadAt:'2026-11-26T08:00:00Z'}}});
};
const usage=await request('/local/usage',undefined,{cookie});assert.equal(usage.status,200,usage.text);assert.equal(usage.json().usages[license.id].downloads,6);assert(!usage.text.includes(license.code));
globalThis.fetch=previousFetch;
const catalog=(await request('/catalog.json')).text;assert(!catalog.includes(license.code));assert(!catalog.includes('private-order'));
const download=await post('/api/download',{productId:'test-vehicle',code:license.code});assert.equal(download.status,200,download.text);assert(download.text.includes('AttributesSerialize'));
assert.equal((await post('/api/download',{productId:'test-vehicle',code:'wrong'})).status,403);
assert.equal((await post('/local/revoke',{id:license.id,active:false})).status,200);
assert.equal((await post('/api/download',{productId:'test-vehicle',code:license.code})).status,403);
assert.equal((await post('/local/revoke',{id:license.id,active:true})).status,200);
assert.equal((await post('/api/download',{productId:'test-vehicle',code:license.code})).status,200);
const encrypted=await readFile(new URL('./.private/vault/owner.enc',import.meta.url),'utf8');assert(!encrypted.includes(license.code));assert(!encrypted.includes('private-order'));
const changed=await post('/local/license',{...license,buyer:'Updated buyer',code:'BRV-REPLACEMENT-STRONG-KEY'});assert.equal(changed.status,200,changed.text);assert.equal((await post('/api/download',{productId:'test-vehicle',code:license.code})).status,403);assert.equal((await post('/api/download',{productId:'test-vehicle',code:'BRV-REPLACEMENT-STRONG-KEY'})).status,200);
const free=await post('/local/product',{id:'test-vehicle',title:'Free vehicle',category:'Vehicle',access:'free',description:'Updated'});assert.equal(free.status,200);const freeDownload=await post('/api/download',{productId:'test-vehicle',code:''});assert.equal(freeDownload.status,200);assert.equal(freeDownload.text,xml);
assert.equal((await request('/admin/admin.js')).status,200);
console.log('Request pipeline verified: auth, CSRF, upload, issue, edit, revoke, free access, secret isolation.');
