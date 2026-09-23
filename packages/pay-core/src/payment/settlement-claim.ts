// The settlement-claim pieces that need nothing but the language: kept apart
// from the acceptor so a settlement store (the SDK's file store, in the Node
// entry) can use them without loading the Solana payment rail.

/**
 * A signature a settlement claim can be keyed on.
 *
 * `@elisym/cli` carries a second copy in its own ledger, deliberately: the CLI
 * does not depend on `@elisym/pay-core`, and this one is not part of the SDK's
 * public API (it is exported from `@elisym/pay-core/shared`, which the SDK does
 * not re-export). The two are kept identical by hand, and they have to be - a gate spelled `!== undefined`
 * on one side of that line lets an empty string through where the other refuses.
 *
 * Written once per package and read everywhere rather than spelled out at each gate,
 * because the gates have to agree: two differing by an `=== undefined` is how
 * an empty string gets through one and not the next. An empty string owns
 * nothing - the index drops it - so a claim keyed on one leaves the
 * transaction free for the next job while this one is marked paid.
 */
export function isUsableSignature(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Floor on how long a settlement record has to be kept.
 *
 * Declared beside the interface rather than beside the file-backed store,
 * because every store owes it - a browser one included, and that cannot import
 * `./node`. The reasoning is the chain's history horizon: a signature dropped
 * from the index has to be unverifiable on-chain by then, or it settles a
 * second job. A public RPC keeps ~2-3 days; thirty is a tenfold margin,
 * because archival providers keep more and "unverifiable" is therefore not
 * strictly guaranteed at all. The margin compensates for that - it does not
 * prove it.
 */
export const MIN_SETTLEMENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
