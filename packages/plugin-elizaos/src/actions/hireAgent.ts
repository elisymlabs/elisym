import type { Action, ActionResult, IAgentRuntime, Memory, State } from '@elizaos/core';
import { nip19 } from 'nostr-tools';
import { DEFAULT_JOB_TIMEOUT_MS, FEE_RESERVE_LAMPORTS, SERVICE_TYPES } from '../constants';
import { executePaymentFlow } from '../handlers/customerJobFlow';
import { logger } from '../lib/logger';
import { formatLamportsAsSol } from '../lib/pricing';
import type { ElisymService } from '../services/ElisymService';
import type { WalletService } from '../services/WalletService';
import { getState, hasState } from '../state';
import type { ActiveJob } from '../types';

interface HireTarget {
  pubkey: string;
  priceLamports: bigint;
  capability: string;
  address: string;
}

function decodeProviderPubkey(raw: string): string {
  if (/^[0-9a-f]{64}$/i.test(raw)) {
    return raw.toLowerCase();
  }
  if (raw.startsWith('npub')) {
    const decoded = nip19.decode(raw);
    if (decoded.type === 'npub') {
      return decoded.data;
    }
  }
  throw new Error(`Invalid provider reference: ${raw.slice(0, 16)}...`);
}

function resolveTarget(
  runtime: IAgentRuntime,
  options: Record<string, unknown> | undefined,
): HireTarget {
  const state = getState(runtime);
  const explicitPubkey =
    typeof options?.providerPubkey === 'string' ? options.providerPubkey : undefined;
  const explicitNpub = typeof options?.providerNpub === 'string' ? options.providerNpub : undefined;
  const explicitCapability =
    typeof options?.capability === 'string' ? options.capability : undefined;
  const explicitPrice =
    typeof options?.priceLamports === 'bigint' ? options.priceLamports : undefined;
  const explicitAddress = typeof options?.address === 'string' ? options.address : undefined;

  if (explicitPubkey || explicitNpub) {
    const pubkey = decodeProviderPubkey(explicitPubkey ?? explicitNpub ?? '');
    if (!explicitPrice || !explicitAddress) {
      const known = state.lastDiscovery?.candidates.find(
        (candidate) => candidate.pubkey === pubkey,
      );
      if (!known?.priceLamports || !known?.address) {
        throw new Error(
          'Explicit provider pubkey requires priceLamports + address, or prior DISCOVER to populate them',
        );
      }
      return {
        pubkey,
        priceLamports: explicitPrice ?? known.priceLamports,
        address: explicitAddress ?? known.address,
        capability: explicitCapability ?? known.capabilities[0] ?? 'generic',
      };
    }
    return {
      pubkey,
      priceLamports: explicitPrice,
      address: explicitAddress,
      capability: explicitCapability ?? 'generic',
    };
  }

  const first = state.lastDiscovery?.candidates[0];
  if (!first?.priceLamports || !first?.address) {
    throw new Error(
      'No provider selected. Run ELISYM_DISCOVER_PROVIDERS first or supply providerPubkey/priceLamports/address in options.',
    );
  }
  return {
    pubkey: first.pubkey,
    priceLamports: first.priceLamports,
    address: first.address,
    capability: explicitCapability ?? first.capabilities[0] ?? 'generic',
  };
}

export const hireAgentAction: Action = {
  name: 'ELISYM_HIRE_AGENT',
  similes: ['SUBMIT_JOB', 'ORDER_SERVICE', 'PAY_AGENT'],
  description: 'Submit a paid job request to a specific elisym provider and wait for the result.',
  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    if (!hasState(runtime)) {
      return false;
    }
    const { config, lastDiscovery } = getState(runtime);
    if (config.mode === 'provider') {
      return false;
    }
    return lastDiscovery !== null && lastDiscovery.candidates.length > 0;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    options: { [key: string]: unknown } | undefined,
    callback,
  ): Promise<ActionResult> => {
    const state = getState(runtime);
    const { config } = state;

    const target = resolveTarget(runtime, options);
    const input =
      (typeof options?.input === 'string' ? options.input : undefined) ??
      message.content.text ??
      '';
    if (input.length === 0) {
      throw new Error('Cannot hire an agent with empty input');
    }

    const elisym = runtime.getService<ElisymService>(SERVICE_TYPES.ELISYM);
    const wallet = runtime.getService<WalletService>(SERVICE_TYPES.WALLET);
    if (!elisym || !wallet) {
      throw new Error('Elisym or Wallet service is not running');
    }

    if (wallet.requiresApproval(target.priceLamports) && options?.approved !== true) {
      throw new Error(
        `Approval required: ${formatLamportsAsSol(target.priceLamports)} SOL exceeds the approval threshold (${formatLamportsAsSol(config.requireApprovalAboveLamports)} SOL). Re-invoke with options.approved=true to confirm.`,
      );
    }

    const reservation = wallet.reserve(target.priceLamports);

    let balance: bigint;
    try {
      balance = await wallet.getBalance();
    } catch (error) {
      reservation.release();
      throw error;
    }
    if (balance < target.priceLamports + FEE_RESERVE_LAMPORTS) {
      reservation.release();
      throw new Error(
        `Insufficient wallet balance: have ${formatLamportsAsSol(balance)} SOL, need ${formatLamportsAsSol(target.priceLamports + FEE_RESERVE_LAMPORTS)} SOL`,
      );
    }

    const client = elisym.getClient();
    const identity = elisym.getIdentity();

    let jobEventId: string;
    try {
      jobEventId = await client.marketplace.submitJobRequest(identity, {
        input,
        capability: target.capability,
        providerPubkey: target.pubkey,
      });
    } catch (error) {
      reservation.release();
      throw error;
    }

    const job: ActiveJob = {
      id: jobEventId,
      status: 'pending',
      providerPubkey: target.pubkey,
      lamports: target.priceLamports,
      capability: target.capability,
      createdAt: Date.now(),
      lastUpdate: Date.now(),
      releaseReservation: () => reservation.release(),
    };
    state.activeJobs.set(jobEventId, job);

    const paymentState = { inFlight: false, paid: false };

    const close = client.marketplace.subscribeToJobUpdates({
      jobEventId,
      customerPublicKey: identity.publicKey,
      providerPubkey: target.pubkey,
      customerSecretKey: identity.secretKey,
      timeoutMs: DEFAULT_JOB_TIMEOUT_MS,
      callbacks: {
        onFeedback: (status: string, _amount?: number, paymentRequest?: string) => {
          job.lastUpdate = Date.now();
          if (status !== 'payment-required' || !paymentRequest) {
            return;
          }
          if (paymentState.inFlight || paymentState.paid) {
            logger.warn({ jobEventId, status }, 'duplicate payment-required ignored');
            return;
          }
          paymentState.inFlight = true;
          job.status = 'paying';
          executePaymentFlow({
            client,
            identity,
            wallet,
            network: config.network,
            jobEventId,
            providerPubkey: target.pubkey,
            expectedRecipient: target.address,
            paymentRequestJson: paymentRequest,
            maxPriceLamports: target.priceLamports,
            reservation,
          })
            .then((result) => {
              paymentState.inFlight = false;
              paymentState.paid = true;
              job.txSignature = result.txSignature;
              job.lastUpdate = Date.now();
              if (job.status === 'paying') {
                job.status = 'paid';
              }
              logger.info(
                { jobEventId, tx: result.txSignature, paid: result.paidLamports.toString() },
                'elisym payment confirmed',
              );
            })
            .catch((error: unknown) => {
              paymentState.inFlight = false;
              reservation.release();
              const msg = error instanceof Error ? error.message : String(error);
              job.lastUpdate = Date.now();
              if (job.status === 'paying') {
                job.status = 'error';
                job.errorMessage = msg;
              }
              logger.error({ jobEventId, err: msg }, 'payment flow failed');
            });
        },
        onResult: (content: string) => {
          job.status = 'success';
          job.resultContent = content;
          job.lastUpdate = Date.now();
          logger.info({ jobEventId }, 'elisym job result received');
          runtime
            .createMemory(
              {
                entityId: runtime.agentId,
                agentId: runtime.agentId,
                roomId: message.roomId,
                content: { text: content, source: 'elisym-result' },
                createdAt: Date.now(),
              },
              'elisym_results',
              false,
            )
            .catch((error: unknown) =>
              logger.warn({ err: error, jobEventId }, 'failed to persist elisym result'),
            );
        },
        onError: (errorMessage: string) => {
          if (job.status === 'success' || job.status === 'cancelled') {
            return;
          }
          if (!paymentState.paid) {
            reservation.release();
          }
          job.status = 'error';
          job.errorMessage = errorMessage;
          job.lastUpdate = Date.now();
          logger.warn({ jobEventId, err: errorMessage }, 'elisym job subscription ended');
        },
      },
    });
    job.cleanup = close;

    const summary = `Submitted elisym job ${jobEventId.slice(0, 8)} to ${target.pubkey.slice(0, 8)} (${target.capability}, ${formatLamportsAsSol(target.priceLamports)} SOL). Waiting for result...`;
    await callback?.({ text: summary, source: 'elisym' });
    return { success: true, data: { jobEventId, providerPubkey: target.pubkey } };
  },
  examples: [
    [
      { name: '{{user}}', content: { text: 'Hire the first one to summarize this article' } },
      {
        name: '{{agent}}',
        content: {
          text: 'Submitting a paid elisym job to the selected provider...',
          actions: ['ELISYM_HIRE_AGENT'],
        },
      },
    ],
  ],
};
