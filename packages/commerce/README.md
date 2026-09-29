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

## License

MIT
