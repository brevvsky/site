# BREVVSKY Asset Studio

An English Roblox asset catalog, a computer-local owner panel, and private licensed downloads on Cloudflare Workers. The application has no npm dependencies. Model processing uses Python’s standard library.

## Run on your computer

Requirements: Node.js 22 or newer, Python 3.14 or newer, and a current browser. Python 3.14 adds support for Zstandard-compressed binary models; older Python versions can process XML and LZ4 models.

Double-click `START-STUDIO.cmd`, or run:

```powershell
cd D:\projects\brevvsky
npm start
```

Open the private admin URL printed in the terminal. This URL contains a temporary access token; do not share it. The panel binds to `127.0.0.1`, checks the Host and Origin headers, and uses an HttpOnly, SameSite session cookie. Its files are outside the public deployment directory. Public deployments return 404 for admin routes.

The storefront preview is `http://127.0.0.1:4317/`. Leave the terminal running while using the panel. Stop it with Ctrl+C. Restarting the panel generates a new admin access token.

## Add an asset

1. Add a permanent asset ID, title, description, category (`Vehicle` or `System`), and access type (`Free` or `Paid / license required`).
2. Upload the main `.rbxm` or `.rbxmx` model, up to 16 MiB. Upload up to six public PNG, JPG, or WebP previews, up to 5 MiB each.
3. For a paid asset, enter your contact URL and instructions describing how a buyer obtains a code. Prices are display text; payment collection and license delivery are manual.
4. Save the asset. The main file is encrypted locally. No real or fabricated products are included in the initial catalog.

If you replace the master, the application rebuilds existing personal copies with their original codes. Keep the previous source elsewhere until you have verified your replacement in Roblox Studio. Updates are local until synced/published.

## Issue and manage personal licenses

Choose a paid asset and enter the buyer’s Roblox username or reference. Leave the code field empty to generate a random 160-bit code. A custom personal access password must be at least 16 characters. You can edit a license, change its expiry or code, revoke it, or re-enable it. Codes are case-sensitive and specific to their asset. Copy the issued code and give it to that buyer.

The generator copies the master and sets a **string** attribute named `SpecialLicense` to the buyer’s exact code on **every supported BasePart and BaseScript descendant**. This includes MeshPart, VehicleSeat, Script, and LocalScript. ModuleScript inherits from LuaSourceContainer rather than BaseScript, so it is intentionally unaffected. Existing unrelated attributes and scripts remain semantically unchanged. XML serialization may change whitespace, CDATA syntax, and XML formatting; script text stays intact. Binary models retain unrelated chunks byte for byte; altered attribute chunks are written uncompressed, as supported by the Roblox format. Unsupported or malformed attribute types fail explicitly rather than stripping data.

The supported class list is in `local/stamp.py`; newly introduced Roblox classes may require extending it. The processor never executes uploaded scripts. A model with no eligible instances is rejected.

`SpecialLicense` is a traceability watermark. A buyer with edit access can remove or change it. This system does not enforce running-game DRM, bind downloads to a verified Roblox login, or stop someone sharing their code/file. Revocation blocks future downloads after a successful sync; it cannot recall a file already downloaded.

## Connect private GitHub storage

Create a **dedicated private** repository, for example `brevvsky/asset-vault`, initialized with a README on `main`. Do not enable Pages on it. In GitHub Settings → Developer settings → Fine-grained personal access tokens, create two tokens scoped only to this repository:

| Token | Repository permission | Stored/used by |
| --- | --- | --- |
| Sync token | Contents: read and write | Local Studio only |
| Delivery token | Contents: read | Cloudflare runtime secret |

Enter both tokens and the repository name in Local Studio. Tokens are encrypted on disk; neither is written to the public catalog or Git source. Do not paste tokens into chat. Sync refuses public repositories before uploading anything. It creates Git objects and advances the branch only when the complete snapshot is ready, so buyers never observe a partial update. Concurrent remote changes cause a rejected update rather than a forced overwrite.

Only `vault/*.enc` files are uploaded:

| File | Contents |
| --- | --- |
| `owner.enc` | Encrypted owner state: buyers, codes, private notes and master references |
| `<asset-id>.enc` | Encrypted download policy and SHA-256 code lookup for that asset |
| `<random-uuid>.enc` | Encrypted master or prepared personal copy |

AES-256-GCM uses an independent random nonce per encryption and binds each ciphertext to its file identity. The encryption key stays in `.private/vault.key` on your computer and in a Cloudflare secret. It is never uploaded to GitHub. The Worker has no endpoint for downloading a master or owner metadata. Free products explicitly allow downloading their original model.

## Publish to Cloudflare

The repository includes a ready-to-deploy Worker with static assets. The local application itself needs no installation step. Publishing needs internet access and Wrangler, downloaded from the official npm registry on first use.

1. Sign in to your Cloudflare account on its free Workers plan.
2. Authenticate Wrangler from this project directory:

   ```powershell
   npm install
   npm run cloudflare:login
   ```

3. In Local Studio save the private repository and both tokens. Add your assets and licenses.
4. Publish:

   ```powershell
   npm run publish
   ```

The command synchronizes the encrypted vault, fills in the private repository name in `wrangler.jsonc`, deploys the storefront, then installs `VAULT_KEY` and the read-only `GITHUB_TOKEN` as Cloudflare secrets through stdin. It never sends the local sync token to Cloudflare. On the first deployment, download requests return 503 until both secrets are configured. If any step fails, the script reports failure; resolve the error and rerun it. Wrangler prints the real `workers.dev` address. Worker names must be available in your Cloudflare account; change `name` in `wrangler.jsonc` if necessary.

On Windows PowerShell, use `npm.cmd` in place of `npm` if script execution is restricted. The `cloudflare:login`, `cloudflare:whoami`, and `deploy` scripts run the installed Wrangler entry point directly. Run `npm run cloudflare:whoami` to check which account is authenticated.

For new assets, new images, or catalog edits: save, then `npm run publish`. For issuing/editing/revoking licenses only: save, then **Sync private vault**; a storefront redeploy is unnecessary. Changes are not live until the sync succeeds. GitHub token expiry interrupts syncing or downloading until the corresponding token is replaced and secrets are republished.

The frontend and download API share an origin. Codes are sent only in POST request bodies and are never placed in download URLs, analytics, or logs. The Worker rate limiter targets ten download attempts per minute per IP per Cloudflare location; Cloudflare describes these limits as approximate. There is no analytics integration. Cloudflare observability is disabled in the provided configuration. A visitor receives model bytes directly, with no-store headers, never a GitHub token, encryption key, permanent download URL, or redirect to a repository file.

## Costs and limits

Cloudflare has a free Workers tier. Static requests are free; API requests, CPU, memory, GitHub API usage, and repository storage have limits. This is suitable for a small catalog, not an unlimited file CDN. The configured model limit is 16 MiB; actual delivery performance and memory/CPU usage must be verified with your real models on the target account. Keep billing on the free plan if you want requests to stop at the applicable free limits. Free availability and quotas are controlled by the providers.

GitHub Pages is static hosting and excludes sites primarily facilitating commercial transactions. This implementation therefore deploys the complete catalog and license delivery to Cloudflare, following the selected hosting choice.

Official references:

- https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/
- https://developers.cloudflare.com/workers/wrangler/commands/#secret
- https://dom.rojo.space/binary.html
- https://dom.rojo.space/attributes.html

## Backup and recover

Back up the entire `.private` directory to storage you control, especially `vault.key`. Treat this key as the master secret. Losing it makes the GitHub ciphertext unreadable. Anyone with it and the vault can decrypt all files. GitHub stores ciphertext history; revocation does not erase old encrypted revisions. `.private`, `.env*`, and `.dev.vars` are excluded from Git; never force-add them.

The current Local Studio edits its local snapshot. On a new computer, restore your backed-up `.private` directory and the same public catalog/uploads before using the panel. It does not automatically pull and reconcile remote vault changes. Use one writer computer at a time. A restored stale snapshot could reinstate old license settings on the next sync.

## License download counts

Local Studio displays **Downloads** and **Last download** on each license card. Counts load when the license list opens and can be updated with **Refresh download counts**. If retrieval fails, the panel shows an error and leaves unknown counts unavailable instead of claiming zero. Set **Published website URL** in the panel settings if your production URL differs from the provided workers.dev address.

Deploy the update with `npm.cmd run deploy`, then restart Local Studio (`Ctrl+C`, followed by `npm.cmd start`) and open its new private launch URL. Wrangler provisions the `LicenseUsageStore` SQLite Durable Object from the supplied binding and migration; no separate database or new secret is needed. Keep that binding, class name, and migration stable on later deployments so counters remain accessible. SQLite Durable Objects are supported on Cloudflare's free Workers plan, subject to the provider's usage limits.

Only a successfully authorized, decrypted, server-issued **paid** asset download increments its key's count. Invalid/revoked/expired keys, storage failures, free assets, local preview downloads, and signed owner diagnostic probes do not count. The counter is committed before the successful response is released; if the counter cannot be recorded, the download returns a service error. A count indicates that the server issued a copy; it cannot prove that the browser finished saving it or that a model was used in Roblox. Historical downloads from before this update are unavailable.

Counts are per product and exact key. Editing buyer notes or an expiry preserves the count; replacing the actual key starts a new key's count. Counts persist outside the local panel and survive storefront deployments. Cloudflare stores only a one-way license digest, a count, and the last delivery timestamp: no raw license codes, buyer names, IPs, or model contents. The owner stats endpoint requires a short-lived request signature derived from the private vault key. Signing happens in the local Node process; the browser never receives the vault key. There is no public endpoint for changing the counters or viewing them without owner authentication.

Tests include concurrent real SQLite counter updates inside workerd, successful/failed delivery accounting, signed diagnostic exclusion, private owner access, and the local panel's authenticated statistics route.

## Validation

If a licensed download returns a temporary-unavailability error, run:

```powershell
npm.cmd run diagnose
```

The owner-only command checks the saved read-only GitHub token, remote license synchronization, encryption integrity of the assigned file, and the deployed download endpoint. It prints safe OK/FAIL results and HTTP statuses. It never prints license codes, tokens, encryption keys, or model contents. It runs on your computer and requires network access to GitHub and the public Worker. For another deployment URL, run `npm.cmd run diagnose -- https://your-worker.your-account.workers.dev`.

The Worker also returns a safe failure reference, such as `INDEX_READ_401` (the deployed GitHub token was rejected), `INDEX_DECRYPT` (the deployed Worker cannot decrypt the license index), or `FILE_READ_404` (the assigned file could not be read). The storefront displays this reference beside the error, and owner diagnostics explain it. Deploy the updated Worker with `npm.cmd run publish` before using these references to diagnose a live site. If diagnostics say the Worker predates detailed diagnostics, the public deployment is still running the older version.

GitHub requests use `redirect: 'manual'` and reject 3xx responses explicitly. Workers do not support the Fetch API's `redirect: 'error'` mode; using it throws before contacting GitHub. Runtime regression coverage is available with `npm.cmd run test:worker`. It executes the encrypted delivery flow using real workerd Request, Response, and Web Crypto APIs, with fake storage and test-only credentials, without outbound network requests.

```powershell
npm test
npm run check
```

The suite checks authenticated encryption, two binary compression variants, XML script/attribute preservation, per-buyer stamping, successful and rejected delivery, license expiry/revocation, free assets, local authentication, CSRF and private/public separation. HTTP route integration uses stream requests without network sockets because this execution environment blocks local client connections. Real Roblox Studio imports and a live Cloudflare/GitHub round trip still need validation with your own model and authenticated accounts. Browser QA was blocked by a localhost connection timeout in the execution environment.
