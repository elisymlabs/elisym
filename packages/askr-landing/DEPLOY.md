# Deploying the Askr landing page

The landing page is a static page on `https://askr.elisym.network`. It runs no widget and no
demo: the Askr server (`packages/askr-server`) serves `widget.js`, the chat sessions and the
admin on `https://api.askr.elisym.network`, so the landing never shares an origin with the admin
that holds the owner key.

## The Vercel project (once)

| Setting          | Value                                                     |
| ---------------- | --------------------------------------------------------- |
| Git repository   | `elisymlabs/elisym`, production branch `main`             |
| Root Directory   | `packages/askr-landing`                                   |
| Framework Preset | Other (install, build and output come from `vercel.json`) |
| Domain           | `askr.elisym.network` (production)                        |

"Include files outside the Root Directory in the Build Step" stays on: install and build run
from the repository root, and the build check reads `packages/merchant-admin/scripts`. No
environment variables.

## After each deploy

```bash
for path in / /index.html; do
  curl -sI "https://askr.elisym.network$path" | grep -i '^content-security-policy'
done
```

Both lines must allow scripts, styles, media and connections from `'self'` only, and no frames.
