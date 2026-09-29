/**
 * `@elisym/commerce/buyer`: the buyer's side of a direct-mode purchase - load
 * and verify the offer, place the order, pay on Solana, follow the store's
 * answer - shared by the checkout widget and the elisym MCP. Order records live
 * behind an `OrderBackend`; every money rule is judged here, never in a backend.
 */
export * from './constants';
export * from './events';
export * from './inbox';
export * from './local-wallet';
export * from './offer';
export * from './order-flow';
export * from './order-record';
export * from './order-store';
export * from './purchase';
export * from './relay-client';
export * from './relays';
export * from './solana-pay';
