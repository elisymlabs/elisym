/**
 * AgentContext - shared state for all MCP tools.
 */
import { ElisymClient, ElisymIdentity, getProtocolConfig, getProtocolProgramId } from '@elisym/sdk';
import type { ProtocolConfigInput } from '@elisym/sdk';
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

/** Per-agent security flags. Stored in config.json `security` block. */
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
}

/** Pending withdrawal preview. A call without nonce produces one of these. */
export interface WithdrawalNonce {
  id: string;
  agentName: string;
  destination: string;
  /** Raw amount string as provided by the user (e.g. "0.5" or "all"). */
  amountRaw: string;
  /** Lamports computed at preview time - used for display only, not for match verification. */
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
