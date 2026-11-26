import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { encrypt, utf8, hashCode } from '../shared/crypto.mjs';
import { diagnoseDelivery } from '../local/diagnostics.mjs';
const key = randomBytes(32).toString('base64');
const license = {productId:'test-asset',code:'BRV-PRIVATE-CUSTOMER-CODE',active:true,file:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'};
const settings = {repository:'example/private',deliveryToken:'PRIVATE-TOKEN',branch:'main'};
const state = {products:{'test-asset':{}},licenses:[license]};
async function fixture() {
  const index = await encrypt(utf8(JSON.stringify({access:'paid',extension:'.rbxm',licenses:{[await hashCode(license.productId,license.code)]:{active:true,file:license.file}}})),key,'index:test-asset');
  const file = await encrypt(utf8('PRIVATE-MODEL'),key,`file:${license.file}`);
  return (url) => Promise.resolve(new Response(url.includes('test-asset.enc')?index:file));
}
test('diagnostics distinguish a rejected delivery token without printing secrets',async()=>{
  const lines=[];
  const ok=await diagnoseDelivery({key,settings,state,fetcher:async()=>new Response('',{status:403}),report:l=>lines.push(l)});
  assert.equal(ok,false);assert.match(lines.join('\n'),/HTTP 403/);assert.match(lines.join('\n'),/Contents: read/);
  for(const secret of [key,settings.deliveryToken,license.code])assert(!lines.join('\n').includes(secret));
});
test('diagnostics detect a missing remote copy even when the license is synced',async()=>{
  const good=await fixture(),lines=[];
  const ok=await diagnoseDelivery({key,settings,state,fetcher:(url)=>url.includes('test-asset.enc')?good(url):Promise.resolve(new Response('',{status:404})),report:l=>lines.push(l)});
  assert.equal(ok,false);assert(lines.some(l=>l.startsWith('OK license sync')));assert(lines.some(l=>l.startsWith('FAIL personal file')&&l.includes('HTTP 404')));
});
test('diagnostics isolate Cloudflare failure after all GitHub and decryption checks pass',async()=>{
  const good=await fixture(),lines=[];
  const ok=await diagnoseDelivery({key,settings,state,siteUrl:'https://test.example.workers.dev',fetcher:(url)=>url.includes('api.github.com')?good(url):Promise.resolve(new Response('Unavailable',{status:503})),report:l=>lines.push(l)});
  assert.equal(ok,false);assert(lines.some(l=>l.startsWith('OK personal file')));assert(lines.some(l=>l.startsWith('FAIL Cloudflare download')&&l.includes('HTTP 503')&&l.includes('predates detailed diagnostics')));
});
test('diagnostics confirm successful delivery without printing model data or credentials',async()=>{
  const good=await fixture(),lines=[];
  const ok=await diagnoseDelivery({key,settings,state,siteUrl:'https://test.example.workers.dev',fetcher:(url)=>url.includes('api.github.com')?good(url):Promise.resolve(new Response('PRIVATE-MODEL')),report:l=>lines.push(l)});
  assert.equal(ok,true);
  for(const secret of [key,settings.deliveryToken,license.code,'PRIVATE-MODEL'])assert(!lines.join('\n').includes(secret));
});
test('diagnostics explain an isolated Cloudflare vault key mismatch',async()=>{
  const good=await fixture(),lines=[];
  const ok=await diagnoseDelivery({key,settings,state,siteUrl:'https://test.example.workers.dev',fetcher:(url)=>url.includes('api.github.com')?good(url):Promise.resolve(Response.json({error:'Unavailable',code:'INDEX_DECRYPT'},{status:503})),report:l=>lines.push(l)});
  assert.equal(ok,false);assert(lines.some(l=>l.includes('[INDEX_DECRYPT]')&&l.includes('vault key')));
});
