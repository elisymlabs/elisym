import { describe, it, expect, vi } from 'vitest';

// Mock SimplePool to avoid real WebSocket connections
vi.mock('nostr-tools', async (importOriginal) => {
  const orig = await importOriginal<typeof import('nostr-tools')>();
  return {
    ...orig,
    SimplePool: vi.fn().mockImplementation(() => ({
      querySync: vi.fn().mockResolvedValue([]),
      publish: vi.fn().mockReturnValue([]),
      subscribeMany: vi.fn().mockReturnValue({ close: vi.fn() }),
      close: vi.fn(),
    })),
  };
});

import { ElisymClient } from '../src/client';
import { SolanaPaymentStrategy } from '../src/payment/solana';
import type { PaymentStrategy } from '../src/payment/strategy';
import { DiscoveryService } from '../src/services/discovery';
import { MarketplaceService } from '../src/services/marketplace';
import { PingService } from '../src/services/ping';

describe('ElisymClient', () => {
  it('creates all services with default config', () => {
    const client = new ElisymClient();
    expect(client.pool).toBeDefined();
    expect(client.discovery).toBeInstanceOf(DiscoveryService);
    expect(client.marketplace).toBeInstanceOf(MarketplaceService);
    expect(client.ping).toBeInstanceOf(PingService);
    expect(client.payment).toBeInstanceOf(SolanaPaymentStrategy);
    client.close();
  });

  it('uses custom relays', () => {
    const relays = ['wss://custom.relay'];
    const client = new ElisymClient({ relays });
    expect(client.pool.getRelays()).toEqual(relays);
    client.close();
  });

  it('uses custom payment strategy', () => {
    const customPayment: PaymentStrategy = {
      chain: 'test',
      calculateFee: () => 0,
      createPaymentRequest: () => ({}) as any,
      validatePaymentRequest: () => null,
      buildTransaction: async () => ({}),
      verifyPayment: async () => ({ verified: true }),
    };

    const client = new ElisymClient({ payment: customPayment });
    expect(client.payment).toBe(customPayment);
    expect(client.payment.chain).toBe('test');
    client.close();
  });

  it('close() does not throw', () => {
    const client = new ElisymClient();
    expect(() => client.close()).not.toThrow();
  });
});
