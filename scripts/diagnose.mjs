import { initialize, readState } from '../local/vault.mjs';
import { readSettings } from '../local/github.mjs';
import { diagnoseDelivery } from '../local/diagnostics.mjs';

// The known public deployment. An optional HTTPS workers.dev URL can override it.
const siteUrl = process.argv[2] || 'https://brevvsky-assets.brevvsky.workers.dev';
try {
  const key = await initialize();
  const ok = await diagnoseDelivery({key,settings:await readSettings(key),state:await readState(key),siteUrl});
  process.exitCode = ok ? 0 : 1;
} catch {
  console.error('FAIL local vault: Cannot read the encrypted settings or owner records. Check your local vault backup.');
  process.exitCode = 1;
}
