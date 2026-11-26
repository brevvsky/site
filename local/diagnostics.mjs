import { decrypt, decode, hashCode } from '../shared/crypto.mjs';
import { githubRead } from '../worker/index.mjs';

export function storageHint(status) {
  if (status === 401) return 'Delivery token is invalid or expired. Replace it in Local Studio and run npm run publish.';
  if (status === 403) return 'GitHub denied access. Check Contents: read permission for asset-vault, token approval, and API rate limits.';
  if (status === 404) return 'GitHub cannot find or access the private file. Check the selected repository, branch, token repository access, and vault sync.';
  if (status === 429) return 'GitHub is rate limiting requests. Try again later.';
  return 'Private storage could not be reached. Check the network and GitHub service status.';
}

export function workerHint(code) {
  if(code==='CONFIG_SECRETS')return 'Cloudflare is missing its delivery secrets. Run npm run publish.';
  if(code==='CONFIG_REPOSITORY')return 'Cloudflare has an invalid private repository setting. Run npm run publish.';
  if(code==='CONFIG_LIMITER')return 'The Cloudflare rate limiter binding is missing. Run npm run publish.';
  if(code==='INDEX_DECRYPT')return 'Cloudflare cannot decrypt the index. Its vault key may differ from this computer. Run npm run publish to reinstall the current key.';
  if(code==='FILE_DECRYPT')return 'Cloudflare cannot decrypt the personal file. Republish the current secrets and sync the vault.';
  const match=/^(INDEX|FILE)_READ_(401|403|404|429)$/.exec(code);
  if(match)return `Cloudflare private storage: ${storageHint(Number(match[2]))}`;
  if(/^(INDEX|FILE)_READ_NETWORK$/.test(code))return 'The Cloudflare Worker failed while fetching private storage. The local GitHub checks passed; inspect the Worker fetch configuration.';
  if(code==='INDEX_METADATA')return 'The remote license index has invalid metadata.';
  return 'The Worker returned a delivery error. Share this safe reference with the creator.';
}

export async function diagnoseDelivery({key, settings, state, siteUrl, fetcher = fetch, report = console.log}) {
  const result = (check, ok, details) => report(`${ok ? 'OK' : 'FAIL'} ${check}: ${details}`);
  if (!settings.repository || !settings.deliveryToken) {
    result('configuration', false, 'Save the private repository and read-only delivery token in Local Studio.');
    return false;
  }
  result('configuration', true, 'Private repository and delivery token are saved.');
  const license = state.licenses.find(l => l.active && (!l.expiresAt || Date.parse(l.expiresAt) > Date.now()));
  const productId = license?.productId || Object.keys(state.products)[0];
  if (!productId) {
    result('asset', false, 'Add an asset first.');
    return false;
  }
  const env = {VAULT_KEY:key, GITHUB_TOKEN:settings.deliveryToken, GITHUB_REPOSITORY:settings.repository, GITHUB_BRANCH:settings.branch || 'main'};
  const timedFetch = (url, options) => fetcher(url, {...options, signal:AbortSignal.timeout(20000)});
  let indexText;
  try {
    indexText = await githubRead(`${productId}.enc`, env, timedFetch);
    result('GitHub read-only token', true, 'Private license index is accessible.');
  } catch (error) {
    const hint = error.status ? `HTTP ${error.status}. ${storageHint(error.status)}` : 'Network request failed. Check DNS, internet access, and access to api.github.com.';
    result('GitHub read-only token', false, hint);
    return false;
  }
  let index;
  try {
    index = JSON.parse(decode(await decrypt(indexText, key, `index:${productId}`)));
    result('license index encryption', true, 'The remote index matches the local vault key.');
  } catch {
    result('license index encryption', false, 'The remote index cannot be decrypted with the local vault key. Restore the correct key or sync the correct local vault.');
    return false;
  }
  const entry = license ? index.licenses?.[await hashCode(productId, license.code)] : null;
  const file = index.access === 'free' ? index.freeFile : entry?.file;
  if (index.access !== 'free' && (!entry?.active || (entry.expiresAt && Date.parse(entry.expiresAt) <= Date.now()))) {
    result('license sync', false, 'The local active license is missing, expired, or revoked in GitHub. Click Sync private vault.');
    return false;
  }
  result('license sync', true, 'The remote download policy allows this copy.');
  try {
    if (!/^[a-f0-9-]{36}$/.test(file || '')) throw Error('Invalid reference.');
    const content = await githubRead(`${file}.enc`, env, timedFetch);
    const bytes = await decrypt(content, key, `file:${file}`);
    result('personal file', true, `The remote model decrypts correctly (${bytes.length} bytes).`);
  } catch (error) {
    result('personal file', false, error.status ? `HTTP ${error.status}. ${storageHint(error.status)}` : 'The assigned file is missing, unreadable, or encrypted with another key. Sync the private vault.');
    return false;
  }
  if (!siteUrl) return true;
  try {
    const endpoint = new URL('/api/download', siteUrl);
    if (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith('.workers.dev')) throw Error('Invalid diagnostic destination.');
    const response = await timedFetch(endpoint.href, {method:'POST', redirect:'error', cache:'no-store', headers:{'Content-Type':'application/json','User-Agent':'brevvsky-owner-diagnostics'}, body:JSON.stringify({productId, code:index.access === 'free' ? '' : license.code})});
    if (!response.ok) {
      const body=await response.json().catch(()=>({}));
      const safeCode=/^(CONFIG_(SECRETS|REPOSITORY|LIMITER)|INDEX_(READ_(401|403|404|429|NETWORK)|DECRYPT|METADATA)|FILE_(READ_(401|403|404|429|NETWORK)|DECRYPT)|DOWNLOAD_RESPONSE)$/.test(body?.code || '')?body.code:null;
      const hint=safeCode?`[${safeCode}] ${workerHint(safeCode)}`:response.status===429?'Download attempts are rate limited; wait a minute.':response.headers.get('X-Asset-Delivery-Version')?'The Worker returned an error without a delivery reference.':'The deployed Worker predates detailed diagnostics. Run npm run publish to deploy the updated Worker and secrets, then diagnose again.';
      result('Cloudflare download', false, `HTTP ${response.status}. ${hint}`);
      return false;
    }
    // Discard successful model bytes; never print the model or credentials.
    await response.body?.cancel();
    result('Cloudflare download', true, 'The deployed site accepted the license and returned a downloadable file.');
    return true;
  } catch {
    result('Cloudflare download', false, 'The deployed site could not be reached. Check the public URL, internet access, and TLS.');
    return false;
  }
}
