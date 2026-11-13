import { useEffect, useRef, useState } from 'react';
import type { ConsoleApi } from './api';
import { type CommandState, commandStateOf } from './orders';

/** How often a queued cycle is read until it finishes. */
const FOLLOW_MS = 2000;

/**
 * Where a followed cycle stands: its state once read (undefined before), or
 * `lost` when it can no longer be read (gone, refused, or an answer this page
 * does not read) - what happened then shows in the store's own reads.
 */
export type FollowedCycle = CommandState | { stage: 'lost' } | undefined;

/**
 * Follows one of the store's cycles (`GET /tenants/:id/cycles/:cycle`) every
 * 2 s until it finishes or is lost, then calls `onFinished` once. An answer
 * not read this time (offline, 429, 5xx) is asked again; nothing is read after
 * the cycle changes or the page lets go of it.
 */
export function useFollowedCycle(
  api: ConsoleApi,
  tenantId: string,
  cycleId: number | undefined,
  onFinished: () => void,
): FollowedCycle {
  const [followed, setFollowed] = useState<{ cycleId: number; state: FollowedCycle }>();
  const finished = useRef(onFinished);
  finished.current = onFinished;

  useEffect(() => {
    if (cycleId === undefined) {
      return;
    }
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      const answer = await api.request('GET', `/tenants/${tenantId}/cycles/${cycleId}`);
      if (!current) {
        return;
      }
      const state = answer.status === 200 ? commandStateOf(answer.body) : undefined;
      if (state !== undefined) {
        setFollowed({ cycleId, state });
        if (state.stage !== 'waiting') {
          finished.current();
          return;
        }
      } else if (
        answer.status === 200 ||
        (answer.status >= 400 && answer.status < 500 && answer.status !== 429)
      ) {
        // An answer that will not change by asking again.
        setFollowed({ cycleId, state: { stage: 'lost' } });
        finished.current();
        return;
      }
      // Not finished, or not read this time (offline, busy): read again.
      timer = setTimeout(() => void read(), FOLLOW_MS);
    };
    void read();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [api, tenantId, cycleId]);

  return followed !== undefined && followed.cycleId === cycleId ? followed.state : undefined;
}
