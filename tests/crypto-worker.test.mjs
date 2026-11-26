import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { encrypt,decrypt,utf8,decode,hashCode } from '../shared/crypto.mjs';
import { deliver } from '../worker/index.mjs';
const key=randomBytes(32).toString('base64'),file='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',productId='apex-coupe',code='BRV-TEST-EXCLUSIVE-BUYER';
test('AES-GCM hides plaintext, uses random IVs and binds files to their identity',async()=>{
  const first=await encrypt(utf8('secret model'),key,'file:a'),second=await encrypt(utf8('secret model'),key,'file:a');
  assert.notEqual(first,second);assert(!first.includes('secret model'));assert.equal(decode(await decrypt(first,key,'file:a')),'secret model');
  await assert.rejects(decrypt(first,key,'file:b'));await assert.rejects(decrypt(first,randomBytes(32).toString('base64'),'file:a'));
  const changed=JSON.parse(first);changed.data=(changed.data[0]==='A'?'B':'A')+changed.data.slice(1);await assert.rejects(decrypt(changed,key,'file:a'));
});
async function setup({active=true,expiresAt=null,access='paid',limiter=true}={}) {
  const index={version:1,access,freeFile:access==='free'?file:null,extension:'.rbxm',licenses:{[await hashCode(productId,code)]:{active,expiresAt,file}}};
  const storage=new Map([[`${productId}.enc`,await encrypt(utf8(JSON.stringify(index)),key,`index:${productId}`)],[`${file}.enc`,await encrypt(utf8('personal model bytes'),key,`file:${file}`)]]),requests=[];
  const env={VAULT_KEY:key,GITHUB_TOKEN:'test-only-token',GITHUB_REPOSITORY:'test/private',GITHUB_BRANCH:'main',DOWNLOAD_LIMITER:{limit:async()=>({success:limiter})}};
  const fetcher=async(url,options)=>{requests.push({url,options});const name=new URL(url).pathname.split('/').pop();return storage.has(name)?new Response(storage.get(name)):new Response('',{status:404});};
  return {env,fetcher,requests,storage};
}
const request=(body={productId,code},headers={})=>new Request('https://studio.test/api/download',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://studio.test',...headers},body:JSON.stringify(body)});
test('a valid personal license returns only its assigned file without exposing repository URLs',async()=>{
  const f=await setup(),response=await deliver(request(),f.env,f.fetcher);assert.equal(response.status,200);assert.equal(await response.text(),'personal model bytes');assert.equal(response.headers.get('Cache-Control'),'no-store');assert.match(response.headers.get('Content-Disposition'),/apex-coupe.rbxm/);assert.equal(f.requests.length,2);assert(f.requests.every(r=>r.options.redirect==='manual'));assert.equal(response.headers.get('Access-Control-Allow-Origin'),null);
});
for(const [name,options,body] of [['incorrect key',{}, {productId,code:'wrong'}],['revoked key',{active:false}],['expired key',{expiresAt:'2020-01-01T00:00:00.000Z'}],['code for another product',{}, {productId:'other-product',code}]])test(`${name} cannot retrieve a file`,async()=>{const f=await setup(options),response=await deliver(request(body),f.env,f.fetcher);assert.equal(response.status,403);assert(!f.requests.some(r=>r.url.includes(file)));});
test('free assets require no code and use the free file only',async()=>{const f=await setup({access:'free'}),response=await deliver(request({productId,code:''}),f.env,f.fetcher);assert.equal(response.status,200);});
test('future expiry and whitespace around a code are accepted',async()=>{const f=await setup({expiresAt:'2099-01-01T00:00:00Z'});assert.equal((await deliver(request({productId,code:` ${code} `}),f.env,f.fetcher)).status,200);});
test('cross-site requests, brute force, traversal and missing configuration are blocked',async()=>{
  let f=await setup();assert.equal((await deliver(request(undefined,{Origin:'https://evil.test'}),f.env,f.fetcher)).status,403);assert.equal(f.requests.length,0);
  f=await setup({limiter:false});assert.equal((await deliver(request(),f.env,f.fetcher)).status,429);assert.equal(f.requests.length,0);
  f=await setup();assert.equal((await deliver(request({productId:'../owner',code}),f.env,f.fetcher)).status,400);assert.equal(f.requests.length,0);
  assert.equal((await deliver(request(),{},f.fetcher)).status,503);
  delete f.env.DOWNLOAD_LIMITER;assert.equal((await deliver(request(),f.env,f.fetcher)).status,503);
});
test('storage and authentication errors return a safe error without leaking secrets',async()=>{const f=await setup();const response=await deliver(request(),f.env,async()=>{throw Error('token: SECRET');});assert.equal(response.status,503);assert(!(await response.text()).includes('SECRET'));});
test('license hashes are specific to the product',async()=>{assert.notEqual(await hashCode('a',code),await hashCode('b',code));});
for(const status of [401,403,429])test(`GitHub ${status} gets a safe stage reference`,async()=>{
  const f=await setup();const response=await deliver(request(),f.env,async()=>new Response('PRIVATE DETAILS',{status}));
  assert.equal(response.status,503);const body=await response.json();assert.equal(body.code,`INDEX_READ_${status}`);assert(!JSON.stringify(body).includes('PRIVATE DETAILS'));
});
test('a different Cloudflare key is distinguished from an invalid license',async()=>{
  const f=await setup();f.env.VAULT_KEY=randomBytes(32).toString('base64');const response=await deliver(request(),f.env,f.fetcher);
  assert.equal(response.status,503);assert.equal((await response.json()).code,'INDEX_DECRYPT');
});
test('a missing personal file has a different reference from a missing license index',async()=>{
  const f=await setup();f.storage.delete(`${file}.enc`);const response=await deliver(request(),f.env,f.fetcher);
  assert.equal(response.status,503);assert.equal((await response.json()).code,'FILE_READ_404');
});
test('a corrupted personal file gets a decryption reference without returning model bytes',async()=>{
  const f=await setup();f.storage.set(`${file}.enc`,'invalid ciphertext');const response=await deliver(request(),f.env,f.fetcher);
  assert.equal(response.status,503);assert.equal((await response.json()).code,'FILE_DECRYPT');
});
test('null request bodies are rejected without throwing an unhandled error',async()=>{
  const f=await setup();assert.equal((await deliver(request(null),f.env,f.fetcher)).status,400);
});
test('delivery works with the redirect modes supported by the Workers runtime',async()=>{
  const f=await setup();
  const workersFetch=(url,options)=>{
    if(!['manual','follow'].includes(options.redirect))throw new TypeError('Invalid redirect value, must be one of follow or manual.');
    return f.fetcher(url,options);
  };
  const response=await deliver(request(),f.env,workersFetch);
  assert.equal(response.status,200);assert.equal(await response.text(),'personal model bytes');
});
for(const status of [301,302,307,308])test(`GitHub redirect ${status} is refused without forwarding the token`,async()=>{
  const f=await setup();let requests=0;
  const response=await deliver(request(),f.env,async(url,options)=>{
    requests++;assert.equal(new URL(url).hostname,'api.github.com');assert.equal(options.redirect,'manual');
    return new Response('',{status,headers:{Location:'https://untrusted.example/private'}});
  });
  assert.equal(response.status,503);assert.equal((await response.json()).code,'INDEX_READ_REDIRECT');assert.equal(requests,1);
});
