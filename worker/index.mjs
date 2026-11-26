import { decrypt, decode, hashCode } from '../shared/crypto.mjs';
const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const filePattern = /^[a-f0-9-]{36}$/;
const security = {'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"};
const json = (data,status=200) => new Response(JSON.stringify(data),{status,headers:{...security,'Content-Type':'application/json'}});
export async function githubRead(path, env, fetcher = fetch) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY || '')) throw Error('Repository is not configured.');
  const response = await fetcher(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/contents/vault/${path}?ref=${encodeURIComponent(env.GITHUB_BRANCH || 'main')}`, {headers:{Authorization:`Bearer ${env.GITHUB_TOKEN}`,Accept:'application/vnd.github.raw+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'brevvsky-asset-delivery'},cache:'no-store',redirect:'error'});
  if (!response.ok) {const error=Error('Private storage unavailable.');error.status=response.status;throw error;}
  const text = await response.text();
  if(text.length > 96 * 1024 * 1024) throw Error('File exceeds delivery limits.');
  return text;
}
export async function deliver(request, env, fetcher = fetch) {
  if(request.method !== 'POST') return json({error:'Use POST for downloads.'},405);
  const url = new URL(request.url), origin = request.headers.get('Origin');
  if(origin && origin !== url.origin) return json({error:'Request origin is not allowed.'},403);
  if(!env.VAULT_KEY || !env.GITHUB_TOKEN) return json({error:'Downloads are not configured yet. Please contact the creator.'},503);
  if(env.DOWNLOAD_LIMITER) {
    const {success} = await env.DOWNLOAD_LIMITER.limit({key:request.headers.get('CF-Connecting-IP') || 'unknown'});
    if(!success) return json({error:'Too many attempts. Try again in a minute.'},429);
  } else return json({error:'Download protection is not configured.'},503);
  if(!request.headers.get('Content-Type')?.includes('application/json')) return json({error:'Expected JSON.'},415);
  if(Number(request.headers.get('Content-Length')||0)>1024)return json({error:'Request is too large.'},413);
  const reader=request.body?.getReader();let text='';const decoder=new TextDecoder();let length=0;
  if(reader)while(true){const {value,done}=await reader.read();if(done)break;length+=value.byteLength;if(length>1024){await reader.cancel();return json({error:'Request is too large.'},413);}text+=decoder.decode(value,{stream:true});}
  text+=decoder.decode();
  let body; try{body=JSON.parse(text);}catch{return json({error:'Invalid request.'},400);}
  if(!idPattern.test(body.productId || '') || typeof body.code !== 'string' || body.code.length>128) return json({error:'Invalid asset or access code.'},400);
  try {
    let index;
    try {index=JSON.parse(decode(await decrypt(await githubRead(`${body.productId}.enc`,env,fetcher),env.VAULT_KEY,`index:${body.productId}`)));}
    catch(error){if(error.status===404)return json({error:'Asset or license unavailable.'},403);throw error;}
    let file = index.freeFile;
    if(index.access !== 'free') {
      const license = index.licenses[await hashCode(body.productId,body.code)];
      if(!license || !license.active || (license.expiresAt && Date.parse(license.expiresAt)<=Date.now())) return json({error:'License is invalid, expired, or revoked.'},403);
      file=license.file;
    }
    if(!filePattern.test(file || '') || !['.rbxm','.rbxmx'].includes(index.extension)) throw Error('Invalid file metadata.');
    const bytes=await decrypt(await githubRead(`${file}.enc`,env,fetcher),env.VAULT_KEY,`file:${file}`);
    return new Response(bytes,{headers:{...security,'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename="${body.productId}${index.extension}"`}});
  } catch {return json({error:'Download is temporarily unavailable. Please try again or contact the creator.'},503);}
}
export default {async fetch(request,env) {
  const path=new URL(request.url).pathname;
  if(path==='/api/download') return deliver(request,env);
  if(path.startsWith('/api/') || /^\/(admin|local)(\/|$)/.test(path)) return json({error:'Not found.'},404);
  return env.ASSETS.fetch(request);
}};
