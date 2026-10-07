# @elisym/commerce

The elisym commerce protocol: sell digital goods to people and AI agents, paid directly to the merchant's wallet, with the catalog and orders on Nostr and no platform in the middle.

```bash
npm install @elisym/commerce @elisym/pay-core nostr-tools @solana/kit @solana-program/system @solana-program/token @solana-program/memo decimal.js-light
```

## What is in it

| Piece               | Kind                   | Signed by     | Functions                                                           |
| ------------------- | ---------------------- | ------------- | ------------------------------------------------------------------- |
| Payout addresses    | 10133 (NIP-A3)         | owner         | `buildPaytoEvent`, `parsePayto`, `verifyPaytoProof`                 |
| Store authorization | 30490 (provisional)    | owner         | `buildStoreAuthEvent`, `buildStoreRevocationEvent`, `readStoreAuth` |
| Store profile       | 0                      | store         | `buildStoreProfileEvent`, `parseStoreProfile`                       |
| Product             | 30402 (NIP-99, Gamma)  | store         | `buildProductEvent`, `parseProduct`, `priceInSubunits`              |
| Orders, receipts    | 16 / 17 in a gift wrap | buyer / store | `buildOrderMessage`, `wrapOrderMessage`, `unwrapOrderMessage`       |
| Payment reference   | -                      | -             | `deriveOrderPaymentReference`                                       |
| Offer verification  | -                      | -             | `verifyOffer`, `evaluateOffer`, `isOfferPayout`                     |
| Webhook (merchant)  | -                      | node          | `verifyWebhook`, `signWebhook` (`@elisym/commerce/webhook`)         |

## The one rule

A payment goes only to an address from the owner's kind 10133 event. Any other source of an address (a payment request, an x402 or MPP challenge) must match it:

```ts
import { isOfferPayout, verifyOffer } from '@elisym/commerce';

const result = await verifyOffer(naddr, { fetchEvents }, { pageOrigin });
if (!result.ok) throw new Error(result.message);
if (!isOfferPayout(result.offer, caip19, challenge.payTo)) throw new Error('Not the merchant');
```

`fetchEvents` queries relays (at least two, so one relay cannot hide the newest payout event) or a resolver. Every event it returns is checked again for its signature, author and kind.

On a server, pass `verifyOffer` a `fetch` that refuses private addresses: the merchant's domain comes from the store's own profile.

## The buyer side: `@elisym/commerce/buyer`

The checkout widget and the elisym MCP buy through the same core. It covers:

- loading and verifying the offer (`loadOffer` for a page, `loadOfferForAgent` for an agent);
- placing the order and paying on Solana (`placeOrder`, `payWithSolana`);
- following the store's answer (`watchSolanaPayment`, `listenForStatus`).

Order records live behind an `OrderBackend`, a read-judge-write transaction for one product. Every money rule is judged in the core, never in a backend: one order is never paid twice, and nothing is paid before the store's inbox acknowledged the order. The backends are IndexedDB in the checkout, a locked and fsynced file in the MCP, and `MemoryOrderBackend` for tests.

## The merchant side: `@elisym/commerce/webhook`

The merchant node tells your backend about a payment it verified on chain with a signed `order.paid` webhook. `verifyWebhook` is the receiver's check, and `signWebhook` is what the node signs with, so the two cannot drift:

```ts
import { verifyWebhook } from '@elisym/commerce/webhook';

const result = await verifyWebhook({ secret, body: rawBody, headers: request.headers });
if (!result.ok) return answer(result.reason); // bad_signature, stale: 401; malformed: 400; unknown_event: 2xx
if (result.event.event === 'order.paid') await creditOnce(result.event);
```

It checks the HMAC-SHA256 signature in constant time (any of several secrets, for rotation), the 300-second replay window and the event's shape, and returns a typed `OrderPaidWebhookEvent` or `TestWebhookEvent`. It does not check that the store is yours, that the product and the asset are on your lists, or that the account exists, and it does not deduplicate by `eventId`: those stay in your backend. It runs on WebCrypto only (Node 20+, Bun, Deno, edge runtimes, Workers) and loads none of the peers (npm still installs them). [Credit an account](https://docs.elisym.network/commerce/credit-an-account) has the receiver, the answers and a workaround for a peer conflict.

The package is ESM only. A CommonJS `require` of it needs Node 20.19+ or 22.12+.

## License

MIT
