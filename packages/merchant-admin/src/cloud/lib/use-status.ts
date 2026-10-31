/**
 * The store's status (`GET /tenants/:id/status`) as a guided step polls it:
 * every 5 s for up to 2 min after the step asked (`watch`), then it stops and
 * offers "Check again" (`expired`). Only the newest answer counts, and none
 * after the step left the page.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConsoleApi } from './api';
import { explain, explainAnswer } from './errors';
import { type StatusRead, statusReadOf } from './status';

export const STATUS_POLL_MS = 5000;
export const STATUS_WATCH_MS = 2 * 60 * 1000;

export interface StoreStatusPoll {
  /** The latest status read that succeeded; undefined before the first. */
  status: StatusRead | undefined;
  /** Why the latest read failed; empty when it did not. */
  error: string;
  /** The poll ran its 2 minutes out: the step offers "Check again". */
  expired: boolean;
  /** The number of the read `status` came from (reads are numbered as they are asked for). */
  statusSeq: number;
  /**
   * Read now, and poll again for 2 minutes (after a save, or "Check again"):
   * gives the read's number, which `statusSeq` reaches once it landed.
   */
  watch: () => number;
}

export function useStatus(
  api: ConsoleApi,
  tenantId: string,
  /** The page's clock in ms (a test's own). */
  nowMs: () => number = Date.now,
): StoreStatusPoll {
  const [status, setStatus] = useState<StatusRead | undefined>(undefined);
  const [statusSeq, setStatusSeq] = useState(0);
  const [error, setError] = useState('');
  // The clock as a ref: a new function each render never restarts the poll.
  const clock = useRef(nowMs);
  clock.current = nowMs;
  const [watchedFrom, setWatchedFrom] = useState(() => nowMs());
  const [reads, setReads] = useState(0);
  const [expired, setExpired] = useState(false);
  const latest = useRef(0);

  const load = useCallback(async () => {
    latest.current += 1;
    const asked = latest.current;
    const answer = await api.request('GET', `/tenants/${tenantId}/status`);
    if (asked !== latest.current) {
      return;
    }
    setReads((count) => count + 1);
    const read = answer.status === 200 ? statusReadOf(answer.body) : undefined;
    if (read === undefined) {
      setError(
        answer.status === 200 ? explain(undefined, 200) : explainAnswer(answer.body, answer.status),
      );
      return;
    }
    setError('');
    setStatus(read);
    setStatusSeq(asked);
  }, [api, tenantId]);

  useEffect(() => {
    void load();
    return () => {
      latest.current += 1;
    };
  }, [load]);

  useEffect(() => {
    if (expired) {
      return;
    }
    const timer = setTimeout(() => {
      if (clock.current() - watchedFrom >= STATUS_WATCH_MS) {
        setExpired(true);
        return;
      }
      void load();
    }, STATUS_POLL_MS);
    return () => clearTimeout(timer);
  }, [expired, reads, watchedFrom, load]);

  const watch = useCallback(() => {
    setWatchedFrom(clock.current());
    setExpired(false);
    // The read is numbered before its answer is awaited: the number is known at once.
    void load();
    return latest.current;
  }, [load]);

  return { status, error, expired, statusSeq, watch };
}
