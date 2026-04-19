import { ElisymClient, ElisymIdentity, SolanaPaymentStrategy, type SubCloser } from '@elisym/sdk';
import { Service, type IAgentRuntime } from '@elizaos/core';
import {
  SERVICE_TYPES,
  WATCHDOG_PROBE_INTERVAL_MS,
  WATCHDOG_PROBE_TIMEOUT_MS,
  WATCHDOG_SELF_PING_INTERVAL_MS,
  WATCHDOG_SELF_PING_TIMEOUT_MS,
} from '../constants';
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
  private probeTimer?: ReturnType<typeof setInterval>;
  private selfPingTimer?: ReturnType<typeof setInterval>;
  private watchdogStopped = false;
  private watchdogBusy = false;

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

    this.subscribeToPings();
    this.startWatchdog();

    logger.info(
      { pubkey: this.identity.publicKey, network: config.network },
      'ElisymService ready',
    );
  }

  private subscribeToPings(): void {
    if (!this.client || !this.identity) {
      return;
    }
    const client = this.client;
    const identity = this.identity;
    this.pingSub = client.ping.subscribeToPings(identity, (senderPubkey, nonce) => {
      client.ping
        .sendPong(identity, senderPubkey, nonce)
        .catch((error) => logger.debug({ err: error }, 'pong send failed'));
    });
  }

  // Works around a nostr-tools bug: a single WS error flips
  // `skipReconnection=true` and silently kills long-lived subscriptions. Same
  // dual-check pattern as @elisym/cli watchdog - probe relays cheaply, and
  // self-ping to detect subscriptions that are dead even though queries work.
  // MUST stay synchronous; any `await` between teardown and rebuild opens a
  // window where stop() could mark us stopped and we'd leak subscriptions.
  private resetPoolAndResubscribe(): void {
    if (!this.client || !this.identity) {
      return;
    }
    this.client.pool.reset();
    this.subscribeToPings();
  }

  private startWatchdog(): void {
    this.probeTimer = setInterval(async () => {
      if (this.watchdogStopped || this.watchdogBusy || !this.client) {
        return;
      }
      this.watchdogBusy = true;
      try {
        const ok = await this.client.pool.probe(WATCHDOG_PROBE_TIMEOUT_MS);
        if (this.watchdogStopped || ok) {
          return;
        }
        logger.warn('watchdog probe failed, resetting pool and re-subscribing');
        this.resetPoolAndResubscribe();
      } catch (error) {
        logger.warn({ err: error }, 'watchdog probe errored');
      } finally {
        this.watchdogBusy = false;
      }
    }, WATCHDOG_PROBE_INTERVAL_MS);

    // selfPingIntervalMs MUST stay > PING_CACHE_TTL_MS (30s in SDK) or the
    // cached "online: true" masks a dead subscription.
    this.selfPingTimer = setInterval(async () => {
      if (this.watchdogStopped || this.watchdogBusy || !this.client || !this.identity) {
        return;
      }
      this.watchdogBusy = true;
      try {
        const result = await this.client.ping.pingAgent(
          this.identity.publicKey,
          WATCHDOG_SELF_PING_TIMEOUT_MS,
        );
        if (this.watchdogStopped || result.online) {
          return;
        }
        logger.warn('watchdog self-ping failed, resetting pool and re-subscribing');
        this.resetPoolAndResubscribe();
      } catch (error) {
        logger.warn({ err: error }, 'watchdog self-ping errored');
      } finally {
        this.watchdogBusy = false;
      }
    }, WATCHDOG_SELF_PING_INTERVAL_MS);
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
    this.watchdogStopped = true;
    if (this.probeTimer) {
      clearInterval(this.probeTimer);
      this.probeTimer = undefined;
    }
    if (this.selfPingTimer) {
      clearInterval(this.selfPingTimer);
      this.selfPingTimer = undefined;
    }
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
