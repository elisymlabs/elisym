import { useEffect, useState, useSyncExternalStore } from 'react';
import type { SessionCandidate } from '~/lib/chatSession';
import {
  chatThreadVersion,
  readThread,
  subscribeChatThread,
  type ChatThreadEntry,
} from '~/lib/chatThread';

/**
 * Per-tab snapshot of one agent's thread: subscribes to the store's version
 * counter and re-reads the IDB-backed list on every write, whichever writer
 * (BuyContext, hydration, reconcile, purge) performed it. Another tab's
 * writes surface through this tab's own hydration/reconcile cycles - cross-tab
 * live re-render is explicitly not promised (per the stage-2 design).
 */
export function useChatThread(agentPubkey: string): {
  entries: ChatThreadEntry[];
  loaded: boolean;
} {
  const version = useSyncExternalStore(subscribeChatThread, chatThreadVersion);
  const [snapshot, setSnapshot] = useState<{
    agentPubkey: string;
    entries: ChatThreadEntry[];
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const entries = await readThread(agentPubkey);
      if (!cancelled) {
        setSnapshot({ agentPubkey, entries });
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [agentPubkey, version]);

  const loaded = snapshot !== null && snapshot.agentPubkey === agentPubkey;
  return { entries: loaded ? snapshot.entries : [], loaded };
}

/**
 * The thread renders only entries stamped with the current identity: the
 * store is agent-keyed and survives identity switches, so without the filter
 * the next identity would see the previous identity's decrypted transcript.
 */
export function identityThreadEntries(
  entries: ChatThreadEntry[],
  identityPubkey: string,
): ChatThreadEntry[] {
  return entries
    .filter((entry) => entry.customerPubkey === identityPubkey)
    .sort((left, right) => left.ts - right.ts);
}

/**
 * Adoption/repair/divergence candidates: identity-scoped, UUID-carrying
 * entries only (`null` one-shot markers and absent hydrated one-shots never
 * qualify). Scoping here is load-bearing - adopting a foreign identity's
 * session id would target an empty provider-side namespace.
 */
export function sessionCandidatesOf(
  entries: ChatThreadEntry[],
  identityPubkey: string,
): SessionCandidate[] {
  const candidates: SessionCandidate[] = [];
  for (const entry of entries) {
    if (entry.customerPubkey !== identityPubkey || typeof entry.sessionId !== 'string') {
      continue;
    }
    candidates.push({ sessionId: entry.sessionId, ts: entry.ts });
  }
  return candidates;
}
