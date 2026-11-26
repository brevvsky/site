import { utf8, unbase64 } from './crypto.mjs';

async function ownerKey(secret) {
  const raw=unbase64(secret);
  if(raw.length!==32)throw Error('Invalid owner key.');
  const material=await crypto.subtle.importKey('raw',raw,'HKDF',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:utf8('brevvsky-owner-api-v1'),info:utf8('license-usage-and-probes')},material,{name:'HMAC',hash:'SHA-256',length:256},false,['sign','verify']);
}
const message=(path,body,timestamp)=>utf8(`POST\n${path}\n${timestamp}\n${body}`);
export async function ownerHeaders(secret,path,body,timestamp=String(Math.floor(Date.now()/1000))) {
  const bytes=new Uint8Array(await crypto.subtle.sign('HMAC',await ownerKey(secret),message(path,body,timestamp)));
  return {'X-Owner-Timestamp':timestamp,'X-Owner-Signature':[...bytes].map(b=>b.toString(16).padStart(2,'0')).join('')};
}
export async function verifyOwner(request,body,secret,now=Date.now()) {
  try {
    const timestamp=request.headers.get('X-Owner-Timestamp')||'',signature=request.headers.get('X-Owner-Signature')||'';
    if(!/^\d{10}$/.test(timestamp)||! /^[a-f0-9]{64}$/.test(signature)||Math.abs(now/1000-Number(timestamp))>300)return false;
    const bytes=Uint8Array.from(signature.match(/../g),s=>parseInt(s,16));
    return await crypto.subtle.verify('HMAC',await ownerKey(secret),bytes,message(new URL(request.url).pathname,body,timestamp));
  } catch {return false;}
}
