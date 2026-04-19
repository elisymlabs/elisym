import type {
  ElisymClient,
  ElisymIdentity,
  PaymentRequestData,
  ProtocolConfigInput,
} from '@elisym/sdk';
import type { IAgentRuntime } from '@elizaos/core';
import { ModelType } from '@elizaos/core';
import type { Event } from 'nostr-tools';
import { MAX_INCOMING_JOB_BYTES, SERVICE_TYPES } from '../constants';
import { findByJobId, recordTransition, type JobLedgerEntry } from '../lib/jobLedger';
import { logger } from '../lib/logger';
import { findProductByCapability, resolveProducts } from '../lib/providerProducts';
import { RateLimiter } from '../lib/rateLimiter';
import type { WalletService } from '../services/WalletService';
import { getState } from '../state';
import { fetchProtocolConfig, paymentStrategyInstance } from './customerJobFlow';

const incomingRateLimiter = new RateLimiter();

export function _incomingRateLimiterForTest(): RateLimiter {
  return incomingRateLimiter;
}

interface RouteResult {
  content: string;
}

async function routeCapability(
  runtime: IAgentRuntime,
  capability: string,
  input: string,
): Promise<RouteResult> {
  const { config } = getState(runtime);
  const mapped = config.providerActionMap?.[capability];
  if (mapped) {
    const action = runtime.actions.find((candidate) => candidate.name === mapped);
    if (!action) {
      throw new Error(`Configured action "${mapped}" not found on runtime`);
    }
    const collected: string[] = [];
    const syntheticMemory = {
      entityId: runtime.agentId,
      agentId: runtime.agentId,
      roomId: runtime.agentId,
      content: { text: input, source: 'elisym-incoming' },
      createdAt: Date.now(),
    };
    await action.handler(
      runtime,
      syntheticMemory,
      undefined,
      { capability, input },
      async (response) => {
        if (typeof response.text === 'string' && response.text.length > 0) {
          collected.push(response.text);
        }
        return [];
      },
    );
    if (collected.length === 0) {
      throw new Error(`Action "${mapped}" produced no text output`);
    }
    return { content: collected.join('\n') };
  }

  const systemPrompt = runtime.character?.system ?? 'You are a helpful elisym provider agent.';
  const prompt = `${systemPrompt}\n\nTask (${capability}): ${input}`;
  const output = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
  return { content: typeof output === 'string' ? output : JSON.stringify(output) };
}

async function waitForPayment(
  wallet: WalletService,
  protocolConfig: ProtocolConfigInput,
  paymentData: PaymentRequestData,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await paymentStrategyInstance().verifyPayment(
      wallet.rpc,
      paymentData,
      protocolConfig,
      { retries: 1, intervalMs: 0 },
    );
    if (result.verified && result.txSignature) {
      return result.txSignature;
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error('Payment did not arrive before timeout');
}

export interface HandleIncomingJobInput {
  runtime: IAgentRuntime;
  client: ElisymClient;
  identity: ElisymIdentity;
  event: Event;
}

function baseLedger(
  event: Event,
  capability: string,
  priceLamports: bigint,
): Pick<
  JobLedgerEntry,
  'jobEventId' | 'side' | 'capability' | 'priceLamports' | 'customerPubkey' | 'jobCreatedAt'
> {
  return {
    jobEventId: event.id,
    side: 'provider',
    capability,
    priceLamports: priceLamports.toString(),
    customerPubkey: event.pubkey,
    jobCreatedAt: event.created_at * 1000,
  };
}

// Guard against double-entry: if the ledger already knows this job, the
// subscription is replaying (nostr reconnect) or a parallel dispatch raced
// us. Return true if we should skip because the job is already terminal.
async function isAlreadyTerminal(runtime: IAgentRuntime, jobEventId: string): Promise<boolean> {
  const existing = await findByJobId(runtime, jobEventId);
  if (!existing) {
    return false;
  }
  return (
    existing.state === 'delivered' || existing.state === 'failed' || existing.state === 'cancelled'
  );
}

export async function handleIncomingJob(input: HandleIncomingJobInput): Promise<void> {
  const { runtime, client, identity, event } = input;
  const state = getState(runtime);
  if (state.shuttingDown) {
    logger.debug({ jobId: event.id }, 'incoming job dropped: shutdown in progress');
    return;
  }
  const { config } = state;
  const products = resolveProducts(config, runtime.character);
  if (products.length === 0) {
    logger.warn('incoming job received but provider config incomplete; ignoring');
    return;
  }

  if (await isAlreadyTerminal(runtime, event.id)) {
    logger.debug({ jobId: event.id }, 'incoming job already in terminal state; skipping');
    return;
  }

  const decision = incomingRateLimiter.check(event.pubkey);
  if (!decision.allowed) {
    const resetSeconds = Math.max(1, Math.ceil((decision.resetAt - Date.now()) / 1000));
    logger.warn(
      { customer: event.pubkey, count: decision.count, resetSeconds },
      'incoming job rate-limited; rejecting',
    );
    await client.marketplace.submitErrorFeedback(
      identity,
      event,
      `Rate limit exceeded, retry in ${resetSeconds}s`,
    );
    return;
  }

  const contentBytes = Buffer.byteLength(event.content, 'utf8');
  if (contentBytes > MAX_INCOMING_JOB_BYTES) {
    logger.warn({ size: contentBytes }, 'incoming job exceeded size limit; rejecting');
    await client.marketplace.submitErrorFeedback(identity, event, 'Input exceeds maximum size');
    return;
  }

  const capabilityTag = event.tags.find((tag) => tag[0] === 't' && tag[1] && tag[1] !== 'elisym');
  const capability = capabilityTag?.[1] ?? 'generic';
  const product = findProductByCapability(products, capability);
  if (!product) {
    logger.warn({ capability }, 'incoming job capability not advertised; rejecting');
    await client.marketplace.submitErrorFeedback(
      identity,
      event,
      `Capability "${capability}" is not offered by this provider`,
    );
    return;
  }

  const wallet = runtime.getService<WalletService>(SERVICE_TYPES.WALLET);
  if (!wallet) {
    await client.marketplace.submitErrorFeedback(
      identity,
      event,
      'Provider wallet service is unavailable',
    );
    return;
  }

  const ledgerBase = baseLedger(event, capability, product.priceLamports);
  const rawEventJson = JSON.stringify(event);

  try {
    const protocolConfig = await fetchProtocolConfig(wallet.rpc, config.network);
    const amount = Number(product.priceLamports);
    const paymentData = paymentStrategyInstance().createPaymentRequest(
      wallet.address,
      amount,
      protocolConfig,
    );
    const paymentRequestJson = JSON.stringify(paymentData);

    await recordTransition(runtime, {
      ...ledgerBase,
      state: 'waiting_payment',
      rawEventJson,
      paymentRequestJson,
    });

    await client.marketplace.submitPaymentRequiredFeedback(
      identity,
      event,
      amount,
      paymentRequestJson,
    );

    const txSignature = await waitForPayment(wallet, protocolConfig, paymentData, 120_000);
    logger.info({ jobId: event.id, tx: txSignature }, 'payment received, processing job');

    await recordTransition(runtime, {
      ...ledgerBase,
      state: 'paid',
      rawEventJson,
      paymentRequestJson,
      txSignature,
    });

    await client.marketplace.submitProcessingFeedback(identity, event);

    const result = await routeCapability(runtime, capability, event.content);

    await recordTransition(runtime, {
      ...ledgerBase,
      state: 'executed',
      rawEventJson,
      paymentRequestJson,
      txSignature,
      resultContent: result.content,
    });

    await client.marketplace.submitJobResultWithRetry(identity, event, result.content, amount);
    logger.info({ jobId: event.id, capability }, 'elisym job completed');

    await recordTransition(runtime, {
      ...ledgerBase,
      state: 'delivered',
      rawEventJson,
      paymentRequestJson,
      txSignature,
      resultContent: result.content,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const name = error instanceof Error ? error.name : undefined;
    const stack = error instanceof Error ? error.stack : undefined;
    const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
    logger.error({ err: message, name, stack, cause, jobId: event.id }, 'incoming job failed');

    await recordTransition(runtime, {
      ...ledgerBase,
      state: 'failed',
      rawEventJson,
      error: message,
    });

    try {
      await client.marketplace.submitErrorFeedback(identity, event, message);
    } catch (feedbackError) {
      logger.warn({ err: feedbackError }, 'failed to publish error feedback');
    }
  }
}
