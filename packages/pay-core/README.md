# @elisym/pay-core

Payment primitives for [elisym](https://github.com/elisymlabs/elisym): payment requests, protocol fees, assets, and on-chain payment verification on Solana and Tempo, plus EIP-3009 USDC builders and readers for Ethereum, Arbitrum and Base (the docs Networks page says which networks are payable).

This is the money core that `@elisym/sdk` re-exports. Use it directly when you need payments without the Nostr marketplace.

Looking for Pay Core, the stablecoin checkout for your web page? This package is only its low-level primitives. Start with the [quick start](https://docs.elisym.network/commerce/quickstart) and [`@elisym/merchant-node`](https://www.npmjs.com/package/@elisym/merchant-node).

```bash
npm install @elisym/pay-core @solana/kit @solana-program/system @solana-program/token @solana-program/memo decimal.js-light
```

| Entry                     | What it holds                                                                                                                                                                           |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@elisym/pay-core`        | Assets, chains, payment request schemas (v1/v2), fees in basis points, Solana settlement                                                                                                |
| `@elisym/pay-core/evm`    | The EVM rail: protocol config, payment requests, the calls a wallet sends to pay one, and verification on Tempo; the EIP-3009 USDC builders and readers for Ethereum, Arbitrum and Base |
| `@elisym/pay-core/shared` | For elisym's own packages: payment bounds, program addresses, protocol identity, the settlement-store guard. Loads no Solana library                                                    |

The root and `./evm` entries are also available as `@elisym/sdk` and `@elisym/sdk/evm`.

## License

MIT
