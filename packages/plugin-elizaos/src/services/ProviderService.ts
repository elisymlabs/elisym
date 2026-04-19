import { KIND_APP_HANDLER, KIND_JOB_REQUEST, type SubCloser } from '@elisym/sdk';
import { Service, type IAgentRuntime, type ServiceTypeName } from '@elizaos/core';
import type { Event, Filter } from 'nostr-tools';
import { HEARTBEAT_INTERVAL_MS, SERVICE_TYPES } from '../constants';
import type { ElisymConfig, ProviderProduct } from '../environment';
import { handleIncomingJob } from '../handlers/incomingJobHandler';
import { logger } from '../lib/logger';
import { resolveAgentMeta, resolveProducts } from '../lib/providerProducts';
import { getState } from '../state';
import type { ElisymService } from './ElisymService';

async function awaitService<T>(runtime: IAgentRuntime, type: string): Promise<T> {
  const instance = await runtime.getServiceLoadPromise(type as ServiceTypeName);
  return instance as T;
}

interface ProductCard {
  name: string;
  description: string;
  capabilities: string[];
  payment: {
    chain: 'solana';
    network: ElisymConfig['network'];
    address: string;
    job_price: number;
  };
}

export class ProviderService extends Service {
  static override serviceType = SERVICE_TYPES.PROVIDER;

  override capabilityDescription =
    'Accepts incoming elisym jobs and routes them to ElizaOS actions';

  private sub?: SubCloser;
  private publishedCards: ProductCard[] = [];
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  static override async start(runtime: IAgentRuntime): Promise<ProviderService> {
    const service = new ProviderService(runtime);
    await service.initialize();
    return service;
  }

  private async initialize(): Promise<void> {
    const { config } = getState(this.runtime);
    if (config.mode === 'customer') {
      logger.debug('ProviderService inactive (mode=customer)');
      return;
    }

    // ElizaOS 1.7 registers plugin services in parallel, so a sync
    // getService() here races with ElisymService/WalletService init.
    // Await their load promises instead of throwing on a null lookup.
    const [elisym, walletService] = await Promise.all([
      awaitService<ElisymService>(this.runtime, SERVICE_TYPES.ELISYM),
      awaitService<{ address: string }>(this.runtime, SERVICE_TYPES.WALLET),
    ]);

    const client = elisym.getClient();
    const identity = elisym.getIdentity();
    const address = walletService.address;

    const meta = resolveAgentMeta(this.runtime.character);

    try {
      await client.discovery.publishProfile(identity, meta.name, meta.about);
    } catch (error) {
      logger.warn({ err: error }, 'kind:0 profile publish failed (non-fatal)');
    }

    const products = resolveProducts(config, this.runtime.character);
    if (products.length === 0) {
      throw new Error('Provider mode requires at least one product');
    }
    const cards = products.map((product) => buildCard(product, address, config.network));

    for (const card of cards) {
      try {
        await client.discovery.publishCapability(identity, card, [KIND_JOB_REQUEST]);
        this.publishedCards.push(card);
        logger.info(
          {
            name: card.name,
            capabilities: card.capabilities,
            priceLamports: card.payment.job_price,
          },
          'provider capability card published',
        );
      } catch (error) {
        logger.warn({ err: error, name: card.name }, 'publishCapability failed');
      }
    }

    await this.removeStaleCards(client, identity, new Set(cards.map((c) => c.name)));

    this.sub = client.marketplace.subscribeToJobRequests(
      identity,
      [KIND_JOB_REQUEST],
      (event: Event) => {
        handleIncomingJob({ runtime: this.runtime, client, identity, event }).catch(
          (error: unknown) => {
            logger.error({ err: error, jobId: event.id }, 'incoming job handler crashed');
          },
        );
      },
    );

    this.heartbeatTimer = setInterval(() => {
      for (const card of this.publishedCards) {
        client.discovery.publishCapability(identity, card, [KIND_JOB_REQUEST]).catch((error) => {
          logger.debug({ err: error, name: card.name }, 'heartbeat republish failed (non-fatal)');
        });
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private async removeStaleCards(
    client: ReturnType<ElisymService['getClient']>,
    identity: ReturnType<ElisymService['getIdentity']>,
    keepNames: Set<string>,
  ): Promise<void> {
    try {
      const filter: Filter = {
        kinds: [KIND_APP_HANDLER],
        authors: [identity.publicKey],
        '#t': ['elisym'],
      };
      const events = await client.pool.querySync(filter);
      for (const event of events) {
        let cardName: string | undefined;
        try {
          const parsed = JSON.parse(event.content) as { name?: unknown };
          if (typeof parsed.name === 'string') {
            cardName = parsed.name;
          }
        } catch {
          continue;
        }
        if (!cardName || keepNames.has(cardName)) {
          continue;
        }
        try {
          await client.discovery.deleteCapability(identity, cardName);
          logger.info({ name: cardName }, 'removed stale capability card');
        } catch (error) {
          logger.warn({ err: error, name: cardName }, 'stale card removal failed');
        }
      }
    } catch (error) {
      logger.debug({ err: error }, 'stale-card query failed (non-fatal)');
    }
  }

  override async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    try {
      this.sub?.close('provider stopping');
    } catch (error) {
      logger.warn({ err: error }, 'provider subscription close failed');
    }
    if (this.publishedCards.length > 0) {
      const elisym = this.runtime.getService<ElisymService>(SERVICE_TYPES.ELISYM);
      if (elisym) {
        const client = elisym.getClient();
        const identity = elisym.getIdentity();
        for (const card of this.publishedCards) {
          try {
            await client.discovery.deleteCapability(identity, card.name);
          } catch (error) {
            logger.warn({ err: error, name: card.name }, 'capability card retraction failed');
          }
        }
      }
      this.publishedCards = [];
    }
  }
}

function buildCard(
  product: ProviderProduct,
  address: string,
  network: ElisymConfig['network'],
): ProductCard {
  return {
    name: product.name,
    description: product.description,
    capabilities: [...product.capabilities],
    payment: {
      chain: 'solana',
      network,
      address,
      job_price: Number(product.priceLamports),
    },
  };
}
