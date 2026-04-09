import type { ElisymClient, ElisymIdentity, SubCloser } from '@elisym/sdk';
import type { Event } from 'nostr-tools';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NostrTransport } from '../src/transport/nostr.js';
import type { IncomingJob } from '../src/transport/nostr.js';

function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: overrides.id ?? 'event-' + Math.random().toString(36).slice(2),
    pubkey: overrides.pubkey ?? 'customer-pubkey-' + Math.random().toString(36).slice(2),
    created_at: overrides.created_at ?? Math.floor(Date.now() / 1000),
    kind: overrides.kind ?? 5100,
    tags: overrides.tags ?? [
      ['i', 'test input', 'text'],
      ['t', 'elisym'],
      ['t', 'text-gen'],
    ],
    content: overrides.content ?? 'test input',
    sig: overrides.sig ?? 'fake-sig',
  };
}

function makeDirectedEvent(providerPubkey: string, overrides: Partial<Event> = {}): Event {
  return makeEvent({
    ...overrides,
    tags: [
      ['i', 'encrypted', 'text'],
      ['t', 'elisym'],
      ['t', 'text-gen'],
      ['p', providerPubkey],
      ['encrypted', 'nip44'],
    ],
    content: 'decrypted content',
  });
}

interface MockClient {
  marketplace: {
    subscribeToJobRequests: ReturnType<typeof vi.fn>;
    submitPaymentRequiredFeedback: ReturnType<typeof vi.fn>;
    submitProcessingFeedback: ReturnType<typeof vi.fn>;
    submitErrorFeedback: ReturnType<typeof vi.fn>;
    submitJobResultWithRetry: ReturnType<typeof vi.fn>;
  };
}

let mockClient: MockClient;
let mockIdentity: { publicKey: string; secretKey: Uint8Array };
let capturedCallback: ((event: Event) => void) | null;

function createMockClient(): MockClient {
  const closeSub: SubCloser = { close: vi.fn() };

  return {
    marketplace: {
      subscribeToJobRequests: vi.fn((_identity, _kinds, cb) => {
        capturedCallback = cb;
        return closeSub;
      }),
      submitPaymentRequiredFeedback: vi.fn().mockResolvedValue(undefined),
      submitProcessingFeedback: vi.fn().mockResolvedValue(undefined),
      submitErrorFeedback: vi.fn().mockResolvedValue(undefined),
      submitJobResultWithRetry: vi.fn().mockResolvedValue('result-event-id'),
    },
  };
}

beforeEach(() => {
  capturedCallback = null;
  mockClient = createMockClient();
  mockIdentity = {
    publicKey: 'abcd'.repeat(16),
    secretKey: new Uint8Array(32),
  };
});

describe('NostrTransport', () => {
  describe('start', () => {
    it('subscribes to job requests on start', () => {
      const transport = new NostrTransport(
        mockClient as unknown as ElisymClient,
        mockIdentity as unknown as ElisymIdentity,
        [100],
      );
      transport.start(vi.fn());
      expect(mockClient.marketplace.subscribeToJobRequests).toHaveBeenCalledOnce();
    });

    it('fires onJob for valid events', () => {
      const transport = new NostrTransport(
        mockClient as unknown as ElisymClient,
        mockIdentity as unknown as ElisymIdentity,
        [100],
      );
      const onJob = vi.fn();
      transport.start(onJob);

      capturedCallback!(makeEvent({ id: 'job1' }));
      expect(onJob).toHaveBeenCalledOnce();
      expect(onJob.mock.calls[0][0].jobId).toBe('job1');
    });
  });

  describe('dedup', () => {
    it('does not fire callback for duplicate event IDs', () => {
      const transport = new NostrTransport(
        mockClient as unknown as ElisymClient,
        mockIdentity as unknown as ElisymIdentity,
        [100],
      );
      const onJob = vi.fn();
      transport.start(onJob);

      const event = makeEvent({ id: 'dup1' });
      capturedCallback!(event);
      capturedCallback!(event);

      expect(onJob).toHaveBeenCalledOnce();
    });
  });

  describe('filtering', () => {
    it('ignores events without elisym tag', () => {
      const transport = new NostrTransport(
        mockClient as unknown as ElisymClient,
        mockIdentity as unknown as ElisymIdentity,
        [100],
      );
      const onJob = vi.fn();
      transport.start(onJob);

      capturedCallback!(
        makeEvent({
          id: 'no-elisym',
          tags: [['i', 'test', 'text']],
        }),
      );

      expect(onJob).not.toHaveBeenCalled();
    });

    it('accepts directed jobs', () => {
      const transport = new NostrTransport(
        mockClient as unknown as ElisymClient,
        mockIdentity as unknown as ElisymIdentity,
        [100],
      );
      const onJob = vi.fn();
      transport.start(onJob);

      capturedCallback!(makeDirectedEvent(mockIdentity.publicKey, { id: 'directed-1' }));

      expect(onJob).toHaveBeenCalledOnce();
    });
  });

  describe('event parsing', () => {
    it('extracts tags from event', () => {
      const transport = new NostrTransport(
        mockClient as unknown as ElisymClient,
        mockIdentity as unknown as ElisymIdentity,
        [100],
      );
      const onJob = vi.fn();
      transport.start(onJob);

      capturedCallback!(
        makeEvent({
          id: 'tags-test',
          tags: [
            ['i', 'test input', 'text'],
            ['t', 'elisym'],
            ['t', 'text-gen'],
            ['t', 'summary'],
          ],
        }),
      );

      const job: IncomingJob = onJob.mock.calls[0][0];
      expect(job.tags).toEqual(['elisym', 'text-gen', 'summary']);
    });

    it('detects encrypted events', () => {
      const transport = new NostrTransport(
        mockClient as unknown as ElisymClient,
        mockIdentity as unknown as ElisymIdentity,
        [100],
      );
      const onJob = vi.fn();
      transport.start(onJob);

      capturedCallback!(makeDirectedEvent(mockIdentity.publicKey, { id: 'enc-test' }));

      const job: IncomingJob = onJob.mock.calls[0][0];
      expect(job.encrypted).toBe(true);
      expect(job.input).toBe('decrypted content');
    });

    it('extracts bid from event', () => {
      const transport = new NostrTransport(
        mockClient as unknown as ElisymClient,
        mockIdentity as unknown as ElisymIdentity,
        [100],
      );
      const onJob = vi.fn();
      transport.start(onJob);

      capturedCallback!(
        makeEvent({
          id: 'bid-test',
          tags: [
            ['i', 'test', 'text'],
            ['t', 'elisym'],
            ['bid', '500000'],
          ],
        }),
      );

      const job: IncomingJob = onJob.mock.calls[0][0];
      expect(job.bid).toBe(500_000);
    });
  });

  describe('sendFeedback', () => {
    it('sends payment-required feedback', async () => {
      const transport = new NostrTransport(
        mockClient as unknown as ElisymClient,
        mockIdentity as unknown as ElisymIdentity,
        [100],
      );
      const job: IncomingJob = {
        jobId: 'j1',
        input: 'test',
        inputType: 'text',
        tags: ['elisym'],
        customerId: 'cust1',
        encrypted: false,
        rawEvent: makeEvent(),
      };

      await transport.sendFeedback(job, {
        type: 'payment-required',
        amount: 100_000,
        paymentRequest: '{}',
        chain: 'solana',
      });

      expect(mockClient.marketplace.submitPaymentRequiredFeedback).toHaveBeenCalledWith(
        mockIdentity,
        job.rawEvent,
        100_000,
        '{}',
      );
    });

    it('sends processing feedback', async () => {
      const transport = new NostrTransport(
        mockClient as unknown as ElisymClient,
        mockIdentity as unknown as ElisymIdentity,
        [100],
      );
      const job: IncomingJob = {
        jobId: 'j1',
        input: 'test',
        inputType: 'text',
        tags: ['elisym'],
        customerId: 'cust1',
        encrypted: false,
        rawEvent: makeEvent(),
      };

      await transport.sendFeedback(job, { type: 'processing' });

      expect(mockClient.marketplace.submitProcessingFeedback).toHaveBeenCalledWith(
        mockIdentity,
        job.rawEvent,
      );
    });

    it('sends error feedback', async () => {
      const transport = new NostrTransport(
        mockClient as unknown as ElisymClient,
        mockIdentity as unknown as ElisymIdentity,
        [100],
      );
      const job: IncomingJob = {
        jobId: 'j1',
        input: 'test',
        inputType: 'text',
        tags: ['elisym'],
        customerId: 'cust1',
        encrypted: false,
        rawEvent: makeEvent(),
      };

      await transport.sendFeedback(job, { type: 'error', message: 'skill failed' });

      expect(mockClient.marketplace.submitErrorFeedback).toHaveBeenCalledWith(
        mockIdentity,
        job.rawEvent,
        'skill failed',
      );
    });
  });

  describe('deliverResult', () => {
    it('calls submitJobResultWithRetry', async () => {
      const transport = new NostrTransport(
        mockClient as unknown as ElisymClient,
        mockIdentity as unknown as ElisymIdentity,
        [100],
      );
      const job: IncomingJob = {
        jobId: 'j1',
        input: 'test',
        inputType: 'text',
        tags: ['elisym'],
        customerId: 'cust1',
        encrypted: false,
        rawEvent: makeEvent(),
      };

      const eventId = await transport.deliverResult(job, 'result text', 100_000);

      expect(eventId).toBe('result-event-id');
      expect(mockClient.marketplace.submitJobResultWithRetry).toHaveBeenCalledWith(
        mockIdentity,
        job.rawEvent,
        'result text',
        100_000,
        3,
      );
    });
  });

  describe('stop', () => {
    it('closes subscriptions', () => {
      const transport = new NostrTransport(
        mockClient as unknown as ElisymClient,
        mockIdentity as unknown as ElisymIdentity,
        [100],
      );
      transport.start(vi.fn());
      transport.stop();

      // Verify no crash on double stop
      transport.stop();
    });
  });
});
