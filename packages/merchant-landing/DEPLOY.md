# Deploying the checkout landing page

The landing page is a static page on `https://merchant.elisym.network`. It runs the checkout
loader from `https://pay.elisym.network` for its live demo, so it never shares an origin with
the store admin (`packages/merchant-admin`, `https://admin.elisym.network`).

## The Vercel project (once)

| Setting          | Value                                                     |
| ---------------- | --------------------------------------------------------- |
| Git repository   | `elisymlabs/elisym`, production branch `main`             |
| Root Directory   | `packages/merchant-landing`                               |
| Framework Preset | Other (install, build and output come from `vercel.json`) |
| Domain           | `merchant.elisym.network` (production)                    |

"Include files outside the Root Directory in the Build Step" stays on: install and build run
from the repository root. No environment variables.

## The live demo

`DEMO_PRODUCT` in `src/constants.ts` names the demo product. Without it the demo section shows
the snippet only. The product must sell on this origin: a store no domain vouches for
(level C), or one whose domain vouches for `merchant.elisym.network`. A mainnet product
charges real USDC.

## After each deploy

```bash
for path in / /index.html; do
  curl -sI "https://merchant.elisym.network$path" | grep -i '^content-security-policy'
done
```

Both lines must allow scripts from `'self'` and `https://pay.elisym.network` only, and frames from `https://pay.elisym.network` only.
