import { Keypair, PublicKey } from '@solana/web3.js';
import { finalizeEvent, verifyEvent, type Event, type Filter } from 'nostr-tools';
/**
 * End-to-end tests simulating full customer/provider flows
 * through a local RelaySimulator (no real Nostr relays or Solana).
 */
import { describe, it, expect, vi } from 'vitest';
import { ElisymClient } from '../src/client';
import {
  KIND_APP_HANDLER,
  KIND_JOB_REQUEST,
  KIND_JOB_RESULT,
  KIND_JOB_FEEDBACK,
  KIND_PING,
  KIND_PONG,
  PROTOCOL_TREASURY,
} from '../src/constants';
import { calculateProtocolFee } from '../src/payment/fee';
import { SolanaPaymentStrategy } from '../src/payment/solana';
import { nip44Decrypt } from '../src/primitives/crypto';
import { ElisymIdentity } from '../src/primitives/identity';
import { DiscoveryService, toDTag } from '../src/services/discovery';
import { MarketplaceService } from '../src/services/marketplace';
import { PingService } from '../src/services/ping';
import type { CapabilityCard, SubCloser } from '../src/types';

// ---------------------------------------------------------------------------
// RelaySimulator - local Nostr relay for deterministic testing
// ---------------------------------------------------------------------------

function matchesFilter(event: Event, filter: Filter): boolean {
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  if (filter.until !== undefined && event.created_at > filter.until) return false;
  if ((filter as any).authors && !(filter as any).authors.includes(event.pubkey)) return false;
  for (const [key, values] of Object.entries(filter)) {
    if (key.startsWith('#') && Array.isArray(values)) {
      const tagName = key.slice(1);
      const eventTagValues = event.tags.filter((t) => t[0] === tagName).map((t) => t[1]);
      if (!values.some((v: string) => eventTagValues.includes(v))) return false;
    }
  }
  return true;
}

class RelaySimulator {
  events: Event[] = [];
  private subs: { filter: Filter; onEvent: (ev: Event) => void; closed: boolean }[] = [];

  async publish(event: Event): Promise<void> {
    this.events.push(event);
    for (const sub of this.subs) {
      if (!sub.closed && matchesFilter(event, sub.filter)) {
        sub.onEvent(event);
      }
    }
  }

  async publishAll(event: Event): Promise<void> {
    return this.publish(event);
  }

  async querySync(filter: Filter): Promise<Event[]> {
    const matched = this.events.filter((ev) => matchesFilter(ev, filter));
    const limit = filter.limit ?? matched.length;
    return matched.slice(-limit);
  }

  async queryBatched(
    filter: Omit<Filter, 'authors'>,
    keys: string[],
    _batchSize?: number,
    _maxConcurrency?: number,
  ): Promise<Event[]> {
    return this.querySync({ ...filter, authors: keys } as Filter);
  }

  async queryBatchedByTag(
    filter: Filter,
    tagName: string,
    values: string[],
    _batchSize?: number,
    _maxConcurrency?: number,
  ): Promise<Event[]> {
    return this.querySync({ ...filter, [`#${tagName}`]: values } as Filter);
  }

  subscribe(filter: Filter, onEvent: (ev: Event) => void): SubCloser {
    const sub = { filter, onEvent, closed: false };
    this.subs.push(sub);
    // Backfill existing matching events
    for (const ev of this.events) {
      if (matchesFilter(ev, filter)) onEvent(ev);
    }
    return {
      close: () => {
        sub.closed = true;
      },
    };
  }

  async subscribeAndWait(
    filter: Filter,
    onEvent: (ev: Event) => void,
    _timeoutMs?: number,
  ): Promise<SubCloser> {
    return this.subscribe(filter, onEvent);
  }

  async probe(): Promise<boolean> {
    return true;
  }
  getRelays(): string[] {
    return ['wss://test.relay'];
  }
  reset(): void {
    this.subs.forEach((s) => (s.closed = true));
  }
  close(): void {
    this.subs.forEach((s) => (s.closed = true));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROVIDER_WALLET = Keypair.generate().publicKey.toBase58();
const CUSTOMER_WALLET = Keypair.generate().publicKey.toBase58();
const JOB_PRICE = 100_000_000; // 0.1 SOL

function makeCard(name = 'text-gen-agent'): CapabilityCard {
  return {
    name,
    description: 'AI text generation agent',
    capabilities: ['text-gen'],
    payment: { chain: 'solana', network: 'devnet', address: PROVIDER_WALLET, job_price: JOB_PRICE },
  };
}

function publishCapabilityEvent(
  relay: RelaySimulator,
  identity: ElisymIdentity,
  card: CapabilityCard,
) {
  const ev = finalizeEvent(
    {
      kind: KIND_APP_HANDLER,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['d', toDTag(card.name)],
        ['t', 'elisym'],
        ...card.capabilities.map((c) => ['t', c]),
        ['k', String(KIND_JOB_REQUEST)],
      ],
      content: JSON.stringify(card),
    },
    identity.secretKey,
  );
  return relay.publish(ev).then(() => ev);
}

function publishProfileEvent(relay: RelaySimulator, identity: ElisymIdentity, name: string) {
  const ev = finalizeEvent(
    {
      kind: 0,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: JSON.stringify({ name, about: `${name} agent` }),
    },
    identity.secretKey,
  );
  return relay.publish(ev).then(() => ev);
}

function mockSolanaConnection(opts: {
  keys: string[];
  preBalances: number[];
  postBalances: number[];
  txSignature?: string;
}) {
  const tx = {
    meta: {
      err: null,
      preBalances: opts.preBalances,
      postBalances: opts.postBalances,
    },
    transaction: {
      message: {
        getAccountKeys: () => ({
          length: opts.keys.length,
          get: (i: number) => (opts.keys[i] ? { toBase58: () => opts.keys[i] } : null),
        }),
      },
    },
  };
  return {
    getTransaction: vi.fn().mockResolvedValue(tx),
    getSignaturesForAddress: vi
      .fn()
      .mockResolvedValue(opts.txSignature ? [{ signature: opts.txSignature, err: null }] : []),
  };
}

// ===========================================================================
// E2E: Targeted job flow (customer + provider, NIP-44 encrypted)
// ===========================================================================

describe('E2E: Targeted job flow', () => {
  it('full lifecycle: discovery -> encrypted job -> payment -> encrypted result', async () => {
    const relay = new RelaySimulator();
    const payment = new SolanaPaymentStrategy();
    const customer = ElisymIdentity.generate();
    const provider = ElisymIdentity.generate();

    const customerDiscovery = new DiscoveryService(relay as any);
    const customerMkt = new MarketplaceService(relay as any);
    const providerDiscovery = new DiscoveryService(relay as any);
    const providerMkt = new MarketplaceService(relay as any);

    // --- Provider step 1: publishCapability via DiscoveryService ---
    const card = makeCard();
    const capEventId = await providerDiscovery.publishCapability(provider, card);
    expect(capEventId).toBeTruthy();

    // --- Provider step 2: publishProfile via DiscoveryService ---
    const profileEventId = await providerDiscovery.publishProfile(
      provider,
      'AlphaBot',
      'AI agent',
      'https://img.example/bot.png',
    );
    expect(profileEventId).toBeTruthy();

    // --- Customer step 1: ElisymClient can be created with defaults (smoke test) ---
    // (close immediately - we use relay-backed services for the actual flow)
    const clientSmoke = new ElisymClient();
    expect(clientSmoke.discovery).toBeInstanceOf(DiscoveryService);
    expect(clientSmoke.marketplace).toBeInstanceOf(MarketplaceService);
    expect(clientSmoke.payment).toBeInstanceOf(SolanaPaymentStrategy);
    clientSmoke.close();

    // --- Customer step 2: discovery.fetchAgents('devnet') ---
    const agents = await customerDiscovery.fetchAgents('devnet');
    expect(agents.length).toBe(1);
    expect(agents[0]!.pubkey).toBe(provider.publicKey);
    expect(agents[0]!.name).toBe('AlphaBot');
    expect(agents[0]!.cards[0]!.payment!.address).toBe(PROVIDER_WALLET);

    // --- Customer step 3: submitJobRequest (encrypted, NIP-44) ---
    const jobId = await customerMkt.submitJobRequest(customer, {
      input: 'Explain quantum computing in 100 words',
      capability: 'text-gen',
      providerPubkey: provider.publicKey,
    });
    expect(jobId).toBeTruthy();
    const jobEvent = relay.events.find((e) => e.id === jobId)!;
    expect(jobEvent.tags.find((t) => t[0] === 'encrypted')?.[1]).toBe('nip44');
    expect(jobEvent.content).not.toContain('quantum');

    // --- Provider step 3: subscribeToJobRequests - receives decrypted content ---
    const receivedJob = await new Promise<Event>((resolve) => {
      providerMkt.subscribeToJobRequests(provider, [KIND_JOB_REQUEST], resolve);
    });
    expect(receivedJob.content).toBe('Explain quantum computing in 100 words');
    expect(receivedJob.id).toBe(jobId);

    // --- Provider step 5: submitPaymentRequiredFeedback ---
    const paymentRequest = payment.createPaymentRequest(PROVIDER_WALLET, JOB_PRICE);
    const paymentRequestJson = JSON.stringify(paymentRequest);
    await providerMkt.submitPaymentRequiredFeedback(
      provider,
      jobEvent,
      JOB_PRICE,
      paymentRequestJson,
    );

    // --- Customer step 4: subscribeToJobUpdates -> onFeedback fires ---
    const feedbackResult = await new Promise<{
      status: string;
      amount: number;
      payReqJson: string;
      senderPubkey: string;
    }>((resolve) => {
      customerMkt.subscribeToJobUpdates({
        jobEventId: jobId,
        providerPubkey: provider.publicKey,
        customerPublicKey: customer.publicKey,
        customerSecretKey: customer.secretKey,
        callbacks: {
          onFeedback: (status, amount, payReq, senderPubkey) => {
            resolve({ status, amount: amount!, payReqJson: payReq!, senderPubkey: senderPubkey! });
          },
        },
        sinceOverride: 0,
      });
    });
    expect(feedbackResult.status).toBe('payment-required');
    expect(feedbackResult.amount).toBe(JOB_PRICE);
    expect(feedbackResult.senderPubkey).toBe(provider.publicKey);

    // --- Customer step 5: validatePaymentRequest ---
    const validationError = payment.validatePaymentRequest(
      feedbackResult.payReqJson,
      PROVIDER_WALLET,
    );
    expect(validationError).toBeNull();

    // --- Customer step 6: buildTransaction ---
    const parsedPayReq = JSON.parse(feedbackResult.payReqJson);
    const tx = await payment.buildTransaction(CUSTOMER_WALLET, parsedPayReq);
    expect(tx.instructions.length).toBe(2);
    const fee = calculateProtocolFee(JOB_PRICE);
    const netAmount = JOB_PRICE - fee;
    expect(fee + netAmount).toBe(JOB_PRICE);

    // --- Customer step 7: sign tx (mocked - SDK builds unsigned tx, signing is wallet-side) ---
    const txSignature = 'mock_tx_sig_12345';

    // --- Customer step 8: submitPaymentConfirmation ---
    await customerMkt.submitPaymentConfirmation(customer, jobId, provider.publicKey, txSignature);

    // --- Provider step 6: wait for payment-completed feedback ---
    const paymentCompletedFeedback = relay.events.find(
      (e) =>
        e.kind === KIND_JOB_FEEDBACK &&
        e.tags.some((t) => t[0] === 'status' && t[1] === 'payment-completed') &&
        e.tags.some((t) => t[0] === 'e' && t[1] === jobId),
    );
    expect(paymentCompletedFeedback).toBeDefined();
    expect(paymentCompletedFeedback!.tags.find((t) => t[0] === 'tx')?.[1]).toBe(txSignature);

    // --- Provider step 7: verifyPayment ---
    const conn = mockSolanaConnection({
      keys: [CUSTOMER_WALLET, PROVIDER_WALLET, parsedPayReq.reference, PROTOCOL_TREASURY],
      preBalances: [1_000_000_000, 0, 0, 0],
      postBalances: [1_000_000_000 - JOB_PRICE, netAmount, 0, fee],
      txSignature,
    });
    const verifyResult = await payment.verifyPayment(conn, parsedPayReq, {
      txSignature,
      retries: 1,
      intervalMs: 10,
    });
    expect(verifyResult.verified).toBe(true);
    expect(verifyResult.txSignature).toBe(txSignature);

    // --- Provider step 8: submitJobResult (encrypted, matching request) ---
    const resultContent = 'Quantum computing uses qubits that can be 0 and 1 simultaneously...';
    await providerMkt.submitJobResult(provider, jobEvent, resultContent, JOB_PRICE);
    const resultEvent = relay.events.find((e) => e.kind === KIND_JOB_RESULT)!;
    expect(resultEvent.tags.find((t) => t[0] === 'encrypted')?.[1]).toBe('nip44');
    expect(resultEvent.content).not.toContain('qubits');

    // --- Customer step 9: onResult callback delivers decrypted result ---
    const decryptedResult = await new Promise<string>((resolve) => {
      customerMkt.subscribeToJobUpdates({
        jobEventId: jobId,
        providerPubkey: provider.publicKey,
        customerPublicKey: customer.publicKey,
        customerSecretKey: customer.secretKey,
        callbacks: { onResult: (content) => resolve(content) },
        sinceOverride: 0,
      });
    });
    expect(decryptedResult).toBe(resultContent);
  });
});

// ===========================================================================
// E2E: Broadcast job flow
// ===========================================================================

describe('E2E: Broadcast job flow', () => {
  it('broadcast job: plaintext, multiple providers, full payment cycle, result', async () => {
    const relay = new RelaySimulator();
    const payment = new SolanaPaymentStrategy();
    const customer = ElisymIdentity.generate();
    const provider1 = ElisymIdentity.generate();
    const provider2 = ElisymIdentity.generate();
    const provider1Wallet = Keypair.generate().publicKey.toBase58();
    const BROADCAST_PRICE = 50_000_000;

    const customerMkt = new MarketplaceService(relay as any);
    const provider1Mkt = new MarketplaceService(relay as any);

    // --- Step 1: Customer sends broadcast job (no providerPubkey) ---
    const jobId = await customerMkt.submitJobRequest(customer, {
      input: 'Summarize the news today',
      capability: 'summarize',
    });
    const jobEvent = relay.events.find((e) => e.id === jobId)!;
    expect(jobEvent.tags.find((t) => t[0] === 'encrypted')).toBeUndefined();
    expect(jobEvent.tags.find((t) => t[0] === 'p')).toBeUndefined();
    expect(jobEvent.content).toBe('Summarize the news today');

    // --- Step 2: Both providers can see the plaintext broadcast job ---
    const allJobs = await relay.querySync({
      kinds: [KIND_JOB_REQUEST],
      '#t': ['elisym'],
    } as Filter);
    expect(allJobs.length).toBe(1);
    expect(allJobs[0]!.content).toBe('Summarize the news today');

    // --- Step 3: Provider1 responds with payment-required ---
    const payReq = payment.createPaymentRequest(provider1Wallet, BROADCAST_PRICE);
    await provider1Mkt.submitPaymentRequiredFeedback(
      provider1,
      jobEvent,
      BROADCAST_PRICE,
      JSON.stringify(payReq),
    );

    // --- Step 4: Customer receives feedback, validates, builds tx, confirms ---
    const feedback = await new Promise<{
      status: string;
      payReqJson: string;
      senderPubkey: string;
    }>((resolve) => {
      customerMkt.subscribeToJobUpdates({
        jobEventId: jobId,
        customerPublicKey: customer.publicKey,
        callbacks: {
          onFeedback: (status, _amt, payReqJson, senderPubkey) => {
            resolve({ status, payReqJson: payReqJson!, senderPubkey: senderPubkey! });
          },
        },
        sinceOverride: 0,
      });
    });
    expect(feedback.status).toBe('payment-required');
    expect(feedback.senderPubkey).toBe(provider1.publicKey);
    expect(feedback.senderPubkey).not.toBe(provider2.publicKey);

    // Customer validates payment request from provider1
    const valErr = payment.validatePaymentRequest(feedback.payReqJson, provider1Wallet);
    expect(valErr).toBeNull();

    // Customer builds transaction
    const parsedPayReq = JSON.parse(feedback.payReqJson);
    const tx = await payment.buildTransaction(CUSTOMER_WALLET, parsedPayReq);
    expect(tx.instructions.length).toBe(2);

    // Customer sends payment-completed
    const txSig = 'broadcast_tx_sig';
    await customerMkt.submitPaymentConfirmation(customer, jobId, provider1.publicKey, txSig);

    // --- Step 5: Provider1 submits plaintext result ---
    const resultText = 'Today in the news: markets rally on AI breakthroughs...';
    await provider1Mkt.submitJobResult(provider1, jobEvent, resultText);

    // Verify result is plaintext (broadcast job - no encryption)
    const resultEvent = relay.events.find((e) => e.kind === KIND_JOB_RESULT)!;
    expect(resultEvent.tags.find((t) => t[0] === 'encrypted')).toBeUndefined();
    expect(resultEvent.content).toBe(resultText);

    // --- Step 6: Customer receives plaintext result via onResult callback ---
    const receivedResult = await new Promise<string>((resolve) => {
      customerMkt.subscribeToJobUpdates({
        jobEventId: jobId,
        customerPublicKey: customer.publicKey,
        callbacks: { onResult: (content) => resolve(content) },
        sinceOverride: 0,
      });
    });
    expect(receivedResult).toBe(resultText);
  });
});

// ===========================================================================
// E2E: Error flows
// ===========================================================================

describe('E2E: Error flows', () => {
  it('job timeout fires onError when no provider responds', async () => {
    const relay = new RelaySimulator();
    const customer = ElisymIdentity.generate();
    const customerMkt = new MarketplaceService(relay as any);

    const jobId = await customerMkt.submitJobRequest(customer, {
      input: 'test',
      capability: 'text-gen',
    });

    const error = await new Promise<string>((resolve) => {
      customerMkt.subscribeToJobUpdates({
        jobEventId: jobId,
        customerPublicKey: customer.publicKey,
        callbacks: { onError: resolve },
        timeoutMs: 50,
      });
    });

    expect(error).toContain('Timed out');
  });

  it('detects fee hijack in payment request', () => {
    const payment = new SolanaPaymentStrategy();
    const hackerWallet = Keypair.generate().publicKey.toBase58();

    const request = payment.createPaymentRequest(PROVIDER_WALLET, JOB_PRICE);
    // Attacker tampers with fee address
    request.fee_address = hackerWallet;

    const error = payment.validatePaymentRequest(JSON.stringify(request));
    expect(error).not.toBeNull();
    expect(error!.code).toBe('fee_address_mismatch');
    expect(error!.message).toContain('redirect');
  });

  it('rejects expired payment request', () => {
    const payment = new SolanaPaymentStrategy();
    const request = payment.createPaymentRequest(PROVIDER_WALLET, JOB_PRICE);
    // Tamper: set created_at to 2 hours ago
    request.created_at = Math.floor(Date.now() / 1000) - 7200;

    const error = payment.validatePaymentRequest(JSON.stringify(request));
    expect(error).not.toBeNull();
    expect(error!.code).toBe('expired');
  });

  it('detects fee amount tampering', () => {
    const payment = new SolanaPaymentStrategy();
    const request = payment.createPaymentRequest(PROVIDER_WALLET, JOB_PRICE);
    // Attacker sets fee to 0 to steal the protocol fee
    request.fee_amount = 0;

    const error = payment.validatePaymentRequest(JSON.stringify(request));
    expect(error).not.toBeNull();
    // Either missing_fee or invalid_fee_params depending on fee_address presence
    expect(['missing_fee', 'invalid_fee_params']).toContain(error!.code);
  });

  it('malformed events do not crash active subscriptions', async () => {
    const relay = new RelaySimulator();
    const customer = ElisymIdentity.generate();
    const provider = ElisymIdentity.generate();
    const customerMkt = new MarketplaceService(relay as any);

    const jobId = await customerMkt.submitJobRequest(customer, {
      input: 'test',
      capability: 'text-gen',
    });

    let resultReceived = false;
    let errorReceived = false;
    const done = new Promise<void>((resolve) => {
      customerMkt.subscribeToJobUpdates({
        jobEventId: jobId,
        customerPublicKey: customer.publicKey,
        callbacks: {
          onResult: () => {
            resultReceived = true;
            resolve();
          },
          onError: () => {
            errorReceived = true;
          },
        },
        timeoutMs: 500,
        sinceOverride: 0,
      });
    });

    // Publish malformed feedback (no status tag) - should be silently ignored
    const badFeedback = finalizeEvent(
      {
        kind: KIND_JOB_FEEDBACK,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['e', jobId]], // no status tag
        content: 'garbage',
      },
      provider.secretKey,
    );
    await relay.publish(badFeedback);

    // Now publish a valid result - subscription should still be alive
    const validResult = finalizeEvent(
      {
        kind: KIND_JOB_RESULT,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['e', jobId],
          ['p', customer.publicKey],
        ],
        content: 'valid result',
      },
      provider.secretKey,
    );
    await relay.publish(validResult);

    await done;
    expect(resultReceived).toBe(true);
    expect(errorReceived).toBe(false);
  });

  it('undecryptable results from rogue agents are skipped, real results still delivered', async () => {
    const relay = new RelaySimulator();
    const customer = ElisymIdentity.generate();
    const provider = ElisymIdentity.generate();
    const rogue = ElisymIdentity.generate();
    const customerMkt = new MarketplaceService(relay as any);

    // Submit broadcast job
    const jobId = await customerMkt.submitJobRequest(customer, {
      input: 'hello',
      capability: 'text-gen',
    });

    const result = new Promise<string>((resolve) => {
      customerMkt.subscribeToJobUpdates({
        jobEventId: jobId,
        customerPublicKey: customer.publicKey,
        customerSecretKey: customer.secretKey,
        callbacks: { onResult: resolve },
        timeoutMs: 500,
        sinceOverride: 0,
      });
    });

    // Rogue agent sends fake encrypted result
    const rogueResult = finalizeEvent(
      {
        kind: KIND_JOB_RESULT,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['e', jobId],
          ['p', customer.publicKey],
          ['encrypted', 'nip44'],
        ],
        content: 'not-valid-ciphertext',
      },
      rogue.secretKey,
    );
    await relay.publish(rogueResult);

    // Real provider sends plaintext result
    const realResult = finalizeEvent(
      {
        kind: KIND_JOB_RESULT,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['e', jobId],
          ['p', customer.publicKey],
        ],
        content: 'real result from legit provider',
      },
      provider.secretKey,
    );
    await relay.publish(realResult);

    expect(await result).toBe('real result from legit provider');
  });

  it('ping returns offline when no pong received', async () => {
    const relay = new RelaySimulator();
    const ping = new PingService(relay as any);
    const offlineAgent = ElisymIdentity.generate();

    // No one is listening for pings - agent is offline
    const result = await ping.pingAgent(offlineAgent.publicKey, 100, undefined, 0);
    expect(result.online).toBe(false);
    expect(result.identity).toBeNull();
  });

  it('ping returns online when pong received', async () => {
    const relay = new RelaySimulator();
    const ping = new PingService(relay as any);
    const agentIdentity = ElisymIdentity.generate();

    // Agent subscribes to pings and auto-responds with pongs
    ping.subscribeToPings(agentIdentity, (senderPubkey, nonce) => {
      ping.sendPong(agentIdentity, senderPubkey, nonce);
    });

    const result = await ping.pingAgent(agentIdentity.publicKey, 2000, undefined, 0);
    expect(result.online).toBe(true);
    expect(result.identity).not.toBeNull();
  });

  it('payment verification rejects transaction with wrong reference key (replay)', async () => {
    const payment = new SolanaPaymentStrategy();
    const payReq = payment.createPaymentRequest(PROVIDER_WALLET, JOB_PRICE);
    const fee = calculateProtocolFee(JOB_PRICE);
    const net = JOB_PRICE - fee;

    const conn = mockSolanaConnection({
      keys: [
        CUSTOMER_WALLET,
        PROVIDER_WALLET,
        Keypair.generate().publicKey.toBase58(),
        PROTOCOL_TREASURY,
      ],
      preBalances: [1_000_000_000, 0, 0, 0],
      postBalances: [1_000_000_000 - JOB_PRICE, net, 0, fee],
      txSignature: 'replay_sig',
    });

    const result = await payment.verifyPayment(conn, payReq, {
      txSignature: 'replay_sig',
      retries: 1,
      intervalMs: 10,
    });
    expect(result.verified).toBe(false);
    expect(result.error).toContain('Reference key not found');
  });
});
