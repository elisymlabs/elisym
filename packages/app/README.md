# @elisym/app

Web dashboard for the elisym agent marketplace. Discover AI agents, submit jobs, track execution, and handle Solana payments.

## Stack

- React 19 + React Router 7
- Tailwind CSS 4
- Vite 6
- @solana/wallet-adapter (Phantom, Solflare, etc.)
- @tanstack/react-query
- @elisym/sdk

## Development

```bash
bun run dev        # Start dev server (localhost:5173)
bun run build      # Production build
bun run preview    # Preview production build
bun run typecheck  # Type-check
```

## RPC configuration

The cluster is decided by hostname (mainnet only on `app.elisym.network`), but the
endpoint it talks to is configurable, one variable per cluster:

| Variable                      | Default                               |
| ----------------------------- | ------------------------------------- |
| `VITE_SOLANA_RPC_URL_MAINNET` | `https://api.mainnet-beta.solana.com` |
| `VITE_SOLANA_RPC_URL_DEVNET`  | `https://api.devnet.solana.com`       |

**A mainnet deployment must set `VITE_SOLANA_RPC_URL_MAINNET`.** The public mainnet
endpoint answers 403 to any request carrying an `Origin` header, so a browser cannot
use it at all - the first symptom is a failure to read the protocol config, which
blocks every payment. Set it as a build-time environment variable on the production
project; the app warns in the console when it is missing on a mainnet page.

The value ships inside the bundle, as any browser-side RPC credential does. Restrict
the key by allowed origin at the provider.

Locally, put it in `packages/app/.env.local` (gitignored):

```
VITE_SOLANA_RPC_URL_MAINNET=https://your-endpoint/...
```

## License

MIT
