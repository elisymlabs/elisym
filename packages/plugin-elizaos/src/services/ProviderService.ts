import { KIND_JOB_REQUEST, type SubCloser } from '@elisym/sdk';
import { Service, type IAgentRuntime } from '@elizaos/core';
import type { Event } from 'nostr-tools';
import { SERVICE_TYPES } from '../constants';
import { handleIncomingJob } from '../handlers/incomingJobHandler';
import { logger } from '../lib/logger';
import { getState } from '../state';
import type { ElisymService } from './ElisymService';

export class ProviderService extends Service {
  static override serviceType = SERVICE_TYPES.PROVIDER;

  override capabilityDescription =
    'Accepts incoming elisym jobs and routes them to ElizaOS actions';

  private sub?: SubCloser;
  private published = false;

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
    if (!config.providerCapabilities?.length || !config.providerPriceLamports) {
      throw new Error('Provider mode requires providerCapabilities and providerPriceLamports');
    }

    const elisym = this.runtime.getService<ElisymService>(SERVICE_TYPES.ELISYM);
    if (!elisym) {
      throw new Error('ElisymService must start before ProviderService');
    }
    const client = elisym.getClient();
    const identity = elisym.getIdentity();

    const walletService = this.runtime.getService(SERVICE_TYPES.WALLET) as {
      address: string;
    } | null;
    const address = walletService?.address;
    if (!address) {
      throw new Error('WalletService must start before ProviderService');
    }

    const character = this.runtime.character;
    const name = character?.name ?? 'elizaos-agent';
    const description = (character?.system ?? '').slice(0, 500) || 'ElizaOS agent on elisym';

    await client.discovery.publishCapability(
      identity,
      {
        name,
        description,
        capabilities: [...config.providerCapabilities],
        payment: {
          chain: 'solana',
          network: config.network,
          address,
          job_price: Number(config.providerPriceLamports),
        },
      },
      [KIND_JOB_REQUEST],
    );
    this.published = true;
    logger.info(
      { capabilities: config.providerCapabilities, pricingLamports: config.providerPriceLamports },
      'provider capability card published',
    );

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
  }

  override async stop(): Promise<void> {
    try {
      this.sub?.close('provider stopping');
    } catch (error) {
      logger.warn({ err: error }, 'provider subscription close failed');
    }
    if (this.published) {
      try {
        const elisym = this.runtime.getService<ElisymService>(SERVICE_TYPES.ELISYM);
        const name = this.runtime.character?.name;
        if (elisym && name) {
          await elisym.getClient().discovery.deleteCapability(elisym.getIdentity(), name);
        }
      } catch (error) {
        logger.warn({ err: error }, 'capability card retraction failed');
      }
    }
  }
}
