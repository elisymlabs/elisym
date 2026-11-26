# Deploying the checkout

The checkout is two things served from one origin, `https://pay.elisym.network`:

- `/v1/embed.js` to `/v4/embed.js` - the loaders merchants include, each pinned by an SRI
  hash (`src/embed/v1.sri` to `src/embed/v4.sri`). v1 frames the checkout in place; v2 shows
  it in a modal behind a button by default (`display="inline"` frames it in place); v3 is v2
  plus `customer-ref`, the account a payment credits; v4 is v3 plus one global, `PayCore`,
  whose `PayCore.open({ product, ... })` opens the checkout in a modal from code. Their bytes
  never change under their path once released; a changed loader ships as `/v5/embed.js`.
- `/checkout` - the iframe app the loaders frame.

The production bytes of the loaders are committed (`embed-prod/v1/embed.js` to
`embed-prod/v4/embed.js`), and a production build copies them as they are, so a toolchain
update can never change them. Other origins build the loaders from their frozen sources
(`src/embed/v1/` to `src/embed/v4/`), which are never edited once released:
`embed-prod/frozen.sha256` lists their hashes. `bun scripts/build-embeds.ts --from-source`
rebuilds them for production to compare with the committed bytes.

### Freezing a loader (`scripts/freeze.ts`)

`bun scripts/freeze.ts --loader v4` builds `src/embed/v4/` for `https://pay.elisym.network`
and writes `embed-prod/v4/embed.js`, `src/embed/v4.sri`, v4's pin line in
`tests/loader-pins.test.ts` and the manifest. It refuses:

- a loader listed in `RELEASED_LOADERS` (`scripts/frozen.ts`; v1 to v3);
- any loader when `git fetch origin main` fails, `origin/main` does not resolve, or
  `origin/main` already holds `src/embed/vN.sri` (fail closed: merchants pin those bytes);
- sources not formatted (`bunx oxfmt src/embed/vN` first, so a format pass never changes the
  bytes).

The re-freeze rule: while v4 is unreleased (under review on its branch), **every commit
that changes `src/embed/v4/` re-runs `bun scripts/freeze.ts --loader v4`** (after
`bunx oxfmt` on the sources), so the build's pin checks stay green. Plain `bun
scripts/freeze.ts` rewrites only the manifest. The commit that merges v4 to `main` is its
final freeze: it adds `v4` to `RELEASED_LOADERS` (and to the pin test's list) and the
`src/embed/v4/` ignores in `.oxfmtrc.json`, `.oxlintrc.json` and `cspell.json`; from then on
v4 is never frozen again.

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

| Name                                                                                                      | Environments        | Value                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `VITE_SOLANA_RPC_URL_MAINNET`                                                                             | Production          | The widget's own Helius mainnet URL (see below). Required in Production.                                                                  |
| `VITE_SOLANA_RPC_URL_DEVNET`                                                                              | Production, Preview | Optional. Without it the public devnet endpoint is used.                                                                                  |
| `VITE_EVM_RPC_URL_ETHEREUM_DEVNET`, `VITE_EVM_RPC_URL_ARBITRUM_DEVNET`, `VITE_EVM_RPC_URL_BASE_DEVNET`    | Production, Preview | The widget's own RPC of Sepolia, Arbitrum Sepolia and Base Sepolia (see below). Without one, that testnet's USDC payouts are not offered. |
| `VITE_EVM_RPC_URL_ETHEREUM_MAINNET`, `VITE_EVM_RPC_URL_ARBITRUM_MAINNET`, `VITE_EVM_RPC_URL_BASE_MAINNET` | Production          | Set per chain only in that chain's mainnet step (see below). Without one, that chain's mainnet USDC payouts are not offered.              |
| `CHECKOUT_ORIGIN`                                                                                         | none                | Leave unset. Only local demos set it.                                                                                                     |

`VITE_*` values are inlined into the public JavaScript bundle, at build time: a changed
value takes effect only with a new build (Vercel Redeploy, or any merge to `main`). The key in
an RPC URL is **not secret**: the only thing that protects it is the origin restriction set at
the provider.

The build fails when:

- a Production build has no `VITE_SOLANA_RPC_URL_MAINNET`, or it is the public
  `api.mainnet-beta.solana.com` (it rejects browser requests and keeps no full history);
- any RPC URL is not `https:` (plain `http:` is accepted only for `localhost` / `127.0.0.1`);
- a Production build would frame any origin other than `https://pay.elisym.network`;
- a production-origin `v1/embed.js` to `v4/embed.js` differs from its `.sri`, or a committed
  `embed-prod/` file does;
- a frozen loader source differs from `embed-prod/frozen.sha256` (an unreleased v4 changed
  without `bun scripts/freeze.ts --loader v4`);
- a loader is over its size budget (5 KB gzip for v1 to v3, 7 KB for v4);
- the global-scope check fails: v1 to v3 add no global and v4 adds exactly `PayCore`, each
  one expression statement that touches no `document` at load.

## The widget's RPC key

One full-history endpoint per network, used for both sending and finding payments:

1. Create a dedicated Helius API key for the widget. Do not share it with the app or any server.
2. Restrict it by origin to `https://pay.elisym.network`. A request with no `Origin` header
   then gets a 403, so servers and scripts need their own key.
3. Put `https://mainnet.helius-rpc.com/?api-key=<key>` in `VITE_SOLANA_RPC_URL_MAINNET`.
4. Previews run on `*.vercel.app`, which the origin restriction blocks, so the variable is
   set for Production only: a preview offers mainnet products as "network not available"
   and is tested on devnet.
5. The same endpoint reads the elisym protocol fee: every purchase reads it fresh from the
   `elisym-config` program before ordering, Tempo included (a Tempo mainnet purchase reads
   the Solana MAINNET config, a Moderato one the devnet config). A build without
   `VITE_SOLANA_RPC_URL_MAINNET` therefore refuses every mainnet purchase on both rails,
   which is why the Production build fails without it.
6. The origin restriction is for this mainnet key only. If `VITE_SOLANA_RPC_URL_DEVNET` is
   set, its key must not be restricted to `https://pay.elisym.network`, or every preview's
   devnet purchase gets a 403. Leaving it unset uses the public devnet endpoint.

## The EVM RPC of each chain (Ethereum, Arbitrum, Base)

USDC on Ethereum, Arbitrum and Base (EIP-3009) is offered on a chain and network only when
the build has that chain's own RPC: `VITE_EVM_RPC_URL_<SLUG>_<NETWORK>`, with `<SLUG>` one of
`ETHEREUM`, `ARBITRUM`, `BASE` and `<NETWORK>` `MAINNET` (Ethereum, Arbitrum One, Base) or
`DEVNET` (Sepolia, Arbitrum Sepolia, Base Sepolia). A chain without one is not offered,
whatever a store publishes; no public endpoint stands in. Each value must be `https:`.

1. Every read of the rail goes through it: the receipts, the nonce scan, the end proof (an
   `eth_call` pinned by block hash to the finalized block) and the gas estimate. The provider
   must pass, per chain, what the merchant node's own RPC must (the quick start's "RPC must
   serve three days of history"): a receipt hours old, an `eth_getLogs` of at least the chain's
   block range (Ethereum 100, Base 1000, Arbitrum 5000), and the pinned call. Alchemy's free
   tier (10 blocks) fails.
2. The testnet variables are set in Production and Preview. Their keys must NOT be restricted
   to `https://pay.elisym.network`: previews run on `*.vercel.app`, and a key restricted to
   production gets a 403 there, so no preview could pay.
3. A mainnet variable is set for Production only, and only in that chain's mainnet step (Base,
   then Arbitrum, then Ethereum): restrict its key by origin to `https://pay.elisym.network`,
   redeploy, check that the deployed checkout offers that chain's payout, then make a small
   real purchase. A preview then offers that chain's mainnet payout as "network not available".
4. The protocol fee is read from the Solana config of the paired network (mainnet chains read
   `VITE_SOLANA_RPC_URL_MAINNET`'s), and these chains are offered only at a fee of 0.

## Previews

A preview's loader frames that very deployment's checkout (`https://$VERCEL_URL`), never
production and never a newer deployment of the same branch. A preview build without
`VERCEL_URL` fails. Its `v1/embed.js` to `v4/embed.js` therefore differ from the pinned bytes,
and the SRI check is skipped. Those files are for testing only.

Vercel Deployment Protection must allow the preview to be framed by a test page on another
site. A cookie from opening the preview directly is not sent to a third-party frame when the
browser blocks third-party cookies, so either turn protection off for Preview while testing,
or use Protection Bypass for Automation and open the preview once with
`?x-vercel-protection-bypass=<secret>&x-vercel-set-bypass-cookie=samesitenone`.

### Preview checklist

- [ ] The build log prints `first screen` and `v1/embed.js` to `v4/embed.js` lines and no
      error.
- [ ] `/checkout` responds with the `Content-Security-Policy`, `Referrer-Policy: no-referrer`
      and `Cache-Control: no-cache` headers.
- [ ] `/v1/embed.js` to `/v4/embed.js` respond with `Access-Control-Allow-Origin: *` and the
      immutable `Cache-Control`.
- [ ] With the preview's `/v3/embed.js`, the button opens the checkout in a modal; the close
      button, Escape and a click outside it close it, and focus returns to the button.
- [ ] With the preview's `/v4/embed.js`, `<elisym-buy>` behaves as with v3 (the item above).
- [ ] With the preview's `/v4/embed.js`, this opens the checkout in a modal with the frame
      focused: `const checkout = PayCore.open({ product, network: 'devnet' })` (a devnet
      `product` naddr). A devnet purchase fires `status` events `ready -> ordered -> paying -> paid -> completed` on the
      handle and `checkout.state` follows them; the page gets no `elisym-status`.
- [ ] `checkout.closed` settles (with the last state) on each of: `checkout.close()`, Escape,
      a click on the backdrop, the close button, the checkout's own Done, and a second
      `PayCore.open` (which then shows a fresh checkout). Each time focus goes back to what
      was focused before, and no `<elisym-checkout>` stays in the page.
- [ ] A second `PayCore.open` while the first is `ordered` or `paying` throws an `Error` with
      `code: 'busy'`, and the first stays open.
- [ ] On a test page whose CSP has no `frame-src` for the preview, `PayCore.open` fires one
      `error` (`reason: 'unavailable'`) about 10 s after opening, and stays open until closed.
- [ ] Page CSS cannot hide or restyle the programmatic checkout: on a test page with
      `<style>elisym-checkout{display:none!important} body>*{display:none}</style>`, the
      `PayCore.open` modal still shows and works, both in a browser with constructable
      stylesheets (current Chrome, Firefox, Safari) and on the CSSOM fallback path (Safari 14.1,
      or with `delete ShadowRoot.prototype.adoptedStyleSheets` run before `/v4/embed.js`
      loads). The same page's `<elisym-buy>` looks as with v3.
- [ ] A test page with `<elisym-buy product="<devnet naddr>" network="devnet" theme="dark">` and the
      preview's `/v1/embed.js` shows the offer. The page receives `ready` and nothing else
      about the product.
- [ ] A devnet purchase from the test store (`packages/merchant-node`) goes
      `ready -> ordered -> paying -> paid -> completed` and shows Payment complete (Buy again
      primary). No delivery shows anywhere, in the done step or Your purchases.
- [ ] With the testnet `VITE_EVM_RPC_URL_*_DEVNET` variables set, a test store's Sepolia,
      Arbitrum Sepolia and Base Sepolia USDC payouts are offered. A MetaMask purchase on each
      asks to sign, then to send, shows "Confirming on <chain>" and goes
      `ready -> ordered -> paying -> paid -> completed`.
- [ ] After a finished purchase, closing and reopening the modal shows the first step (try the
      close button, Escape, a click on the backdrop and the checkout's own Done). The page hears
      `ready` again. An inline checkout keeps its receipt.
- [ ] Closing during signing also shows the first step on the next open; a press then shows the
      earlier-payment line with no wallet prompt.
- [ ] The first screen shows the wallets under Pay with, and a click on one opens its prompt (the
      popup is not blocked). After a price change the wallets close and Choose wallet opens them.
- [ ] Reloading during `paying` shows the first step; the order is under Your purchases, and a
      press shows the earlier-payment line with no wallet prompt.
- [ ] With site data blocked for the checkout's origin (the browser's "block all cookies and
      site data" setting, so IndexedDB fails), the checkout shows "This browser blocks
      storage for the checkout", the page receives `refused`, and there is no Pay button.

## Production release

1. Merge to `main`. Vercel builds Production with the variables above.
2. Check that the build log's `v1/embed.js` to `v4/embed.js` lines equal `src/embed/v1.sri`
   to `src/embed/v4.sri`, and that `https://pay.elisym.network/v4/embed.js` (and
   `/v3/embed.js`) hashes to `src/embed/v4.sri` (and `src/embed/v3.sri`) before any page or
   doc points at it:

   ```sh
   curl -s https://pay.elisym.network/v4/embed.js | openssl dgst -sha384 -binary | openssl base64 -A
   ```

   The output, prefixed with `sha384-`, must equal `src/embed/v4.sri`. The docs and the
   hosted admin's v4 snippet ship only after this check.

3. Run the preview checklist against `https://pay.elisym.network`, with a mainnet product,
   before announcing it. Real money is involved, so a person does this step.
4. Merchants pin (v1 and v2 are kept working as they are; new pages use v3):

   ```html
   <script
     src="https://pay.elisym.network/v3/embed.js"
     integrity="<the value in src/embed/v3.sri>"
     crossorigin="anonymous"
   ></script>
   ```
