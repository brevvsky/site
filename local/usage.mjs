import { hashCode } from '../shared/crypto.mjs';
import { ownerHeaders } from '../shared/owner-auth.mjs';
export const defaultStorefront='https://brevvsky-assets.brevvsky.workers.dev';
export function storefrontUrl(value=defaultStorefront) {
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error('Enter the HTTPS address of your published website, without a path.');
  return url.origin;
}
export async function fetchLicenseUsage({key,settings,state,fetcher=fetch}) {
  const endpoint=new URL('/api/owner/usage',storefrontUrl(settings.storefrontUrl||defaultStorefront));
  const entries=await Promise.all(state.licenses.map(async license=>({id:license.id,hash:await hashCode(license.productId,license.code)})));
  const records={};
  for(let offset=0;offset<entries.length;offset+=100) {
    const batch=entries.slice(offset,offset+100),body=JSON.stringify({hashes:batch.map(e=>e.hash)});
    const headers=await ownerHeaders(key,endpoint.pathname,body);
    const response=await fetcher(endpoint.href,{method:'POST',headers:{'Content-Type':'application/json',...headers},body,redirect:'manual',cache:'no-store',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw Error(response.status===401?'The published site does not recognize this computer’s owner key. Run npm.cmd run publish.':response.status===404?'The published site needs the statistics update. Run npm.cmd run deploy.':'Could not load download statistics. Check the published website URL and deploy the latest Worker.');
    const data=await response.json();
    if(!data.usages||typeof data.usages!=='object')throw Error('Invalid statistics response.');
    for(const entry of batch) {
      const record=data.usages[entry.hash];
      if(record&&(!Number.isSafeInteger(record.downloads)||record.downloads<0||(record.lastDownloadAt!==null&&!Number.isFinite(Date.parse(record.lastDownloadAt)))))throw Error('Invalid statistics record.');
      records[entry.id]=record||{downloads:0,lastDownloadAt:null};
    }
  }
  return {usages:records,fetchedAt:new Date().toISOString()};
}
