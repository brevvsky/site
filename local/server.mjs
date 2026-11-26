import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve, sep } from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { root, privateRoot, initialize, readState, writeState, readCatalog, writeCatalog, atomic, generateCode, storeFile, getFile, stampModel, modelExtension, MAX_MODEL } from './vault.mjs';
import { readSettings, writeSettings, syncVault } from './github.mjs';
import { pathToFileURL } from 'node:url';
const key=await initialize(), port=Number(process.env.PORT||4317);
const origin=`http://127.0.0.1:${port}`, launchToken=randomBytes(32).toString('hex'), session=randomBytes(32).toString('hex');
const security={'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"};
const send=(res,status,body,headers={})=>{res.writeHead(status,{...security,'Content-Type':'application/json',...headers});res.end(typeof body==='string'||body instanceof Uint8Array?body:JSON.stringify(body));};
const safeEqual=(a,b)=>typeof a==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
async function body(req,max=64*1024*1024){const chunks=[];let length=0;for await(const c of req){length+=c.length;if(length>max)throw Error('Upload is too large. Maximum model size is 16 MiB and maximum image size is 5 MiB.');chunks.push(c);}return JSON.parse(Buffer.concat(chunks).toString());}
function text(value,max=4000){if(typeof value!=='string'||value.length>max)throw Error('Invalid text field.');return value.trim();}
function contact(value){if(!value)return '';let url;try{url=new URL(value);}catch{throw Error('Enter a full HTTPS contact URL.');}if(url.protocol!=='https:')throw Error('Contact URL must use HTTPS.');return url.href;}
function expiration(value){if(!value)return null;const time=Date.parse(value);if(!Number.isFinite(time))throw Error('Invalid expiry date.');return new Date(time).toISOString();}
const validId=id=>/^[a-z0-9][a-z0-9-]{0,63}$/.test(id||'');
let mutation=Promise.resolve();
function serialize(action){const next=mutation.then(action);mutation=next.catch(()=>{});return next;}
async function admin(req,res,path) {
  if(req.method==='POST'&&path==='/local/session') {
    const data=await body(req,1024);
    if(!safeEqual(data.token,launchToken))return send(res,403,{error:'Use the private launch URL printed in your terminal.'});
    return send(res,200,{ok:true},{'Set-Cookie':`brv_admin=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`});
  }
  const cookie=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('brv_admin='))?.slice(10);
  if(!safeEqual(cookie,session))return send(res,401,{error:'Open the private admin link from your terminal.'});
  if(req.method==='GET'&&path==='/local/state') {
    const state=await readState(key),catalog=await readCatalog(),settings=await readSettings(key);
    return send(res,200,{catalog,licenses:state.licenses,settings:{repository:settings.repository||'',branch:settings.branch||'main',hasToken:!!settings.token,hasDeliveryToken:!!settings.deliveryToken},hasProducts:Object.keys(state.products)});
  }
  if(req.method!=='POST')return send(res,405,{error:'Method not allowed.'});
  const data=await body(req);
  const state=await readState(key),catalog=await readCatalog();
  if(path==='/local/product') {
    const id=text(data.id,64);if(!validId(id)||id==='owner')throw Error('Asset ID must contain lowercase letters, numbers, and hyphens. The ID owner is reserved.');
    const existing=catalog.products.find(p=>p.id===id);
    if(!['Vehicle','System'].includes(data.category)||!['free','paid'].includes(data.access))throw Error('Choose a category and access type.');
    const title=text(data.title,120);if(!title)throw Error('Title is required.');
    const product={id,title,description:text(data.description,8000),instructions:text(data.instructions||'',4000),category:data.category,access:data.access,price:text(data.price||'',80),contactUrl:contact(data.contactUrl||''),images:existing?.images||[],updatedAt:new Date().toISOString()};
    let master=state.products[id]?.master,extension=state.products[id]?.extension,freeFile=state.products[id]?.freeFile;
    if(data.model) {
      extension=modelExtension(data.model.name);
      const bytes=Buffer.from(data.model.data,'base64');if(!bytes.length||bytes.length>MAX_MODEL)throw Error('The model must be between 1 byte and 16 MiB.');
      // Validate actual structure and every existing attribute before accepting a master.
      await stampModel(bytes,'BRV-VALIDATION',extension);
      master=await storeFile(bytes,key);freeFile=data.access==='free'?master:null;
    }
    if(!master)throw Error('Upload a main model file.');
    if(data.access==='free')freeFile=master;
    else freeFile=null;
    if(data.images?.length) {
      if(data.images.length>6)throw Error('Upload up to 6 previews.');
      product.images=[];
      for(const image of data.images) {
        const bytes=Buffer.from(image.data,'base64');if(bytes.length>5*1024*1024)throw Error('Each preview must be 5 MiB or smaller.');
        let ext;
        if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))ext='.png';
        else if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)ext='.jpg';
        else if(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')ext='.webp';
        else throw Error('Previews must be PNG, JPG, or WebP images.');
        const name=randomUUID()+ext;await atomic(join(root,'public/uploads',name),bytes);product.images.push(`./uploads/${name}`);
      }
    }
    state.products[id]={master,extension,access:data.access,freeFile};
    // Rebuild existing personal copies when the source changes; codes remain stable.
    if(data.model)for(const license of state.licenses.filter(l=>l.productId===id)) {
      const stamped=await stampModel(await getFile(master,key),license.code,extension);
      license.file=await storeFile(stamped.bytes,key);license.parts=stamped.changed;
    }
    catalog.products=existing?catalog.products.map(p=>p.id===id?product:p):[product,...catalog.products];
    await writeState(state,key);await writeCatalog(catalog);
    return send(res,200,{message:'Asset saved locally. Sync the vault, then publish the storefront to make it live.'});
  }
  if(path==='/local/license') {
    const source=state.products[data.productId];if(!source)throw Error('Choose an asset.');
    if(source.access!=='paid')throw Error('Free assets do not require a license.');
    const code=data.code?text(data.code,128):generateCode();
    if(code.length<16)throw Error('Access codes must contain at least 16 characters. Use Generate for a strong personal key.');
    if(state.licenses.some(l=>l.productId===data.productId&&l.code===code&&l.id!==data.id))throw Error('This code is already assigned to this asset.');
    const old=data.id?state.licenses.find(l=>l.id===data.id):null;if(data.id&&!old)throw Error('License not found.');
    if(old&&old.productId!==data.productId)throw Error('A license cannot be moved to another asset.');
    const stamped=await stampModel(await getFile(source.master,key),code,source.extension);
    const license={id:old?.id||randomUUID(),productId:data.productId,buyer:text(data.buyer,200),notes:text(data.notes||'',2000),code,active:data.active!==false,expiresAt:expiration(data.expiresAt),file:await storeFile(stamped.bytes,key),parts:stamped.changed,createdAt:old?.createdAt||new Date().toISOString()};
    if(!license.buyer)throw Error('Buyer name or Roblox username is required.');
    state.licenses=old?state.licenses.map(l=>l.id===old.id?license:l):[license,...state.licenses];
    await writeState(state,key);return send(res,200,{message:`Personal copy prepared: ${stamped.changed} parts and scripts stamped. Sync the vault to activate changes online.`,license});
  }
  if(path==='/local/revoke') {
    const license=state.licenses.find(l=>l.id===data.id);if(!license)throw Error('License not found.');
    license.active=data.active===true;await writeState(state,key);
    return send(res,200,{message:`License ${license.active?'enabled':'revoked'} locally. Sync the vault to apply online.`});
  }
  if(path==='/local/settings') {
    if(!/^[\w.-]+\/[\w.-]+$/.test(data.repository||''))throw Error('Use owner/repository format.');
    if(!/^[\w./-]+$/.test(data.branch||'main'))throw Error('Invalid branch.');
    const old=await readSettings(key),token=data.token||old.token;
    if(!token)throw Error('A fine-grained GitHub token is required.');
    await writeSettings({repository:data.repository,branch:data.branch||'main',token,deliveryToken:data.deliveryToken||old.deliveryToken||''},key);
    return send(res,200,{message:'Settings encrypted and saved on this computer.'});
  }
  if(path==='/local/sync')return send(res,200,await syncVault(await readSettings(key)));
  if(path==='/local/contact') {
    catalog.contactUrl=contact(data.contactUrl||'');await writeCatalog(catalog);return send(res,200,{message:'Contact URL saved.'});
  }
  return send(res,404,{error:'Not found.'});
}
async function localDownload(req,res) {
  const data=await body(req,1024), state=await readState(key);
  if(!validId(data.productId))return send(res,400,{error:'Invalid asset.'});
  const product=state.products[data.productId];if(!product)return send(res,404,{error:'Asset not found.'});
  let file=product.freeFile;
  if(product.access!=='free') {
    const license=state.licenses.find(l=>l.productId===data.productId&&l.code===String(data.code||'').trim());
    if(!license||!license.active||(license.expiresAt&&Date.parse(license.expiresAt)<=Date.now()))return send(res,403,{error:'License is invalid, expired, or revoked.'});
    file=license.file;
  }
  send(res,200,await getFile(file,key),{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename="${data.productId}${product.extension}"`});
}
const types={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp'};
export const handler=async(req,res)=>{
  try {
    if(req.headers.host!==`127.0.0.1:${port}`)return send(res,403,{error:'Invalid host.'});
    if(req.headers.origin&&req.headers.origin!==origin)return send(res,403,{error:'Invalid origin.'});
    if(req.method!=='GET'&&req.method!=='HEAD'&&req.headers['sec-fetch-site']==='cross-site')return send(res,403,{error:'Cross-site request denied.'});
    const path=new URL(req.url,origin).pathname;
    if(path.startsWith('/local/'))return await serialize(()=>admin(req,res,path));
    if(path==='/api/download'&&req.method==='POST')return await serialize(()=>localDownload(req,res));
    if(req.method!=='GET'&&req.method!=='HEAD')return send(res,405,{error:'Method not allowed.'});
    let folder=join(root,'public'),relative=path==='/'?'index.html':decodeURIComponent(path).slice(1);
    if(path==='/admin'||path==='/admin/') {folder=join(root,'local/ui');relative='index.html';}
    if(path.startsWith('/admin/')&&path!=='/admin/') {folder=join(root,'local/ui');relative=path.slice(7);}
    const file=resolve(folder,relative);
    if(!file.startsWith(resolve(folder)+sep))return send(res,404,{error:'Not found.'});
    if(!(await stat(file)).isFile())return send(res,404,{error:'Not found.'});
    return send(res,200,req.method==='HEAD'?'':await readFile(file),{'Content-Type':types[extname(file)]||'application/octet-stream'});
  } catch(error){if(res.headersSent){res.end();return;}send(res,error.code==='ENOENT'?404:400,{error:error.code==='ENOENT'?'Not found.':error.message});}
};
export {launchToken};
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const server=http.createServer(handler);
  server.listen(port,'127.0.0.1',()=>{console.log(`Storefront: ${origin}\nPrivate admin (keep this link private): ${origin}/admin/#${launchToken}\nThe admin is available only on this computer. Press Ctrl+C to stop.`);});
  server.on('error',error=>{console.error(error.message);process.exitCode=1;});
}
