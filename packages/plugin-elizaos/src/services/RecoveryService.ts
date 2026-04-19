import type { ElisymClient, ElisymIdentity, PaymentRequestData } from '@elisym/sdk';
import {
  createRecoveryLoop,
  type JobLedgerAdapter,
  type JobLedgerEntry,
  type RecoveryLoop,
} from '@elisym/sdk/runtime';
import { Service, type IAgentRuntime, type ServiceTypeName } from '@elizaos/core';
import type { Event } from 'nostr-tools';
import {
  JOB_LEDGER_RETENTION_MS,
  RECOVERY_CONCURRENCY,
  RECOVERY_INTERVAL_MS,
  RECOVERY_MAX_RETRIES,
  SERVICE_TYPES,
} from '../constants';
import { createElizaMemoryAdapter, recordTransition } from '../lib/jobLedger';
import { logger } from '../lib/logger';
import { fetchProtocolConfig, paymentStrategyInstance } from '../lib/paymentStrategy';
import { getState } from '../state';
import type { ElisymService } from './ElisymService';
import type { WalletService } from './WalletService';

async function awaitService<T>(runtime: IAgentRuntime, type: string): Promise<T> {
  const instance = await runtime.getServiceLoadPromise(type as ServiceTypeName);
  return instance as T;
}

export class RecoveryService extends Service {
  static override serviceType = SERVICE_TYPES.RECOVERY;

  override capabilityDescription =
    'Resumes elisym jobs interrupted by a crash by replaying the JobLedger';

  private loop?: RecoveryLoop;
  private adapter?: JobLedgerAdapter;
  private elisym?: ElisymService;
  private wallet?: WalletService;

  static override async start(runtime: IAgentRuntime): Promise<RecoveryService> {
    const service = new RecoveryService(runtime);
    await service.initialize();
    return service;
  }

  private async initialize(): Promise<void> {
    this.elisym = await awaitService<ElisymService>(this.runtime, SERVICE_TYPES.ELISYM);
    this.wallet = await awaitService<WalletService>(this.runtime, SERVICE_TYPES.WALLET);
    this.adapter = createElizaMemoryAdapter(this.runtime);

    this.loop = createRecoveryLoop({
      adapter: this.adapter,
      intervalMs: RECOVERY_INTERVAL_MS,
      retentionMs: JOB_LEDGER_RETENTION_MS,
      concurrency: RECOVERY_CONCURRENCY,
      logger,
      onProviderPending: (entry) => this.recoverProviderJob(entry),
    });
    this.loop.start();
  }

  override async stop(): Promise<void> {
    this.loop?.stop();
    this.loop = undefined;
  }

  /**
   * Run a single sweep on demand. Used by integration tests to drive the
   * recovery pipeline without waiting for the periodic timer. Builds a
   * one-shot loop when `initialize()` has not been called (as in unit-
   * test harnesses that new-up the service and inject stubs) so the
   * configured concurrency ceiling still applies.
   */
  async sweepOnce(): Promise<void> {
    if (this.loop) {
      await this.loop.sweepOnce();
      return;
    }
    const adapter = this.adapter ?? createElizaMemoryAdapter(this.runtime);
    const oneShot = createRecoveryLoop({
      adapter,
      intervalMs: RECOVERY_INTERVAL_MS,
      retentionMs: JOB_LEDGER_RETENTION_MS,
      concurrency: RECOVERY_CONCURRENCY,
      logger,
      onProviderPending: (entry) => this.recoverProviderJob(entry),
    });
    await oneShot.sweepOnce();
  }

  private async markFailed(entry: JobLedgerEntry, reason: string): Promise<void> {
    await recordTransition(this.runtime, {
      ...entry,
      state: 'failed',
      error: reason,
      retryCount: (entry.retryCount ?? 0) + 1,
    });
  }

  private checkRetryBudget(entry: JobLedgerEntry): boolean {
    if ((entry.retryCount ?? 0) >= RECOVERY_MAX_RETRIES) {
      return false;
    }
    return true;
  }

  async recoverProviderJob(entry: JobLedgerEntry): Promise<void> {
    if (!this.checkRetryBudget(entry)) {
      await this.markFailed(entry, 'Recovery retry budget exhausted');
      return;
    }
    if (!this.elisym || !this.wallet) {
      return;
    }
    const client = this.elisym.getClient();
    const identity = this.elisym.getIdentity();

    switch (entry.state) {
      case 'waiting_payment':
        await this.recoverWaitingPayment(client, identity, entry);
        return;
      case 'paid':
      case 'executed':
        await this.recoverPaidOrExecuted(client, identity, entry);
        return;
      default:
        return;
    }
  }

  private async recoverWaitingPayment(
    client: ElisymClient,
    identity: ElisymIdentity,
    entry: JobLedgerEntry,
  ): Promise<void> {
    if (!this.wallet || !entry.paymentRequestJson || !entry.rawEventJson) {
      return;
    }
    let paymentData: PaymentRequestData;
    try {
      paymentData = JSON.parse(entry.paymentRequestJson) as PaymentRequestData;
    } catch {
      await this.markFailed(entry, 'paymentRequestJson malformed during recovery');
      return;
    }

    const { config } = getState(this.runtime);
    const protocolConfig = await fetchProtocolConfig(this.wallet.rpc, config.network).catch(
      () => null,
    );
    if (!protocolConfig) {
      return;
    }

    const verify = await paymentStrategyInstance()
      .verifyPayment(this.wallet.rpc, paymentData, protocolConfig, { retries: 1, intervalMs: 0 })
      .catch(() => ({ verified: false, txSignature: undefined }) as const);

    if (!verify.verified || !verify.txSignature) {
      // Still waiting. Mark failed only if the job itself is older than ~5
      // minutes - that gives customers a graceful window to send the tx.
      const ageMs = Date.now() - entry.jobCreatedAt;
      if (ageMs > 5 * 60 * 1000) {
        await this.markFailed(entry, 'No payment observed after grace window');
      }
      return;
    }

    logger.info(
      { jobEventId: entry.jobEventId, tx: verify.txSignature },
      'recovery: waiting_payment -> paid',
    );
    await recordTransition(this.runtime, {
      ...entry,
      state: 'paid',
      txSignature: verify.txSignature,
    });

    await this.continueToDelivery(client, identity, {
      ...entry,
      state: 'paid',
      txSignature: verify.txSignature,
    });
  }

  private async recoverPaidOrExecuted(
    client: ElisymClient,
    identity: ElisymIdentity,
    entry: JobLedgerEntry,
  ): Promise<void> {
    await this.continueToDelivery(client, identity, entry);
  }

  private async continueToDelivery(
    client: ElisymClient,
    identity: ElisymIdentity,
    entry: JobLedgerEntry,
  ): Promise<void> {
    if (!entry.rawEventJson) {
      await this.markFailed(entry, 'rawEventJson missing; cannot replay delivery');
      return;
    }
    let event: Event;
    try {
      event = JSON.parse(entry.rawEventJson) as Event;
    } catch {
      await this.markFailed(entry, 'rawEventJson malformed during recovery');
      return;
    }
    const amount = Number(entry.priceLamports);

    let resultContent = entry.resultContent;
    if (!resultContent) {
      resultContent = await this.reExecute(entry, event);
      if (!resultContent) {
        return;
      }
      await recordTransition(this.runtime, {
        ...entry,
        state: 'executed',
        resultContent,
      });
    }

    try {
      await client.marketplace.submitJobResultWithRetry(identity, event, resultContent, amount);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await recordTransition(this.runtime, {
        ...entry,
        state: entry.state,
        resultContent,
        error: message,
        retryCount: (entry.retryCount ?? 0) + 1,
      });
      return;
    }
    logger.info(
      { jobEventId: entry.jobEventId, capability: entry.capability },
      'recovery: delivered result',
    );
    await recordTransition(this.runtime, {
      ...entry,
      state: 'delivered',
      resultContent,
    });
  }

  private async reExecute(entry: JobLedgerEntry, event: Event): Promise<string | undefined> {
    // Lazy import to avoid a circular dep between handler and service.
    const { ModelType } = await import('@elizaos/core');
    const state = getState(this.runtime);
    const { config } = state;
    const mapped = config.providerActionMap?.[entry.capability];
    try {
      if (mapped) {
        const action = this.runtime.actions.find((candidate) => candidate.name === mapped);
        if (!action) {
          await this.markFailed(entry, `Configured action "${mapped}" not found on runtime`);
          return undefined;
        }
        const collected: string[] = [];
        await action.handler(
          this.runtime,
          {
            entityId: this.runtime.agentId,
            agentId: this.runtime.agentId,
            roomId: this.runtime.agentId,
            content: { text: event.content, source: 'elisym-incoming' },
            createdAt: Date.now(),
          },
          undefined,
          { capability: entry.capability, input: event.content },
          async (response) => {
            if (typeof response.text === 'string' && response.text.length > 0) {
              collected.push(response.text);
            }
            return [];
          },
        );
        if (collected.length === 0) {
          await this.markFailed(entry, `Action "${mapped}" produced no text output`);
          return undefined;
        }
        return collected.join('\n');
      }

      const skill = state.skills?.findByCapability(entry.capability);
      if (skill) {
        if (!state.skillLlm) {
          await this.markFailed(
            entry,
            'Skill matched during recovery but no LLM client is configured (ANTHROPIC_API_KEY missing)',
          );
          return undefined;
        }
        const controller = new AbortController();
        const poll = setInterval(() => {
          if (state.shuttingDown) {
            controller.abort();
          }
        }, 500);
        try {
          const result = await skill.execute(
            {
              data: event.content,
              inputType: 'text/plain',
              tags: [entry.capability],
              jobId: entry.jobEventId,
            },
            {
              llm: state.skillLlm,
              agentName: this.runtime.character?.name ?? 'elisym-provider',
              agentDescription: entry.capability,
              signal: controller.signal,
            },
          );
          return result.data;
        } finally {
          clearInterval(poll);
        }
      }

      const systemPrompt =
        this.runtime.character?.system ?? 'You are a helpful elisym provider agent.';
      const prompt = `${systemPrompt}\n\nTask (${entry.capability}): ${event.content}`;
      const output = await this.runtime.useModel(ModelType.TEXT_SMALL, { prompt });
      return typeof output === 'string' ? output : JSON.stringify(output);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await recordTransition(this.runtime, {
        ...entry,
        error: message,
        retryCount: (entry.retryCount ?? 0) + 1,
      });
      return undefined;
    }
  }
}
