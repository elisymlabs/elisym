# Deploying the store admin

The hosted admin is a static page on its own origin, `https://admin.elisym.network`. It has
one key field: whatever key is pasted signs a `GET /owner` to cloud-api
(`https://api.cloud.elisym.network`) while the page reads the key's store on the relays, and the
answers decide which part opens. A self-hosted merchant's store key opens the relay admin (cloud-api
has seen its public key, nothing more); a cloud merchant's owner key opens the cloud part, which
talks to cloud-api with requests that key signs. The key never leaves the page. It must
never share an origin with anything that runs third-party code (the landing page loads the
checkout loader), so it is its own Vercel project on its own host.

## The Vercel project (once)

| Setting          | Value                                                     |
| ---------------- | --------------------------------------------------------- |
| Git repository   | `elisymlabs/elisym`, production branch `main`             |
| Root Directory   | `packages/merchant-admin`                                 |
| Framework Preset | Other (install, build and output come from `vercel.json`) |
| Domain           | `admin.elisym.network` (production)                       |

"Include files outside the Root Directory in the Build Step" stays on: the build reads the
shared read code from `../merchant-node/src/admin`.

Environment variables (Production and Preview), read at build time:

| Variable                | Value                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `VITE_CLOUD_API_ORIGIN` | `https://api.cloud.elisym.network`; unset, the admin is for self-hosted stores only |
| `VITE_BILLING_URL`      | the Pay Core billing page for paying a cloud plan in stablecoins (optional)         |

Both are in turbo's `env` for this build, so a cached build is never served for another origin.

## Before merging a merchant-node release that names this URL

`elisym-merchant store-key` prints `https://admin.elisym.network` (`HOSTED_ADMIN_URL` in
`packages/merchant-node/src/constants.ts`), and merging a merchant-node version bump
publishes it to npm. Deploy this project to its domain first and run the check below.

## After each deploy

Every path must carry the admin CSP (`frame-ancestors 'none'`, `script-src 'self'`,
`connect-src wss: https://api.cloud.elisym.network`):

```bash
for path in / /index.html /anything; do
  curl -sI "https://admin.elisym.network$path" | grep -i '^content-security-policy'
done
```

Three identical lines, or the deploy is wrong.
