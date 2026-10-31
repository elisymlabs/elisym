/**
 * The store as cloud-api keeps it (`GET /tenants/:id/store`), read for the
 * console's setup panels: once on mount, again after any save (`reload`),
 * every few seconds while an edit waits to be kept, and after a failed read
 * that may come right by itself. Only the newest read counts.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConsoleApi } from './api';
import { explain, explainAnswer } from './errors';
import { type StoreRead, storeReadOf } from './settings';

/** While an edit waits to be kept (or a read may recover), the store is read again this often. */
export const PENDING_POLL_MS = 2000;

export interface KeptStore {
  /** The latest store read that succeeded; undefined before the first. */
  read: StoreRead | undefined;
  /** Why the latest read failed; empty when it did not. */
  readError: string;
  /** Whether that failure may come right by itself (unreachable, 5xx, 429): only then is it read again. */
  readRecovers: boolean;
  /** Read again now (after a save); gives the read's number, which `readSeq` reaches once it landed. */
  reload: () => number;
  /** The number of the read `read` came from (reads are numbered as they are asked for). */
  readSeq: number;
}

export function useKeptStore(api: ConsoleApi, tenantId: string): KeptStore {
  const [read, setRead] = useState<StoreRead | undefined>(undefined);
  const [readSeq, setReadSeq] = useState(0);
  const [readError, setReadError] = useState('');
  const [readRecovers, setReadRecovers] = useState(false);
  // Reads that came back (each one, failed or not): the poll goes on after a failed read too.
  const [reads, setReads] = useState(0);
  const latest = useRef(0);

  const load = useCallback(async () => {
    latest.current += 1;
    const asked = latest.current;
    const answer = await api.request('GET', `/tenants/${tenantId}/store`);
    if (asked !== latest.current) {
      return;
    }
    setReads((count) => count + 1);
    const store = answer.status === 200 ? storeReadOf(answer.body) : undefined;
    if (store === undefined) {
      setReadRecovers(answer.status === 0 || answer.status === 429 || answer.status >= 500);
      setReadError(
        answer.status === 200 ? explain(undefined, 200) : explainAnswer(answer.body, answer.status),
      );
      return;
    }
    setReadError('');
    setRead(store);
    setReadSeq(asked);
  }, [api, tenantId]);

  useEffect(() => {
    void load();
    return () => {
      latest.current += 1;
    };
  }, [load]);

  // An edit waiting, or a setup still to run (a launch, a Resume): read again until it ran.
  const waiting = read?.pending === true || read?.publishing === true;
  // A failed read decides alone: a pending edit seen before it says nothing of a store gone since.
  const retry = readError === '' ? waiting : readRecovers;
  useEffect(() => {
    if (!retry) {
      return;
    }
    const timer = setTimeout(() => void load(), PENDING_POLL_MS);
    return () => clearTimeout(timer);
  }, [retry, reads, load]);

  const reload = useCallback(() => {
    // The read is numbered before its answer is awaited: the number is known at once.
    void load();
    return latest.current;
  }, [load]);
  return { read, readError, readRecovers, reload, readSeq };
}
