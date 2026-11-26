import { decrypt, decode, hashCode } from '../shared/crypto.mjs';
const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const filePattern = /^[a-f0-9-]{36}$/;
export const DELIVERY_VERSION = '3';
const security = {'X-Asset-Delivery-Version':DELIVERY_VERSION,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"};
const json = (data,status=200) => new Response(JSON.stringify(data),{status,headers:{...security,'Content-Type':'application/json'}});
const unavailable = code => json({error:'Download is temporarily unavailable. Please try again or contact the creator.',code},503);
const storageCode = (stage,error) => `${stage}_${error.code==='STORAGE_REDIRECT'?'REDIRECT':[401,403,404,429].includes(error.status)?error.status:'NETWORK'}`;
export async function githubRead(path, env, fetcher = fetch) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY || '')) throw Error('Repository is not configured.');
  // Workers support manual/follow only. Never follow a redirect with the vault token.
  const response = await fetcher(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/contents/vault/${path}?ref=${encodeURIComponent(env.GITHUB_BRANCH || 'main')}`, {headers:{Authorization:`Bearer ${env.GITHUB_TOKEN}`,Accept:'application/vnd.github.raw+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'brevvsky-asset-delivery'},cache:'no-store',redirect:'manual'});
  if(response.status>=300 && response.status<400){await response.body?.cancel();const error=Error('Private storage redirect refused.');error.code='STORAGE_REDIRECT';error.status=response.status;throw error;}
  if (!response.ok) {const error=Error('Private storage unavailable.');error.status=response.status;throw error;}
  const text = await response.text();
  if(text.length > 96 * 1024 * 1024) throw Error('File exceeds delivery limits.');
  return text;
}
export async function deliver(request, env, fetcher = fetch) {
  if(request.method !== 'POST') return json({error:'Use POST for downloads.'},405);
  const url = new URL(request.url), origin = request.headers.get('Origin');
  if(origin && origin !== url.origin) return json({error:'Request origin is not allowed.'},403);
  if(!env.VAULT_KEY || !env.GITHUB_TOKEN) return unavailable('CONFIG_SECRETS');
  if(!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY || '')) return unavailable('CONFIG_REPOSITORY');
  if(env.DOWNLOAD_LIMITER) {
    const {success} = await env.DOWNLOAD_LIMITER.limit({key:request.headers.get('CF-Connecting-IP') || 'unknown'});
    if(!success) return json({error:'Too many attempts. Try again in a minute.'},429);
  } else return unavailable('CONFIG_LIMITER');
  if(!request.headers.get('Content-Type')?.includes('application/json')) return json({error:'Expected JSON.'},415);
  if(Number(request.headers.get('Content-Length')||0)>1024)return json({error:'Request is too large.'},413);
  const reader=request.body?.getReader();let text='';const decoder=new TextDecoder();let length=0;
  if(reader)while(true){const {value,done}=await reader.read();if(done)break;length+=value.byteLength;if(length>1024){await reader.cancel();return json({error:'Request is too large.'},413);}text+=decoder.decode(value,{stream:true});}
  text+=decoder.decode();
  let body; try{body=JSON.parse(text);}catch{return json({error:'Invalid request.'},400);}
  if(!body || typeof body!=='object' || !idPattern.test(body.productId || '') || typeof body.code !== 'string' || body.code.length>128) return json({error:'Invalid asset or access code.'},400);
  let stage = 'INDEX_READ';
  try {
    const indexText = await githubRead(`${body.productId}.enc`,env,fetcher);
    stage = 'INDEX_DECRYPT';
    const index = JSON.parse(decode(await decrypt(indexText,env.VAULT_KEY,`index:${body.productId}`)));
    stage = 'INDEX_METADATA';
    if(!index || !['paid','free'].includes(index.access) || (index.access==='paid' && (!index.licenses || typeof index.licenses!=='object')))throw Error('Invalid index.');
    let file = index.freeFile;
    if(index.access !== 'free') {
      const license = index.licenses[await hashCode(body.productId,body.code)];
      if(!license || !license.active || (license.expiresAt && Date.parse(license.expiresAt)<=Date.now())) return json({error:'License is invalid, expired, or revoked.'},403);
      file=license.file;
    }
    if(!filePattern.test(file || '') || !['.rbxm','.rbxmx'].includes(index.extension)) throw Error('Invalid file metadata.');
    stage = 'FILE_READ';
    const fileText = await githubRead(`${file}.enc`,env,fetcher);
    stage = 'FILE_DECRYPT';
    const bytes=await decrypt(fileText,env.VAULT_KEY,`file:${file}`);
    stage = 'DOWNLOAD_RESPONSE';
    return new Response(bytes,{headers:{...security,'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename="${body.productId}${index.extension}"`}});
  } catch(error) {
    if(stage==='INDEX_READ' && error.status===404)return json({error:'Asset or license unavailable.'},403);
    return unavailable(stage==='INDEX_READ' || stage==='FILE_READ' ? storageCode(stage,error) : stage);
  }
}
export default {async fetch(request,env) {
  const path=new URL(request.url).pathname;
  if(path==='/api/download') return deliver(request,env);
  if(path.startsWith('/api/') || /^\/(admin|local)(\/|$)/.test(path)) return json({error:'Not found.'},404);
  return env.ASSETS.fetch(request);
}};
