import { verifyOwner } from '../shared/owner-auth.mjs';
const hashPattern=/^[a-f0-9]{64}$/;
const usageHeaders={'Cache-Control':'no-store','Content-Type':'application/json','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"};
const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:usageHeaders});

// A plain Durable Object class keeps this module importable in Node tests.
// All durable state is in SQLite; no keys, customer names, files or IPs are stored.
export class LicenseUsageStore {
  constructor(ctx) {
    this.sql=ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS license_usage (license_hash TEXT PRIMARY KEY, downloads INTEGER NOT NULL, last_download_at TEXT NOT NULL)');
  }
  async fetch(request) {
    if(request.method!=='POST')return reply({error:'Method not allowed.'},405);
    const path=new URL(request.url).pathname;
    let body;try{body=await request.json();}catch{return reply({error:'Invalid request.'},400);}
    if(path==='/record') {
      if(!hashPattern.test(body?.hash||''))return reply({error:'Invalid hash.'},400);
      this.sql.exec('INSERT INTO license_usage (license_hash, downloads, last_download_at) VALUES (?, 1, ?) ON CONFLICT(license_hash) DO UPDATE SET downloads = license_usage.downloads + 1, last_download_at = excluded.last_download_at',body.hash,new Date().toISOString());
      return reply({ok:true});
    }
    if(path==='/read') {
      if(!Array.isArray(body?.hashes)||body.hashes.length>100||body.hashes.some(h=>!hashPattern.test(h)))return reply({error:'Invalid hashes.'},400);
      const hashes=[...new Set(body.hashes)],usages={};
      if(hashes.length) {
        const rows=this.sql.exec(`SELECT license_hash, downloads, last_download_at FROM license_usage WHERE license_hash IN (${hashes.map(()=>'?').join(',')})`,...hashes).toArray();
        for(const row of rows)usages[row.license_hash]={downloads:row.downloads,lastDownloadAt:row.last_download_at};
      }
      return reply({usages});
    }
    return reply({error:'Not found.'},404);
  }
}
export async function usageRequest(env,path,body) {
  if(!env.USAGE)throw Error('Usage storage is not configured.');
  const id=env.USAGE.idFromName('license-usage-v1');
  const response=await env.USAGE.get(id).fetch(`https://usage.internal${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(!response.ok)throw Error('Usage storage is unavailable.');
  return response.json();
}
export async function ownerUsage(request,env) {
  if(request.method!=='POST')return reply({error:'Method not allowed.'},405);
  const reader=request.body?.getReader();let size=0,text='';const decoder=new TextDecoder();
  if(reader)while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>16384){await reader.cancel();return reply({error:'Request too large.'},413);}text+=decoder.decode(value,{stream:true});}
  text+=decoder.decode();
  if(!env.VAULT_KEY||!await verifyOwner(request,text,env.VAULT_KEY))return reply({error:'Owner authentication required.'},401);
  let body;try{body=JSON.parse(text);}catch{return reply({error:'Invalid request.'},400);}
  if(!Array.isArray(body?.hashes)||body.hashes.length>100||body.hashes.some(h=>!hashPattern.test(h)))return reply({error:'Invalid request.'},400);
  try{return reply(await usageRequest(env,'/read',{hashes:body.hashes}));}
  catch{return reply({error:'Download statistics are not available yet. Deploy the latest Worker.'},503);}
}
