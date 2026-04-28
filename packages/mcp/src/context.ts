/**
 * AgentContext - shared state for all MCP tools.
 */
import {
  assetByKey,
  assetKey,
  ElisymClient,
  ElisymIdentity,
  formatAssetAmount,
  getProtocolConfig,
  getProtocolProgramId,
  resolveAssetFromPaymentRequest as sdkResolveAssetFromPaymentRequest,
} from '@elisym/sdk';
import type { Asset, PaymentRequestData, ProtocolConfigInput } from '@elisym/sdk';
import { createSolanaRpc } from '@solana/kit';

/**
 * Supported Solana networks. Currently devnet only - mainnet will be re-added
 * once the elisym-config program is deployed and audited. `testnet` is not
 * supported.
 */
export type SolanaNetwork = 'devnet';

/** Map a network to its RPC endpoint. */
export function rpcUrlFor(_network: SolanaNetwork): string {
  return 'https://api.devnet.solana.com';
}

/** Fetch on-chain protocol config (fee, treasury) for a given network. */
export async function fetchProtocolConfig(_network: SolanaNetwork): Promise<ProtocolConfigInput> {
  const programId = getProtocolProgramId('devnet');
  const rpc = createSolanaRpc(rpcUrlFor('devnet'));
  const config = await getProtocolConfig(rpc, programId, { forceRefresh: true });
  return { feeBps: config.feeBps, treasury: config.treasury };
}

/** Map a network to the explorer cluster query-string value. */
export function explorerClusterFor(_network: SolanaNetwork): string {
  return 'devnet';
}

/**
 * sliding-window rate limiter.
 *
 * Keeps a ring buffer of request timestamps. A call is admitted iff fewer than `maxCalls`
 * timestamps lie within the last `windowSecs` seconds. This closes the fixed-window
 * boundary hole where the old code would admit up to 2*maxCalls calls in 2*windowSecs.
 */
class RateLimiter {
  private timestamps: number[] = [];

  constructor(
    private readonly maxCalls: number,
    private readonly windowSecs: number,
  ) {}

  check(): void {
    const now = Date.now();
    const cutoff = now - this.windowSecs * 1000;
    // Drop timestamps that fell out of the window.
    while (this.timestamps.length > 0 && this.timestamps[0]! < cutoff) {
      this.timestamps.shift();
    }
    if (this.timestamps.length >= this.maxCalls) {
      throw new Error(
        `Rate limit exceeded: max ${this.maxCalls} calls per ${this.windowSecs}s. Try again shortly.`,
      );
    }
    this.timestamps.push(now);
  }
}

/** Per-agent security flags. Stored in elisym.yaml `security` block. */
export interface AgentSecurityFlags {
  withdrawals_enabled?: boolean;
  agent_switch_enabled?: boolean;
}

export interface AgentInstance {
  client: ElisymClient;
  identity: ElisymIdentity;
  name: string;
  network: SolanaNetwork;
  solanaKeypair?: { publicKey: string; secretKey: Uint8Array };
  security: AgentSecurityFlags;
  /**
   * Absolute path to this agent's `.elisym/<name>/` directory on disk.
   * Undefined for ephemeral agents (ELISYM_NOSTR_SECRET, auto-created
   * fallback) which have no persistent storage. Tools that read/write
   * `.customer-history.json` or `.contacts.json` MUST gate on this field.
   */
  agentDir?: string;
}

/** Pending withdrawal preview. A call without nonce produces one of these. */
export interface WithdrawalNonce {
  id: string;
  agentName: string;
  destination: string;
  /** Raw amount string as provided by the user (e.g. "0.5" or "all"). */
  amountRaw: string;
  /** Asset to withdraw. Defaults to 'sol' for back-compat with pre-USDC nonces. */
  token?: 'sol' | 'usdc';
  /**
   * Resolved subunits at preview time - used for display only, not for match
   * verification. For SOL this is lamports; for USDC this is 1e-6 USDC.
   */
  lamports: bigint;
  createdAt: number;
}

export class AgentContext {
  /** All loaded agents by name. */
  registry = new Map<string, AgentInstance>();

  /** Currently active agent name. */
  activeAgentName = '';

  /** Rate limiter for payment tools (10 calls per 10s). */
  toolRateLimiter = new RateLimiter(10, 10);

  /** Stricter rate limiter for withdrawals (3 calls per 60s). */
  withdrawRateLimiter = new RateLimiter(3, 60);

  /**
   * Process-wide spend counter per asset. Shared across every agent in
   * `registry` so `switch_agent` can never reset the tally. Empty at startup;
   * incremented by `reserveSpend` before a payment is broadcast and decremented
   * by `releaseSpend` if that payment fails, so the counter reflects committed
   * plus in-flight outflow.
   */
  sessionSpent = new Map<string, bigint>();

  /**
   * Process-wide spend caps per asset, materialized at startup from hardcoded
   * defaults and `~/.elisym/config.yaml` overrides. An absent entry means
   * "no cap for this asset" (spend is allowed unconditionally).
   */
  sessionSpendLimits = new Map<string, bigint>();

  /**
   * Per-asset set of spend-percentage thresholds that have already fired a
   * warning this process. Used to make 50% / 80% warnings one-shot so the
   * caller does not see the same warning on every payment after crossing.
   */
  sessionSpendWarnings = new Map<string, Set<number>>();

  /** pending withdraw previews, keyed by nonce id. TTL enforced on lookup. */
  private withdrawalNonces = new Map<string, WithdrawalNonce>();

  /** Nonce time-to-live in ms. */
  static readonly NONCE_TTL_MS = 60_000;

  /** Max pending withdrawal previews before rejecting new ones. */
  static readonly MAX_PENDING_NONCES = 10;

  /** Get the currently active agent. Throws if none. */
  active(): AgentInstance {
    const agent = this.registry.get(this.activeAgentName);
    if (!agent) {
      throw new Error('No active agent. Use create_agent or switch_agent first.');
    }
    return agent;
  }

  /** Register and optionally activate an agent. */
  register(instance: AgentInstance, activate = true): void {
    this.registry.set(instance.name, instance);
    if (activate) {
      this.activeAgentName = instance.name;
    }
  }

  /** remember a pending withdraw preview, return its nonce. */
  issueWithdrawalNonce(nonce: WithdrawalNonce): void {
    // Evict expired nonces before checking the limit.
    if (this.withdrawalNonces.size >= AgentContext.MAX_PENDING_NONCES) {
      const now = Date.now();
      for (const [id, n] of this.withdrawalNonces) {
        if (now - n.createdAt > AgentContext.NONCE_TTL_MS) {
          this.withdrawalNonces.delete(id);
        }
      }
      if (this.withdrawalNonces.size >= AgentContext.MAX_PENDING_NONCES) {
        throw new Error('Too many pending withdrawal previews. Wait for existing ones to expire.');
      }
    }
    this.withdrawalNonces.set(nonce.id, nonce);
  }

  /** consume a nonce; returns the stored preview or null if missing/expired. */
  consumeWithdrawalNonce(id: string): WithdrawalNonce | null {
    const nonce = this.withdrawalNonces.get(id);
    if (!nonce) {
      return null;
    }
    this.withdrawalNonces.delete(id);
    if (Date.now() - nonce.createdAt > AgentContext.NONCE_TTL_MS) {
      return null;
    }
    return nonce;
  }
}

/**
 * Resolve which `Asset` a `PaymentRequestData` debits.
 *
 * Thin delegate to the SDK helper: reads `request.asset` (new multi-asset
 * wire field) and maps it to a known `Asset`. Absent `asset` => `NATIVE_SOL`
 * (back-compat with payment requests published before multi-asset support).
 * Unknown asset keys throw; session-spend call sites treat that as a hard
 * failure rather than silently counting the spend against SOL.
 */
export function resolveAssetFromPaymentRequest(request: PaymentRequestData): Asset {
  return sdkResolveAssetFromPaymentRequest(request);
}

/**
 * Remaining subunits that may still be spent for the given asset.
 * Returns `null` when no cap is configured — callers treat that as unlimited.
 */
export function remainingForAsset(ctx: AgentContext, asset: Asset): bigint | null {
  const key = assetKey(asset);
  const limit = ctx.sessionSpendLimits.get(key);
  if (limit === undefined) {
    return null;
  }
  const spent = ctx.sessionSpent.get(key) ?? 0n;
  return limit > spent ? limit - spent : 0n;
}

/**
 * Throw a user-facing error if spending `amount` of `asset` would push the
 * process-wide counter past its cap. No-op when the asset has no cap.
 */
export function assertCanSpend(ctx: AgentContext, asset: Asset, amount: bigint): void {
  const key = assetKey(asset);
  const limit = ctx.sessionSpendLimits.get(key);
  if (limit === undefined) {
    return;
  }
  const spent = ctx.sessionSpent.get(key) ?? 0n;
  if (spent + amount > limit) {
    const remaining = limit > spent ? limit - spent : 0n;
    throw new Error(
      `Session spend limit reached for ${asset.symbol}: ` +
        `attempted ${formatAssetAmount(asset, amount)}, ` +
        `already spent ${formatAssetAmount(asset, spent)} of ${formatAssetAmount(asset, limit)} ` +
        `(remaining ${formatAssetAmount(asset, remaining)}). ` +
        'This is a process-wide cap shared across all agents. Restart the MCP server ' +
        'to reset the counter, or raise the limit in ~/.elisym/config.yaml.',
    );
  }
}

/**
 * Add `amount` to the per-asset counter. Prefer `reserveSpend` for payment
 * flows - it bundles the check and the increment so two concurrent tool calls
 * cannot both pass the cap against a stale counter. Exported for tests that
 * seed state directly.
 */
export function recordSpend(ctx: AgentContext, asset: Asset, amount: bigint): void {
  const key = assetKey(asset);
  const prior = ctx.sessionSpent.get(key) ?? 0n;
  ctx.sessionSpent.set(key, prior + amount);
}

/**
 * Atomic check-then-increment. Throws identically to `assertCanSpend` if the
 * cap would be exceeded; otherwise reserves the amount immediately so a
 * concurrent caller sees the updated counter. Must be paired with
 * `releaseSpend` on the failure path so a crashed tx returns the reservation.
 */
export function reserveSpend(ctx: AgentContext, asset: Asset, amount: bigint): void {
  assertCanSpend(ctx, asset, amount);
  recordSpend(ctx, asset, amount);
}

/**
 * Undo a prior `reserveSpend` / `recordSpend`. Saturates at zero so a buggy
 * over-release cannot drive the counter negative.
 */
export function releaseSpend(ctx: AgentContext, asset: Asset, amount: bigint): void {
  const key = assetKey(asset);
  const prior = ctx.sessionSpent.get(key) ?? 0n;
  const next = prior > amount ? prior - amount : 0n;
  ctx.sessionSpent.set(key, next);
}

/** Reverse-lookup from an `AssetKey` to the `Asset` (for display). */
export function lookupAssetByKey(key: string): Asset | undefined {
  return assetByKey(key);
}

/**
 * Percent-of-cap thresholds that emit a soft warning the first time the
 * committed session spend crosses them. Ordered ascending. Each threshold
 * fires at most once per process lifetime, per asset.
 */
export const SPEND_WARN_THRESHOLDS: readonly number[] = [50, 80];

/**
 * Compute one-shot warning lines for any threshold newly crossed by the
 * current committed spend. Mutates `ctx.sessionSpendWarnings` so the same
 * threshold will not fire twice for the same asset in this process.
 *
 * Call AFTER the payment has committed on-chain (not after `reserveSpend`),
 * so a rolled-back reservation does not consume the warning budget.
 */
export function takeSpendWarnings(ctx: AgentContext, asset: Asset): string[] {
  const key = assetKey(asset);
  const limit = ctx.sessionSpendLimits.get(key);
  if (limit === undefined || limit === 0n) {
    return [];
  }
  const spent = ctx.sessionSpent.get(key) ?? 0n;
  const fired = ctx.sessionSpendWarnings.get(key) ?? new Set<number>();
  const lines: string[] = [];
  for (const threshold of SPEND_WARN_THRESHOLDS) {
    if (fired.has(threshold)) {
      continue;
    }
    // Integer compare to avoid float rounding at the boundary.
    if (spent * 100n >= limit * BigInt(threshold)) {
      fired.add(threshold);
      lines.push(
        `Warning: session spend reached ${threshold}% of the ${asset.symbol} cap ` +
          `(${formatAssetAmount(asset, spent)} of ${formatAssetAmount(asset, limit)}). ` +
          `Process-wide, shared across all agents; restart the MCP server to reset.`,
      );
    }
  }
  ctx.sessionSpendWarnings.set(key, fired);
  return lines;
}
