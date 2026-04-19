import { ElisymClient, ElisymIdentity, SolanaPaymentStrategy, type SubCloser } from '@elisym/sdk';
import { Service, type IAgentRuntime } from '@elizaos/core';
import { SERVICE_TYPES } from '../constants';
import { identityFromHex, identityToHex } from '../lib/identity';
import { logger } from '../lib/logger';
import { loadPersistedNostrSecret, persistNostrSecret } from '../lib/secretsMemory';
import { getState } from '../state';

export class ElisymService extends Service {
  static override serviceType = SERVICE_TYPES.ELISYM;

  override capabilityDescription =
    'Decentralized agent-to-agent marketplace via elisym (Nostr + native SOL on Solana)';

  private client?: ElisymClient;
  private identity?: ElisymIdentity;
  private pingSub?: SubCloser;

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

    this.identity = await this.resolveIdentity(config.nostrPrivateKeyHex);
    state.identity = this.identity;

    const client = this.client;
    const identity = this.identity;
    this.pingSub = client.ping.subscribeToPings(identity, (senderPubkey, nonce) => {
      client.ping
        .sendPong(identity, senderPubkey, nonce)
        .catch((error) => logger.debug({ err: error }, 'pong send failed'));
    });

    logger.info(
      { pubkey: this.identity.publicKey, network: config.network, mode: config.mode },
      'ElisymService ready',
    );
  }

  private async resolveIdentity(hexFromConfig?: string): Promise<ElisymIdentity> {
    if (hexFromConfig) {
      return identityFromHex(hexFromConfig);
    }
    const persisted = await loadPersistedNostrSecret(this.runtime);
    if (persisted) {
      logger.info('loaded persisted elisym identity from agent memory');
      return identityFromHex(persisted);
    }
    const fresh = ElisymIdentity.generate();
    await persistNostrSecret(this.runtime, identityToHex(fresh));
    logger.warn(
      { pubkey: fresh.publicKey, npub: fresh.npub },
      'generated new elisym identity and persisted it to agent memory; set ELISYM_NOSTR_PRIVATE_KEY to override',
    );
    return fresh;
  }

  override async stop(): Promise<void> {
    try {
      this.pingSub?.close('elisym stopping');
    } catch (error) {
      logger.warn({ err: error }, 'ping subscription close failed');
    }
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
