import type { Signer } from '@elisym/sdk';
import { Service, type IAgentRuntime } from '@elizaos/core';
import type { Rpc, SolanaRpcApi } from '@solana/kit';
import { SERVICE_TYPES } from '../constants';
import { logger } from '../lib/logger';
import { createSigner, type SignerHandle, type SignerKind } from '../lib/signers';
import { createRpc, getBalanceLamports, resolveRpcUrl } from '../lib/solana';
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
  private signerRef?: Signer;
  private signerKindRef?: SignerKind;
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

    const handle = await this.resolveSigner(config.signerKind, config.solanaPrivateKeyBase58);
    this.signerRef = handle.signer;
    this.signerKindRef = handle.kind;
    if (handle.source === 'generated') {
      logger.warn(
        { network: config.network, address: handle.signer.address, kind: handle.kind },
        'generated new elisym Solana wallet and persisted it to agent memory; fund this address with SOL before hiring paid providers, and back up the key if you need cross-machine access',
      );
    } else {
      logger.info(
        {
          network: config.network,
          address: handle.signer.address,
          source: handle.source,
          kind: handle.kind,
        },
        'WalletService ready',
      );
    }
  }

  private async resolveSigner(
    kind: SignerKind,
    fromConfig: string | undefined,
  ): Promise<SignerHandle> {
    return createSigner(kind, { runtime: this.runtime, fromConfig });
  }

  override async stop(): Promise<void> {
    // @solana/kit RPC clients are stateless HTTP handles; nothing to close.
  }

  get signer(): Signer {
    if (!this.signerRef) {
      throw new Error('WalletService not initialized');
    }
    return this.signerRef;
  }

  get signerKind(): SignerKind {
    if (!this.signerKindRef) {
      throw new Error('WalletService not initialized');
    }
    return this.signerKindRef;
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
