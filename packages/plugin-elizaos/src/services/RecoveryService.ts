import {
  DEFAULT_KIND_OFFSET,
  type ElisymClient,
  type ElisymIdentity,
  type PaymentRequestData,
} from '@elisym/sdk';
import { Service, type IAgentRuntime, type ServiceTypeName } from '@elizaos/core';
import type { Event } from 'nostr-tools';
import {
  RECOVERY_CONCURRENCY,
  RECOVERY_INTERVAL_MS,
  RECOVERY_MAX_RETRIES,
  SERVICE_TYPES,
} from '../constants';
import { fetchProtocolConfig, paymentStrategyInstance } from '../handlers/customerJobFlow';
import {
  pendingJobs,
  pruneOldEntries,
  recordTransition,
  type JobLedgerEntry,
} from '../lib/jobLedger';
import { logger } from '../lib/logger';
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

  private sweepTimer?: ReturnType<typeof setInterval>;
  private running = false;
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

    // Kick off an initial sweep. Do not await - let it run in background so
    // plugin init returns quickly.
    this.sweepOnce().catch((error) => logger.warn({ err: error }, 'initial recovery sweep failed'));
    this.sweepTimer = setInterval(() => {
      this.sweepOnce().catch((error) => logger.warn({ err: error }, 'recovery sweep failed'));
    }, RECOVERY_INTERVAL_MS);
  }

  override async stop(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  private async sweepOnce(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      await pruneOldEntries(this.runtime);
      const providerPending = await pendingJobs(this.runtime, 'provider');
      const customerPending = await pendingJobs(this.runtime, 'customer');

      if (providerPending.length === 0 && customerPending.length === 0) {
        return;
      }
      logger.info(
        { provider: providerPending.length, customer: customerPending.length },
        'recovery sweep: resuming pending jobs',
      );

      await this.runBatch(providerPending, (entry) => this.recoverProviderJob(entry));
      await this.runBatch(customerPending, (entry) => this.recoverCustomerJob(entry));
    } finally {
      this.running = false;
    }
  }

  private async runBatch(
    entries: JobLedgerEntry[],
    handler: (entry: JobLedgerEntry) => Promise<void>,
  ): Promise<void> {
    let index = 0;
    const workers = Array.from({ length: Math.min(RECOVERY_CONCURRENCY, entries.length) }, () =>
      (async () => {
        while (index < entries.length) {
          const currentIndex = index++;
          const entry = entries[currentIndex];
          if (!entry) {
            continue;
          }
          try {
            await handler(entry);
          } catch (error) {
            logger.warn(
              { err: error, jobEventId: entry.jobEventId, side: entry.side, state: entry.state },
              'recovery handler threw',
            );
          }
        }
      })(),
    );
    await Promise.all(workers);
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

  private async recoverProviderJob(entry: JobLedgerEntry): Promise<void> {
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
    const { config } = getState(this.runtime);
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

  private async recoverCustomerJob(entry: JobLedgerEntry): Promise<void> {
    if (!this.checkRetryBudget(entry)) {
      await this.markFailed(entry, 'Recovery retry budget exhausted');
      return;
    }
    if (!this.elisym) {
      return;
    }
    // Customer-side recovery only chases the terminal result. States before
    // payment_sent get a retry budget tick and are left for the subscription
    // to resolve; beyond ~3 minutes without progress we give up.
    if (entry.state === 'submitted' || entry.state === 'waiting_payment') {
      const ageMs = Date.now() - entry.jobCreatedAt;
      if (ageMs > 3 * 60 * 1000) {
        await this.markFailed(entry, 'Customer job timed out before payment');
      }
      return;
    }
    if (entry.state !== 'payment_sent') {
      return;
    }
    try {
      const client = this.elisym.getClient();
      const identity = this.elisym.getIdentity();
      const results = await client.marketplace.queryJobResults(
        identity,
        [entry.jobEventId],
        [DEFAULT_KIND_OFFSET],
        entry.providerPubkey,
      );
      const record = results.get(entry.jobEventId);
      if (!record || record.decryptionFailed || !record.content) {
        const ageMs = Date.now() - entry.jobCreatedAt;
        if (ageMs > 10 * 60 * 1000) {
          await this.markFailed(entry, 'Result not observed on relays after 10 minutes');
        }
        return;
      }
      logger.info(
        { jobEventId: entry.jobEventId },
        'recovery: customer payment_sent -> result_received',
      );
      await recordTransition(this.runtime, {
        ...entry,
        state: 'result_received',
        resultContent: record.content,
      });
    } catch (error) {
      logger.debug({ err: error, jobEventId: entry.jobEventId }, 'customer recovery query errored');
    }
  }
}
