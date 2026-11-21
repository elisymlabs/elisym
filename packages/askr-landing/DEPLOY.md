# Deploying the Askr landing page

The landing page is a static page on `https://askr.elisym.network`. It runs no widget and no
demo: the Askr server (`packages/askr-server`) serves `widget.js`, the chat sessions and the
admin on `https://app.askr.elisym.network`, so the landing never shares an origin with the admin
that holds the store's secret key.

## The Vercel project (once)

| Setting          | Value                                                     |
| ---------------- | --------------------------------------------------------- |
| Git repository   | `elisymlabs/elisym`, production branch `main`             |
| Root Directory   | `packages/askr-landing`                                   |
| Framework Preset | Other (install, build and output come from `vercel.json`) |
| Domain           | `askr.elisym.network` (production)                        |

"Include files outside the Root Directory in the Build Step" stays on: install and build run
from the repository root (the workspace's lockfile and Turborepo live there). No
environment variables.

## After each deploy

```bash
for path in / /privacy /terms-of-service; do
  curl -sI "https://askr.elisym.network$path" | grep -i '^content-security-policy'
done
curl -sI https://askr.elisym.network/terms | grep -i '^location'   # /terms-of-service
```

All three lines must allow scripts, styles, media and connections from `'self'` only, and no frames.

## The legal pages

`/privacy` and `/terms-of-service` are their own HTML pages (`privacy.html`, `terms-of-service.html`,
served without `.html` by `cleanUrls`); the build writes their text into the HTML
(`scripts/prerender.tsx`), so they read in full without their script. The operator's tax number
and postal address are `LEGAL_NIF` and `LEGAL_ADDRESS` in `src/legal.ts`: empty strings are not
shown. When either page changes, change `LEGAL_LAST_UPDATED` there too.
