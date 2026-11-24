# Deploying the store admin

The hosted admin is a static page on its own origin, `https://admin.elisym.network`. The
merchant pastes the store key into it; the page reads the store's relays directly. It must
never share an origin with anything that runs third-party code (the landing page loads the
checkout loader), so it is its own Vercel project on its own host.

It serves two pages from one build:

- `/` - self-host mode: the merchant pastes the **store** key; the page reads the store's relays
  directly (`connect-src wss:`).
- `/hosted/` - hosted mode: the merchant signs in with the **owner** key and the page talks to
  PayCore's server only (`connect-src` = the API's origin, nothing else). The owner key never
  reaches the server: every call carries a NIP-98 signature made in the page.

## The Vercel project (once)

| Setting          | Value                                                     |
| ---------------- | --------------------------------------------------------- |
| Git repository   | `elisymlabs/elisym`, production branch `main`             |
| Root Directory   | `packages/merchant-admin`                                 |
| Framework Preset | Other (install, build and output come from `vercel.json`) |
| Domain           | `admin.elisym.network` (production)                       |

"Include files outside the Root Directory in the Build Step" stays on: the build reads the
shared read code from `../merchant-node/src/admin`. No environment variables.

## Before merging a merchant-node release that names this URL

`elisym-merchant store-key` prints `https://admin.elisym.network` (`HOSTED_ADMIN_URL` in
`packages/merchant-node/src/constants.ts`), and merging a merchant-node version bump
publishes it to npm. Deploy this project to its domain first and run the check below.

## After each deploy

Every self-host path must carry the self-host CSP (`frame-ancestors 'none'`, `script-src 'self'`,
`connect-src wss:`), every `/hosted/` path the hosted one (the same, but `connect-src` = the API
origin, or `'none'` while hosted mode is off):

```bash
for path in / /index.html /anything /hosted/ /hosted/index.html /hosted/anything; do
  echo "$path"
  curl -sI "https://admin.elisym.network$path" | grep -i '^content-security-policy\|^cache-control\|^x-content-type-options\|^cross-origin-opener-policy\|^permissions-policy\|^referrer-policy'
done
curl -sI https://admin.elisym.network/hosted | grep -i '^HTTP\|^location'
```

For each path: exactly one `content-security-policy` line (two lines would mean two enforced
policies: a third `vercel.json` source matched), `cache-control: no-store`,
`x-content-type-options: nosniff`, `cross-origin-opener-policy: same-origin`, the
`permissions-policy` and `referrer-policy: no-referrer`. The first three paths show
`connect-src wss:`, the last three `connect-src 'none'` (hosted mode off) or
`connect-src https://<api host>` (on), never `wss:`. `/hosted` answers a redirect to `/hosted/`.
`/assets/*` files are `public, max-age=31536000, immutable`.

## Hosted mode

### Turning it on

Hosted mode stays off ("not available yet" on `/hosted/`, CSP `connect-src 'none'`) until the
PayCore server's domain is chosen. To turn it on, make **one change** with both edits, then
merge:

1. `src/hosted/config.ts`: set `PAYCORE_API_BASE` to the server's `PAYCORE_PUBLIC_BASE`, written
   exactly (https, no trailing slash, no query) - NIP-98 signatures are made over it and the
   server compares it with its own - and `PAYCORE_OPERATOR` to the server's `PAYCORE_OPERATOR`
   (the lowercase DNS name its authorizations name). These are committed, not environment
   variables: every build (local `bun qa`, CI, Vercel) sees the same values.
2. `vercel.json`: in the `/hosted/(.*)` CSP, replace `connect-src 'none'` with
   `connect-src <the API origin>` (scheme and host of `PAYCORE_API_BASE`, port only if not 443,
   no path).

`scripts/check-build.ts` (run by `bun run build`, so by `bun qa`, CI and Vercel) fails the build
if the two disagree: the hosted `connect-src` must be exactly the API origin when the config is
set, and `'none'` when it is empty; an invalid base or operator fails too.

On the server side, `PAYCORE_ADMIN_ORIGIN=https://admin.elisym.network` must be set (see
`packages/paycore-server/DEPLOY.md`), or the browser blocks every call (no CORS answer). The page
also reads `/v1/meta` first and refuses to run when its `publicBase` or `operator` differs from
the committed values ("this admin points at another server").

### Manual devnet checklist (before calling hosted mode done)

Against a devnet PayCore server with `PAYCORE_ADMIN_ORIGIN` set to this deploy's origin, in a
desktop browser with Phantom and MetaMask installed (injected wallets: the page's COOP
`same-origin` blocks popup-only wallets):

- [ ] The header check above passes for `/` and `/hosted/`; `/hosted/` shows the sign-in (not
      "not available yet").
- [ ] New owner key: shown once, downloaded, "I saved it" gate; sign out zeroes it; a remembered
      key unlocks after a reload.
- [ ] Create a store (devnet); the store is `pending` ("waiting for activation").
- [ ] Payouts: a Solana USDC row signed with **Phantom** (`signMessage`) is accepted by the save
      (a wrong Phantom account is refused before saving).
- [ ] Payouts: an EVM USDC row (Base Sepolia, or Tempo) signed with **MetaMask**
      (`personal_sign`) is accepted, saved with the address in lowercase; the EVM paste fallback
      also works with a signature made elsewhere.
- [ ] "Publish payout list" (10133) and "Authorize PayCore" (30490): the confirm step lists every
      address in full, the owner key signs, the commit answers "goes live on activation".
- [ ] The operator runs `store activate <owner npub> --tier <tier>`; after the setup pass the
      Overview checklist shows both owner events published.
- [ ] Products: create, edit, delete; a CSV import.
- [ ] A devnet order from the checkout shows in Orders (current title, email, state); the CSV
      export opens in a spreadsheet; a paid order shows its explorer link and fee.
- [ ] Settings: a webhook URL saved without a secret shows "generate a secret" (the store is
      `degraded` with `webhook_secret_missing`); the generated secret is shown once and a test
      webhook verifies with it.
- [ ] No request from `/hosted/` goes anywhere but the API origin (browser devtools, Network).
