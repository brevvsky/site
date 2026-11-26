import { deliver } from '../worker/index.mjs';
import { encrypt, utf8, base64, hashCode } from '../shared/crypto.mjs';

// Runs inside workerd, not Node. No network access or real credentials are used.
export default {
  async test() {
    let unsupported = false;
    try { new Request('https://api.github.com/', {redirect:'error'}); }
    catch { unsupported = true; }
    if (!unsupported) throw Error('Expected the Workers redirect restriction.');

    const key = base64(crypto.getRandomValues(new Uint8Array(32)));
    const productId = 'runtime-test', code = 'BRV-RUNTIME-TEST-ONLY';
    const file = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const index = {access:'paid',extension:'.rbxm',licenses:{[await hashCode(productId,code)]:{active:true,file}}};
    const documents = new Map([
      [`${productId}.enc`, await encrypt(utf8(JSON.stringify(index)),key,`index:${productId}`)],
      [`${file}.enc`, await encrypt(utf8('runtime model'),key,`file:${file}`)]
    ]);
    let calls = 0;
    const fetcher = async (url, init) => {
      // This real Workers constructor rejected the original redirect:error option.
      const req = new Request(url,init);
      if (req.redirect !== 'manual') throw Error('Storage request must not follow redirects.');
      calls++;
      return new Response(documents.get(new URL(req.url).pathname.split('/').pop()));
    };
    const request = new Request('https://runtime.test/api/download', {
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({productId,code})
    });
    const env = {VAULT_KEY:key,GITHUB_TOKEN:'test-only-token',GITHUB_REPOSITORY:'example/private',DOWNLOAD_LIMITER:{limit:async()=>({success:true})}};
    const response = await deliver(request,env,fetcher);
    if (response.status!==200) throw Error(`Runtime delivery failed: ${await response.text()}`);
    if (await response.text()!=='runtime model' || calls!==2) throw Error('Runtime delivery content mismatch.');
  }
};
