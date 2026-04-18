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
import { logger } from '../lib/logger';
import type { WalletService } from '../services/WalletService';
import { getState } from '../state';
import { fetchProtocolConfig, paymentStrategyInstance } from './customerJobFlow';

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

export async function handleIncomingJob(input: HandleIncomingJobInput): Promise<void> {
  const { runtime, client, identity, event } = input;
  const { config } = getState(runtime);
  if (!config.providerPriceLamports || !config.providerCapabilities) {
    logger.warn('incoming job received but provider config incomplete; ignoring');
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
  if (!config.providerCapabilities.includes(capability)) {
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

  try {
    const protocolConfig = await fetchProtocolConfig(wallet.rpc, config.network);
    const amount = Number(config.providerPriceLamports);
    const paymentData = paymentStrategyInstance().createPaymentRequest(
      wallet.address,
      amount,
      protocolConfig,
    );
    const paymentRequestJson = JSON.stringify(paymentData);

    await client.marketplace.submitPaymentRequiredFeedback(
      identity,
      event,
      amount,
      paymentRequestJson,
    );

    const txSignature = await waitForPayment(wallet, protocolConfig, paymentData, 120_000);
    logger.info({ jobId: event.id, tx: txSignature }, 'payment received, processing job');

    await client.marketplace.submitProcessingFeedback(identity, event);

    const result = await routeCapability(runtime, capability, event.content);
    await client.marketplace.submitJobResultWithRetry(identity, event, result.content, amount);
    logger.info({ jobId: event.id, capability }, 'elisym job completed');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ err: message, jobId: event.id }, 'incoming job failed');
    try {
      await client.marketplace.submitErrorFeedback(identity, event, message);
    } catch (feedbackError) {
      logger.warn({ err: feedbackError }, 'failed to publish error feedback');
    }
  }
}
