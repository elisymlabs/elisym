import { ElisymClient, ElisymIdentity, SolanaPaymentStrategy } from '@elisym/sdk';
import { Service, type IAgentRuntime } from '@elizaos/core';
import { SERVICE_TYPES } from '../constants';
import { identityFromHex } from '../lib/identity';
import { logger } from '../lib/logger';
import { getState } from '../state';

export class ElisymService extends Service {
  static override serviceType = SERVICE_TYPES.ELISYM;

  override capabilityDescription =
    'Decentralized agent-to-agent marketplace via elisym (Nostr + native SOL on Solana)';

  private client?: ElisymClient;
  private identity?: ElisymIdentity;

  static override async start(runtime: IAgentRuntime): Promise<ElisymService> {
    const service = new ElisymService(runtime);
    await service.initialize();
    return service;
  }

  private async initialize(): Promise<void> {
    const state = getState(this.runtime);
    const { config } = state;

    this.client = new ElisymClient({
      relays: config.relays,
      payment: new SolanaPaymentStrategy(),
    });

    this.identity = this.loadOrCreateIdentity(config.nostrPrivateKeyHex);
    state.identity = this.identity;

    logger.info(
      { pubkey: this.identity.publicKey, network: config.network, mode: config.mode },
      'ElisymService ready',
    );
  }

  private loadOrCreateIdentity(hexFromConfig?: string): ElisymIdentity {
    if (hexFromConfig) {
      return identityFromHex(hexFromConfig);
    }
    const fresh = ElisymIdentity.generate();
    logger.warn(
      { pubkey: fresh.publicKey },
      'generated ephemeral elisym identity; set ELISYM_NOSTR_PRIVATE_KEY to keep the same pubkey across restarts',
    );
    return fresh;
  }

  override async stop(): Promise<void> {
    try {
      this.client?.close();
    } catch (error) {
      logger.warn({ err: error }, 'ElisymClient close failed');
    }
  }

  getClient(): ElisymClient {
    if (!this.client) {
      throw new Error('ElisymClient not initialized');
    }
    return this.client;
  }

  getIdentity(): ElisymIdentity {
    if (!this.identity) {
      throw new Error('ElisymIdentity not initialized');
    }
    return this.identity;
  }
}
