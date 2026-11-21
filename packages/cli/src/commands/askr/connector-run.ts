/**
 * A connector's stored sync result (`ConnectorSyncResult`, as the server keeps
 * it), read without trusting its shape: its status string, the over-limit and
 * busy reasons, and the counts of an `ok` run.
 */
import { SYNC_BUSY_MESSAGE } from './constants';

export interface RunSummary {
  status: string;
  reason?: 'too_many_products' | 'sync_busy';
  count?: number;
  max?: number;
  counts?: { created: number; updated: number; hidden: number; unchanged: number };
  httpStatus?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function lengthOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

export function summaryOfRun(result: unknown): RunSummary | null {
  if (!isRecord(result) || typeof result.status !== 'string') {
    return null;
  }
  const summary: RunSummary = { status: result.status };
  if (result.status === 'ok' && isRecord(result.diff)) {
    summary.counts = {
      created: lengthOf(result.diff.created),
      updated: lengthOf(result.diff.updated),
      hidden: lengthOf(result.diff.hidden),
      unchanged: lengthOf(result.diff.unchanged),
    };
  }
  if (result.status === 'error' && result.reason === 'too_many_products') {
    summary.reason = 'too_many_products';
    if (typeof result.count === 'number') {
      summary.count = result.count;
    }
    if (typeof result.max === 'number') {
      summary.max = result.max;
    }
  } else if (result.status === 'error' && result.message === SYNC_BUSY_MESSAGE) {
    summary.reason = 'sync_busy';
  }
  if (typeof result.httpStatus === 'number') {
    summary.httpStatus = result.httpStatus;
  }
  return summary;
}
