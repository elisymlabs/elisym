# Deploying the checkout

The checkout is two things served from one origin, `https://pay.elisym.network`:

- `/v1/embed.js` and `/v2/embed.js` - the loaders merchants include, each pinned by an SRI
  hash (`src/embed/v1.sri`, `src/embed/v2.sri`). v1 frames the checkout in place; v2 shows it
  in a modal behind a button by default (`display="inline"` frames it in place). Their bytes
  never change under their path; a changed loader ships as `/v3/embed.js`.
- `/checkout` - the iframe app the loaders frame.

The production bytes of both loaders are committed (`embed-prod/v1/embed.js`,
`embed-prod/v2/embed.js`), and a production build copies them as they are, so a toolchain
update can never change them. Other origins build the loaders from their frozen sources
(`src/embed/v1/`, `src/embed/v2/`), which are never edited: `embed-prod/frozen.sha256` lists
their hashes. `bun scripts/build-embeds.ts --from-source` rebuilds them for production to
compare with the committed bytes.

The build (`vite.config.ts`, `scripts/build-embeds.ts`, `scripts/check-size.ts`) refuses to
produce a deployment that breaks either one.

## The Vercel project (once)

| Setting          | Value                                                     |
| ---------------- | --------------------------------------------------------- |
| Git repository   | `elisymlabs/elisym`, production branch `main`             |
| Root Directory   | `packages/checkout`                                       |
| Framework Preset | Other (install, build and output come from `vercel.json`) |
| Domain           | `pay.elisym.network` (production)                         |

"Automatically expose System Environment Variables" stays on: the build reads `VERCEL_ENV`
and `VERCEL_URL`. "Include files outside the Root Directory in the Build Step" stays on too:
install and build run from the repository root (`cd ../..` in `vercel.json`).

## Environment variables

| Name                          | Environments        | Value                                                                    |
| ----------------------------- | ------------------- | ------------------------------------------------------------------------ |
| `VITE_SOLANA_RPC_URL_MAINNET` | Production          | The widget's own Helius mainnet URL (see below). Required in Production. |
| `VITE_SOLANA_RPC_URL_DEVNET`  | Production, Preview | Optional. Without it the public devnet endpoint is used.                 |
| `CHECKOUT_ORIGIN`             | none                | Leave unset. Only local demos set it.                                    |

`VITE_*` values are inlined into the public JavaScript bundle. The key in the RPC URL is
**not secret**: the only thing that protects it is the origin restriction set at Helius.

The build fails when:

- a Production build has no `VITE_SOLANA_RPC_URL_MAINNET`, or it is the public
  `api.mainnet-beta.solana.com` (it rejects browser requests and keeps no full history);
- any RPC URL is not `https:` (plain `http:` is accepted only for `localhost` / `127.0.0.1`);
- a Production build would frame any origin other than `https://pay.elisym.network`;
- the production-origin `v1/embed.js` or `v2/embed.js` differs from its `.sri`, or a committed
  `embed-prod/` file does;
- a frozen loader source differs from `embed-prod/frozen.sha256`;
- the size budgets or the loaders' global-scope check fail.

## The widget's RPC key

One full-history endpoint per network, used for both sending and finding payments:

1. Create a dedicated Helius API key for the widget. Do not share it with the app or any server.
2. Restrict it by origin to `https://pay.elisym.network`. A request with no `Origin` header
   then gets a 403, so servers and scripts need their own key.
3. Put `https://mainnet.helius-rpc.com/?api-key=<key>` in `VITE_SOLANA_RPC_URL_MAINNET`.
4. Previews run on `*.vercel.app`, which the origin restriction blocks, so the variable is
   set for Production only: a preview offers mainnet products as "network not available"
   and is tested on devnet.
5. The origin restriction is for this mainnet key only. If `VITE_SOLANA_RPC_URL_DEVNET` is
   set, its key must not be restricted to `https://pay.elisym.network`, or every preview's
   devnet purchase gets a 403. Leaving it unset uses the public devnet endpoint.

## Previews

A preview's loader frames that very deployment's checkout (`https://$VERCEL_URL`), never
production and never a newer deployment of the same branch. A preview build without
`VERCEL_URL` fails. Its `v1/embed.js` and `v2/embed.js` therefore differ from the pinned bytes,
and the SRI check is skipped. Those files are for testing only.

Vercel Deployment Protection must allow the preview to be framed by a test page on another
site. A cookie from opening the preview directly is not sent to a third-party frame when the
browser blocks third-party cookies, so either turn protection off for Preview while testing,
or use Protection Bypass for Automation and open the preview once with
`?x-vercel-protection-bypass=<secret>&x-vercel-set-bypass-cookie=samesitenone`.

### Preview checklist

- [ ] The build log prints `first screen`, `v1/embed.js` and `v2/embed.js` lines and no error.
- [ ] `/checkout` responds with the `Content-Security-Policy`, `Referrer-Policy: no-referrer`
      and `Cache-Control: no-cache` headers.
- [ ] `/v1/embed.js` and `/v2/embed.js` respond with `Access-Control-Allow-Origin: *` and the
      immutable `Cache-Control`.
- [ ] With the preview's `/v2/embed.js`, the button opens the checkout in a modal; the close
      button, Escape and a click outside it close it, and focus returns to the button.
- [ ] A test page with `<elisym-buy product="<devnet naddr>" network="devnet">` and the
      preview's `/v1/embed.js` shows the offer. The page receives `ready` and nothing else
      about the product.
- [ ] A devnet purchase from the test store (`packages/merchant-node`) goes
      `ready -> ordered -> paying -> paid -> completed` and shows the delivery.
- [ ] Reloading during `paying` resumes the same order, and no second wallet prompt appears.
- [ ] With site data blocked for the checkout's origin (the browser's "block all cookies and
      site data" setting, so IndexedDB fails), the checkout shows "This browser blocks
      storage for the checkout", the page receives `refused`, and there is no Pay button.

## Production release

1. Merge to `main`. Vercel builds Production with the variables above.
2. Check that the build log's `v1/embed.js` and `v2/embed.js` lines equal `src/embed/v1.sri`
   and `src/embed/v2.sri`, and that `https://pay.elisym.network/v2/embed.js` hashes to
   `src/embed/v2.sri` before any page or doc points at it.
3. Run the preview checklist against `https://pay.elisym.network`, with a mainnet product,
   before announcing it. Real money is involved, so a person does this step.
4. Merchants pin:

   ```html
   <script
     src="https://pay.elisym.network/v1/embed.js"
     integrity="<the value in src/embed/v1.sri>"
     crossorigin="anonymous"
   ></script>
   ```
