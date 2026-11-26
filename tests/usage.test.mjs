import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ownerHeaders, verifyOwner } from '../shared/owner-auth.mjs';
import { hashCode } from '../shared/crypto.mjs';
import { ownerUsage } from '../worker/usage.mjs';
import { fetchLicenseUsage } from '../local/usage.mjs';
const key=randomBytes(32).toString('base64'),path='/api/owner/usage';
const hash='a'.repeat(64),body=JSON.stringify({hashes:[hash]});
async function signed(bodyText=body,signPath=path,timestamp) {
  return new Request('https://studio.test'+path,{method:'POST',headers:{'Content-Type':'application/json',...await ownerHeaders(key,signPath,bodyText,timestamp)},body:bodyText});
}
test('owner signatures bind the body and endpoint and expire',async()=>{
  const request=await signed();assert.equal(await verifyOwner(request,body,key),true);
  assert.equal(await verifyOwner(request,body+' ',key),false);
  assert.equal(await verifyOwner(request,body,randomBytes(32).toString('base64')),false);
  assert.equal(await verifyOwner(await signed(body,'/api/download'),body,key),false);
  assert.equal(await verifyOwner(await signed(body,path,String(Math.floor(Date.now()/1000)-600)),body,key),false);
});
test('private statistics reject unsigned, tampered, expired and wrong-path requests without touching storage',async()=>{
  let calls=0;const env={VAULT_KEY:key,USAGE:{idFromName:()=>{calls++;}}};
  const unsigned=new Request('https://studio.test'+path,{method:'POST',body});
  for(const request of [unsigned,await signed(body,'/api/download'),await signed(body,path,String(Math.floor(Date.now()/1000)-600))])assert.equal((await ownerUsage(request,env)).status,401);
  assert.equal(calls,0);
});
test('authenticated owner statistics are returned without caching or public CORS',async()=>{
  const usages={[hash]:{downloads:7,lastDownloadAt:'2026-11-26T08:00:00.000Z'}};
  const env={VAULT_KEY:key,USAGE:{idFromName:n=>n,get:()=>({fetch:async(url,options)=>{assert.equal(new URL(url).pathname,'/read');assert.deepEqual(JSON.parse(options.body),{hashes:[hash]});return Response.json({usages});}})}};
  const response=await ownerUsage(await signed(),env);assert.equal(response.status,200);assert.deepEqual(await response.json(),{usages});assert.equal(response.headers.get('Cache-Control'),'no-store');assert.equal(response.headers.get('Access-Control-Allow-Origin'),null);
});
test('stats requests are bounded and accept only license digests',async()=>{
  const env={VAULT_KEY:key};
  for(const invalid of [{hashes:['plain-license']},{hashes:Array(101).fill(hash)},null])assert.equal((await ownerUsage(await signed(JSON.stringify(invalid)),env)).status,400);
});
test('local stats map cloud hashes to license rows and distinguish never used from unavailable',async()=>{
  const license={id:'license-id',productId:'asset',code:'BRV-PRIVATE-CODE'},digest=await hashCode(license.productId,license.code);
  const state={licenses:[license]},settings={storefrontUrl:'https://studio.example.workers.dev'};
  const report=await fetchLicenseUsage({key,settings,state,fetcher:async(url,options)=>{
    assert.equal(options.redirect,'manual');assert(!options.body.includes(license.code));assert(!JSON.stringify(options).includes(key));
    const req=new Request(url,options);assert.equal(await verifyOwner(req,options.body,key),true);
    assert.deepEqual(JSON.parse(options.body),{hashes:[digest]});
    return Response.json({usages:{[digest]:{downloads:4,lastDownloadAt:'2026-11-26T08:00:00Z'}}});
  }});
  assert.equal(report.usages[license.id].downloads,4);
  const unused=await fetchLicenseUsage({key,settings,state,fetcher:async()=>Response.json({usages:{}})});
  assert.deepEqual(unused.usages[license.id],{downloads:0,lastDownloadAt:null});
  await assert.rejects(fetchLicenseUsage({key,settings,state,fetcher:async()=>new Response('',{status:503})}),/Could not load/);
});
test('local stats batch large collections without dropping licenses',async()=>{
  const licenses=Array.from({length:205},(_,i)=>({id:String(i),productId:'asset',code:`PRIVATE-${i}`}));
  let calls=0;
  const result=await fetchLicenseUsage({key,settings:{storefrontUrl:'https://studio.test'},state:{licenses},fetcher:async(url,options)=>{calls++;assert(JSON.parse(options.body).hashes.length<=100);return Response.json({usages:{}});}});
  assert.equal(calls,3);assert.equal(Object.keys(result.usages).length,205);
});
