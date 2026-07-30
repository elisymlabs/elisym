import { assetKey, resolveKnownAsset, type Job, type JobStatus } from '@elisym/sdk';
import { isTerminalJobStatus, type StoredJob } from '~/lib/jobHistory';

export type JobRowSource = 'local' | 'merged' | 'nostr-only';

export interface JobRowData {
  jobEventId: string;
  source: JobRowSource;
  agentPubkey?: string;
  agentName?: string;
  agentPicture?: string;
  capability?: string;
  /** Local status vocabulary (relay values folded via RELAY_STATUS_TO_LOCAL). */
  status: string;
  /** Raw subunits + SDK assetKey - present together or not at all (decision 8). */
  paymentAmount?: number;
  assetKey?: string;
  txHash?: string;
  /** Unix seconds (local `createdAt` ms are normalized). */
  timestampSecs: number;
  unseen: boolean;
}

/**
 * Total mapping of the SDK `JobStatus` vocabulary into the local one the
 * status chip renders - the `Record<JobStatus, _>` type keeps it total when
 * the SDK grows a value.
 */
export const RELAY_STATUS_TO_LOCAL: Record<JobStatus, string> = {
  success: 'completed',
  error: 'error',
  processing: 'pending',
  'payment-required': 'submitted',
  'payment-completed': 'payment-completed',
  partial: 'pending',
  unknown: 'submitted',
};

/**
 * Merged-row status precedence, asymmetric by direction: relay `success`
 * (it exists only when a result event was observed) wins over any local
 * status; relay `error` (feedback-derived - the result event may simply have
 * been missed or expired) wins only over a local NON-terminal status; a
 * non-terminal relay status never overrides the local one (it would mask
 * client-side terminal errors Nostr never sees).
 */
function mergedStatus(localStatus: string, relayStatus: JobStatus): string {
  if (relayStatus === 'success') {
    return 'completed';
  }
  if (relayStatus === 'error' && !isTerminalJobStatus(localStatus)) {
    return 'error';
  }
  return localStatus;
}

/** Decision 8: an amount renders only when the asset is known alongside it. */
function localAmountFields(local: StoredJob): Pick<JobRowData, 'paymentAmount' | 'assetKey'> {
  if (
    local.assetKey !== undefined &&
    local.paymentAmount !== undefined &&
    local.paymentAmount > 0
  ) {
    return { paymentAmount: local.paymentAmount, assetKey: local.assetKey };
  }
  return {};
}

/**
 * Decision 8 for relay rows: `Job.asset` undefined is ambiguous between
 * "native SOL" and "payment-required feedback not observed", so an amount
 * renders only on an explicit, known asset.
 */
function relayAmountFields(job: Job): Pick<JobRowData, 'paymentAmount' | 'assetKey'> {
  if (!job.asset || job.amount === undefined || job.amount <= 0) {
    return {};
  }
  const known = resolveKnownAsset(job.asset.chain, job.asset.token, job.asset.mint);
  if (!known) {
    return {};
  }
  return { paymentAmount: job.amount, assetKey: assetKey(known) };
}

/**
 * The /jobs page is an index, not a reader: rows carry status and metadata
 * only - results are read on the agent's Chat tab, which hydrates and
 * reconciles them from the relays in conversation context.
 */
export function buildJobRows(localJobs: StoredJob[], relayJobs: Job[]): JobRowData[] {
  const relayById = new Map(relayJobs.map((job) => [job.eventId, job]));
  const rows: JobRowData[] = [];

  for (const local of localJobs) {
    const relay = relayById.get(local.jobEventId);
    rows.push({
      jobEventId: local.jobEventId,
      source: relay ? 'merged' : 'local',
      agentPubkey: local.agentPubkey,
      agentName: local.agentName,
      agentPicture: local.agentPicture,
      capability: local.capability,
      status: relay ? mergedStatus(local.status, relay.status) : local.status,
      ...localAmountFields(local),
      txHash: local.txHash ?? relay?.txHash,
      timestampSecs: Math.floor(local.createdAt / 1000),
      unseen: local.unseen === true,
    });
  }

  const localIds = new Set(localJobs.map((local) => local.jobEventId));
  for (const relay of relayJobs) {
    if (localIds.has(relay.eventId)) {
      continue;
    }
    rows.push({
      jobEventId: relay.eventId,
      source: 'nostr-only',
      agentPubkey: relay.agentPubkey,
      capability: relay.capability,
      status: RELAY_STATUS_TO_LOCAL[relay.status],
      ...relayAmountFields(relay),
      txHash: relay.txHash,
      timestampSecs: relay.createdAt,
      unseen: false,
    });
  }

  return rows.sort(
    (left, right) =>
      right.timestampSecs - left.timestampSecs || (left.jobEventId < right.jobEventId ? -1 : 1),
  );
}
