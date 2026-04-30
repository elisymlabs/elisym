# Changelog

## 0.15.0

### Added

- New `@elisym/sdk/llm-health` subpath: provider-agnostic health monitor for
  LLM API keys. Building blocks for CLI and plugin-elizaos to detect billing
  exhaustion, invalid keys, and rate limits before the customer pays.
  - `LlmHealthMonitor` class with TTL-cached state per `(provider, model)`
    pair, in-flight probe deduplication, and tolerance for transient
    `unavailable` results before pessimistic refusal.
  - `startLlmHeartbeat({ monitor, intervalMs })` for periodic re-verification
    with status-transition logging.
  - `createFreeLlmLimiterSet()` two-tier sliding-window limiter for free LLM
    skills: per-(customer, skill) cap plus global Sybil cap.
  - Types: `LlmKeyVerification` discriminated union with
    `'invalid' | 'billing' | 'unavailable'` reasons, `LlmHealthError`,
    `SkillRateLimit`.
- `validateSkillFrontmatter` now accepts an optional `rate_limit` block in
  SKILL.md frontmatter (`per_window_secs`, `max_per_window`). Parsed into
  camelCase `rateLimit: SkillRateLimit` on `ParsedSkill`. Applies to any
  skill mode; CLI runtime treats free LLM skills as the primary use case.

## 0.5.0

### Breaking changes

- Removed `parseConfig` (from `@elisym/sdk/node`) and `serializeConfig`. Agent
  config I/O now goes through the new `@elisym/sdk/agent-store` subpath, which
  reads/writes `elisym.yaml` (public) + `.secrets.json` (private) in the
  `.elisym/<name>/` layout.
- Removed the `AgentConfig`, `Identity`, `Capability`, `PaymentAddress`,
  `WalletConfig`, and `LlmConfig` interfaces. Use `ElisymYaml` / `Secrets` from
  `@elisym/sdk/agent-store` instead.

### Added

- New `@elisym/sdk/agent-store` subpath (Node.js only):
  - Zod schemas: `ElisymYamlSchema`, `SecretsSchema`, `MediaCacheSchema`.
  - Path helpers: `findProjectElisymDir` (walk-up to first `.git` or `$HOME`),
    `homeElisymDir`, `agentPaths`.
  - Resolver: `resolveAgent` (project-local beats home-global; tracks
    `shadowsGlobal`), `resolveInProject`, `resolveInHome`.
  - Loader: `loadAgent` (parses YAML + secrets, decrypts).
  - Writer: `createAgentDir` (auto-generates `.gitignore` for project-local),
    `writeYaml`, `writeSecrets` (atomic, 0o600 for secrets).
  - Listing: `listAgents` (union of project + home, dedup with project
    precedence).
  - Media cache: `readMediaCache`, `writeMediaCache`, `hashFile`,
    `lookupCachedUrl`, `newCacheEntry` (sha256-keyed, prevents re-uploads).

### Dependencies

- Added `yaml@~2.8.3` and `zod@~3.25.0` as regular dependencies.

## 0.4.0

### Breaking changes

- Migrated from `@solana/web3.js` ~1.98 to `@solana/kit` ~6.8 (web3.js v2). The
  package no longer accepts a `Connection`; pass an `Rpc<SolanaRpcApi>` from
  `createSolanaRpc(url)` instead. `PublicKey`/`Keypair` are gone in favour of
  the branded `Address` type and `TransactionSigner` interface.
- `calculateProtocolFee(amount)` is now `calculateProtocolFee(amount, feeBps)` -
  the fee in basis points must be supplied by the caller. The implicit
  dependency on `PROTOCOL_FEE_BPS` was removed in preparation for reading the
  configured fee from the on-chain elisym-config program.
- `SolanaPaymentStrategy` methods now take an explicit `ProtocolConfigInput`
  argument (`{ feeBps, treasury }`):
  - `calculateFee(amount, config)`
  - `createPaymentRequest(recipientAddress, amount, config, options?)`
  - `validatePaymentRequest(requestJson, config, expectedRecipient?)`
  - `buildTransaction(paymentRequest, payerSigner, rpc, config)` - now takes a
    `TransactionSigner` and `Rpc<SolanaRpcApi>` and returns a signed
    `Readonly<Transaction>` (Kit) ready to send via
    `rpc.sendTransaction(...).send()`.
  - `verifyPayment(rpc, paymentRequest, config, options?)` - the first
    argument is the Kit `Rpc` instead of a web3.js `Connection`.
- The bundled `PROTOCOL_TREASURY` constant is now typed as `Address` (Kit
  branded type) so it can be used directly with the new payment APIs without a
  cast.

### Added

- `ProtocolConfigInput` interface for protocol fee/treasury injection.
- `buildPaymentInstructions(paymentRequest, payerSigner)` helper that returns
  the System program transfer instructions (with the payment reference
  attached as a read-only, non-signer account on the provider transfer) so
  callers and tests can inspect amounts before signing.

### Migration

Before:

```ts
import { Connection } from '@solana/web3.js';
import { SolanaPaymentStrategy } from '@elisym/sdk';

const payment = new SolanaPaymentStrategy();
const connection = new Connection('https://api.devnet.solana.com');
const request = payment.createPaymentRequest(recipient, 100_000_000);
const tx = await payment.buildTransaction(payerAddress, request);
// caller signs and sends `tx`
const verdict = await payment.verifyPayment(connection, request, {
  txSignature: 'sig',
});
```

After:

```ts
import { createSolanaRpc, generateKeyPairSigner } from '@solana/kit';
import {
  PROTOCOL_FEE_BPS,
  PROTOCOL_TREASURY,
  SolanaPaymentStrategy,
  type ProtocolConfigInput,
} from '@elisym/sdk';

const payment = new SolanaPaymentStrategy();
const rpc = createSolanaRpc('https://api.devnet.solana.com');
const config: ProtocolConfigInput = {
  feeBps: PROTOCOL_FEE_BPS,
  treasury: PROTOCOL_TREASURY,
};

const request = payment.createPaymentRequest(recipient, 100_000_000, config);
const payerSigner = await generateKeyPairSigner();
const signedTx = await payment.buildTransaction(request, payerSigner, rpc, config);
// `signedTx` is already signed - send via `rpc.sendTransaction(...).send()`
const verdict = await payment.verifyPayment(rpc, request, config, {
  txSignature: 'sig',
});
```
