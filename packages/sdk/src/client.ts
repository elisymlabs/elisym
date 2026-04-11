import { RELAYS } from './constants';
import { SolanaPaymentStrategy } from './payment/solana';
import type { PaymentStrategy } from './payment/strategy';
import { DiscoveryService } from './services/discovery';
import { MarketplaceService } from './services/marketplace';
import { MediaService } from './services/media';
import { PingService } from './services/ping';
import { NostrPool } from './transport/pool';
import type { ElisymClientConfig } from './types';

export interface ElisymClientFullConfig extends ElisymClientConfig {
  payment?: PaymentStrategy;
  /** Custom upload URL for file uploads (defaults to nostr.build). */
  uploadUrl?: string;
}

export class ElisymClient {
  readonly pool: NostrPool;
  readonly discovery: DiscoveryService;
  readonly marketplace: MarketplaceService;
  readonly ping: PingService;
  readonly media: MediaService;
  readonly payment: PaymentStrategy;

  constructor(config: ElisymClientFullConfig = {}) {
    this.pool = new NostrPool(config.relays ?? RELAYS);
    this.discovery = new DiscoveryService(this.pool);
    this.marketplace = new MarketplaceService(this.pool);
    this.ping = new PingService(this.pool);
    this.media = new MediaService(config.uploadUrl);
    this.payment = config.payment ?? new SolanaPaymentStrategy();
  }

  close(): void {
    this.pool.close();
  }
}
