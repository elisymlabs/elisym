import { Service, type IAgentRuntime } from '@elizaos/core';
import type { KeyPairSigner, Rpc, SolanaRpcApi } from '@solana/kit';
import { SERVICE_TYPES } from '../constants';
import { logger } from '../lib/logger';
import { loadPersistedSolanaSecret, persistSolanaSecret } from '../lib/secretsMemory';
import {
  createRpc,
  generateSolanaSecretBase58,
  getBalanceLamports,
  resolveRpcUrl,
  signerFromBase58,
} from '../lib/solana';
import {
  createSpendingBucket,
  assertCanSpend,
  loadSpendingHistory,
  persistSpend,
  recordSpend,
  requiresApproval,
  reserveSpend,
  hourlyTotal,
  type SpendingBucket,
  type SpendingReservation,
} from '../lib/spendingGuard';
import { getState } from '../state';

export class WalletService extends Service {
  static override serviceType = SERVICE_TYPES.WALLET;

  override capabilityDescription = 'Solana wallet and spending guard for elisym jobs';

  private bucket?: SpendingBucket;
  private signerRef?: KeyPairSigner;
  private rpcRef?: Rpc<SolanaRpcApi>;
  private rpcUrlRef?: string;

  static override async start(runtime: IAgentRuntime): Promise<WalletService> {
    const service = new WalletService(runtime);
    await service.initialize();
    return service;
  }

  private async initialize(): Promise<void> {
    const { config } = getState(this.runtime);
    const history = await loadSpendingHistory(this.runtime);
    this.bucket = createSpendingBucket(
      {
        maxSpendPerJobLamports: config.maxSpendPerJobLamports,
        maxSpendPerHourLamports: config.maxSpendPerHourLamports,
        requireApprovalAboveLamports: config.requireApprovalAboveLamports,
      },
      history,
    );
    if (history.length > 0) {
      const hourTotal = history.reduce((sum, event) => sum + event.lamports, 0n);
      logger.info(
        { hourLamports: hourTotal.toString(), entryCount: history.length },
        'restored spending history from agent memory',
      );
    }
    this.rpcUrlRef = resolveRpcUrl(config.network, config.solanaRpcUrl);
    this.rpcRef = createRpc(this.rpcUrlRef);

    const { base58, source } = await this.resolveSecret(config.solanaPrivateKeyBase58);
    this.signerRef = await signerFromBase58(base58);
    if (source === 'generated') {
      logger.warn(
        { network: config.network, address: this.signerRef.address },
        'generated new elisym Solana wallet and persisted it to agent memory; fund this address with SOL before hiring paid providers, and back up the key if you need cross-machine access',
      );
    } else {
      logger.info(
        { network: config.network, address: this.signerRef.address, source },
        'WalletService ready',
      );
    }
  }

  private async resolveSecret(
    fromConfig: string | undefined,
  ): Promise<{ base58: string; source: 'config' | 'persisted' | 'generated' }> {
    if (fromConfig) {
      return { base58: fromConfig, source: 'config' };
    }
    const persisted = await loadPersistedSolanaSecret(this.runtime);
    if (persisted) {
      return { base58: persisted, source: 'persisted' };
    }
    const fresh = await generateSolanaSecretBase58();
    await persistSolanaSecret(this.runtime, fresh);
    return { base58: fresh, source: 'generated' };
  }

  override async stop(): Promise<void> {
    // @solana/kit RPC clients are stateless HTTP handles; nothing to close.
  }

  get signer(): KeyPairSigner {
    if (!this.signerRef) {
      throw new Error('WalletService not initialized');
    }
    return this.signerRef;
  }

  get rpc(): Rpc<SolanaRpcApi> {
    if (!this.rpcRef) {
      throw new Error('WalletService not initialized');
    }
    return this.rpcRef;
  }

  get rpcUrl(): string {
    if (!this.rpcUrlRef) {
      throw new Error('WalletService not initialized');
    }
    return this.rpcUrlRef;
  }

  get address(): string {
    return this.signer.address;
  }

  async getBalance(): Promise<bigint> {
    return getBalanceLamports(this.rpc, this.signer);
  }

  guard(lamports: bigint): void {
    assertCanSpend(this.requireBucket(), lamports);
  }

  reserve(lamports: bigint): SpendingReservation {
    return reserveSpend(this.requireBucket(), lamports);
  }

  requiresApproval(lamports: bigint): boolean {
    return requiresApproval(this.requireBucket(), lamports);
  }

  recordSpend(lamports: bigint): void {
    const ts = Date.now();
    recordSpend(this.requireBucket(), lamports, ts);
    // Fire-and-forget persist so the caller's hot path (payment
    // confirmation) is never blocked on DB write. A logged failure
    // means the spend won't load after restart - effectively widening
    // the hourly cap. We accept that over failing an already-sent
    // on-chain transaction; the error surfaces in the WARN log.
    persistSpend(this.runtime, lamports, ts).catch(() => {});
  }

  hourlyTotal(): bigint {
    return hourlyTotal(this.requireBucket());
  }

  private requireBucket(): SpendingBucket {
    if (!this.bucket) {
      throw new Error('WalletService not initialized');
    }
    return this.bucket;
  }
}
