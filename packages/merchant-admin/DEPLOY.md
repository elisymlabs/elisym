# Deploying the store admin

The hosted admin is a static page on its own origin, `https://admin.elisym.network`. The
merchant pastes the store key into it; the page reads the store's relays directly. It must
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
shared read code from `../merchant-node/src/admin`. No environment variables.

## Before merging a merchant-node release that names this URL

`elisym-merchant store-key` prints `https://admin.elisym.network` (`HOSTED_ADMIN_URL` in
`packages/merchant-node/src/constants.ts`), and merging a merchant-node version bump
publishes it to npm. Deploy this project to its domain first and run the check below.

## After each deploy

Every path must carry the admin CSP (`frame-ancestors 'none'`, `script-src 'self'`,
`connect-src wss:`):

```bash
for path in / /index.html /anything; do
  curl -sI "https://admin.elisym.network$path" | grep -i '^content-security-policy'
done
```

Three identical lines, or the deploy is wrong.
