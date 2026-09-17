import { classifyJobError, refusalFromJobError, type FileAttachment } from '@elisym/sdk';
import { useEffect, useRef } from 'react';
import { JOB_WAIT_TIMEOUT_MS } from '~/contexts/BuyContext';
import { useElisymClient } from '~/hooks/useElisymClient';
import { useIdentity } from '~/hooks/useIdentity';
import { recordCompletion, UNPAID_PENDING_MAX_AGE_MS } from '~/lib/chatSession';
import { agePendingEntries, completeEntry, failEntry, readThread } from '~/lib/chatThread';
import { decodeResult, resultDisplay } from '~/lib/fileResult';

/**
 * Tab-open reconcile (stage 2): when the Chat tab opens, run a one-shot
 * `queryJobResults` for the current identity's still-`pending` entries -
 * author-bound to the agent pubkey (forged-6100 protection, same as every
 * sibling call site) - completing what resolved and closing what the agent
 * refused (`queryJobErrors`, same binding), then age unpaid pending entries
 * past 24h to `failed` (paid entries stay `pending`: money was sent, the state
 * must stay visible). Entries still pending and inside the 600s result window
 * get a re-subscription for the remainder of the window.
 *
 * Wallet-independent by design: everything runs off the Nostr identity, so
 * free-skill chats recover too. Runs once per Chat tab activation.
 */
export function useChatReconcile(agentPubkey: string): void {
  const { client } = useElisymClient();
  const idCtx = useIdentity();
  const identity = idCtx.identity;
  const identityLoading = idCtx.loading;
  const ranForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!agentPubkey || identityLoading) {
      return;
    }
    const runKey = `${agentPubkey}:${identity.publicKey}`;
    if (ranForRef.current === runKey) {
      return;
    }
    ranForRef.current = runKey;

    let cancelled = false;
    const subscriptionCleanups: Array<() => void> = [];

    const completeReconciled = async (
      jobEventId: string,
      entrySessionId: string | null | undefined,
      resultText: string,
      attachments: FileAttachment[],
    ) => {
      const fired = await completeEntry(agentPubkey, jobEventId, {
        result: resultText,
        ...(attachments.length > 0 ? { resultAttachments: attachments } : {}),
      });
      // `completedCount` bumps are keyed to the transition actually firing -
      // a live completion and this reconcile racing on the same id bump once.
      if (fired && typeof entrySessionId === 'string') {
        await recordCompletion(identity.publicKey, agentPubkey, entrySessionId);
      }
    };

    const reconcile = async () => {
      const thread = await readThread(agentPubkey);
      const mine = thread.filter((entry) => entry.customerPubkey === identity.publicKey);
      const pendingEntries = mine.filter((entry) => entry.status === 'pending');
      // A refusal can arrive AFTER the entry was already closed: the wait
      // window expired, or ageing flipped it. Without its reason that bubble
      // offers Retry, which buys a deterministic refusal again at full price -
      // so recent failures with no reason yet are asked about too. Bounded to
      // the ageing window: older than that, nobody is still deciding.
      const unexplained = mine.filter(
        (entry) =>
          entry.status === 'failed' &&
          entry.refusal === undefined &&
          Date.now() - entry.ts < UNPAID_PENDING_MAX_AGE_MS,
      );

      let queryFailed = false;
      if (pendingEntries.length > 0 || unexplained.length > 0) {
        const jobIds = pendingEntries.map((entry) => entry.jobEventId);
        const askAbout = [...jobIds, ...unexplained.map((entry) => entry.jobEventId)];
        // The refusal query runs alongside, never instead: a provider that
        // errored and then delivered anyway (crash-recovery re-execution) has a
        // result, and a result outranks the error that preceded it.
        const [results, errors] = await Promise.all([
          // Results only for the OPEN ones; a closed entry is not waiting for
          // one. The refusal query covers both.
          jobIds.length === 0
            ? Promise.resolve(new Map())
            : client.marketplace
                .queryJobResults(identity, jobIds, undefined, agentPubkey)
                .catch(() => null),
          client.marketplace.queryJobErrors(askAbout, agentPubkey).catch(() => null),
        ]);
        // transient relay error - the next tab open / hydration retries
        queryFailed = results === null;
        // And nothing is applied at all when it failed: no entry can be
        // completed, and a refusal must not close a job whose answer the failed
        // half never fetched.
        //
        // One entry's IndexedDB write failing (quota, a blocked private window,
        // an aborted transaction) must not cost every OTHER entry its
        // re-subscription below either: without the `catch` the rejection
        // escapes a bare `void reconcile()` and the open tab silently stops
        // receiving live results for the rest of the session.
        try {
          for (const entry of results === null ? [] : pendingEntries) {
            if (cancelled) {
              return;
            }
            const res = results?.get(entry.jobEventId);
            if (res !== undefined) {
              // An undecryptable result (empty content + decryptionFailed, as
              // the live subscription sees it) is still a DELIVERED one, so the
              // entry stays pending and nothing below may close it as refused:
              // the provider answered, and a customer told "the agent refused"
              // for a job with an answer on the relays has no way back.
              if (res.decryptionFailed || !res.content) {
                continue;
              }
              const decoded = decodeResult(res.content);
              await completeReconciled(
                entry.jobEventId,
                entry.sessionId,
                resultDisplay(decoded),
                decoded.attachments,
              );
              continue;
            }
            // ONLY a refusal closes an entry from here. It is the one verdict
            // that is terminal and deterministic, and this is the only path
            // that reaches a refusal published while the tab was closed -
            // including one past the 600s window, which is re-subscribed to by
            // nothing. Every other error is left alone on purpose: an outage or
            // a transient failure must not demote a PAID pending entry whose
            // job the provider's recovery loop may still deliver.
            //
            // A result outranks the error that preceded it, which is why the
            // loop is skipped entirely above when the result query failed: a
            // relay that answered one query and not the other proved nothing,
            // and closing the entry on the half that did answer would withdraw
            // the Retry button from a paid job whose answer sits on a relay,
            // unread.
            const message = errors?.get(entry.jobEventId);
            if (message !== undefined && classifyJobError(message) === 'provider-refused') {
              await failEntry(agentPubkey, entry.jobEventId, {
                refusal: refusalFromJobError(message),
              });
            }
          }
          // And the closed ones, which need nothing but the reason. Outside the
          // results loop: a result cannot arrive for an entry that is already
          // `failed` - `completeEntry` is what would have cleared it.
          for (const entry of unexplained) {
            if (cancelled) {
              return;
            }
            const late = errors?.get(entry.jobEventId);
            if (late !== undefined && classifyJobError(late) === 'provider-refused') {
              await failEntry(agentPubkey, entry.jobEventId, {
                refusal: refusalFromJobError(late),
              });
            }
          }
        } catch {
          // Nothing was proven about the entries this loop never reached, so
          // ageing must not run either.
          queryFailed = true;
        }
      }

      // Aging requires the "found no result" precondition: a failed query
      // proved nothing, so a >24h entry whose result sits on an unreachable
      // relay must not flip to failed. Scoped to this identity - other
      // identities' jobs were never queried here.
      if (!queryFailed) {
        await agePendingEntries(agentPubkey, UNPAID_PENDING_MAX_AGE_MS, identity.publicKey);
      }
      if (cancelled) {
        return;
      }

      // Re-subscribe for pending entries still inside the result window so a
      // result landing after the one-shot query is delivered live.
      const now = Date.now();
      const fresh = await readThread(agentPubkey);
      // The effect cleanup may have run during the await - it already drained
      // `subscriptionCleanups`, so subscriptions created past this point would
      // leak until their own timeout.
      if (cancelled) {
        return;
      }
      for (const entry of fresh) {
        if (entry.status !== 'pending' || entry.customerPubkey !== identity.publicKey) {
          continue;
        }
        const elapsed = now - entry.ts;
        if (elapsed < 0 || elapsed >= JOB_WAIT_TIMEOUT_MS) {
          continue;
        }
        const entrySessionId = entry.sessionId;
        const cleanup = client.marketplace.subscribeToJobUpdates({
          jobEventId: entry.jobEventId,
          providerPubkey: agentPubkey,
          customerPublicKey: identity.publicKey,
          callbacks: {
            onResult: (
              content: string,
              _eventId: string,
              _attachment?: FileAttachment,
              attachments?: FileAttachment[],
            ) => {
              // The subscription already decoded the envelope - do not re-decode.
              const resultAttachments = attachments ?? [];
              const resultText = resultDisplay({
                text: content || undefined,
                attachments: resultAttachments,
              });
              void completeReconciled(
                entry.jobEventId,
                entrySessionId,
                resultText,
                resultAttachments,
              );
            },
            onError: (message: string) => {
              // A refusal published from here on, while the tab stays open.
              // Everything already on the relays was handled by the query
              // above - and must not be replayed into this subscription,
              // whose `since` is therefore left at its 30-second default: the
              // SDK closes the result subscriptions along with the first error
              // it sees, so a stale one would cost the customer the result
              // that came after it.
              //
              // Every other error is left alone on purpose: an outage, a
              // transient failure, or the SDK's own wait-window timeout (which
              // arrives here when no `onTimeout` is given) must not demote a
              // PAID pending entry, whose job the recovery loop may still
              // deliver.
              if (classifyJobError(message) !== 'provider-refused') {
                return;
              }
              // `.catch`, because a storage failure here (private window,
              // quota, a hidden tab's aborted transaction) would
              // otherwise escape as an unhandled rejection - this handler has
              // no caller to await it.
              void failEntry(agentPubkey, entry.jobEventId, {
                refusal: refusalFromJobError(message),
              }).catch(() => {});
            },
          },
          timeoutMs: JOB_WAIT_TIMEOUT_MS - elapsed,
          customerSecretKey: identity.secretKey,
        });
        // Same race, narrower window: self-destruct instead of pushing into a
        // list the effect cleanup will never visit again.
        if (cancelled) {
          cleanup();
          return;
        }
        subscriptionCleanups.push(cleanup);
      }
    };

    // Nothing here is worth an unhandled rejection: a reconcile that fails
    // outright leaves the thread exactly as it found it, and hydration or the
    // next tab open tries again.
    void reconcile().catch(() => {});
    return () => {
      cancelled = true;
      for (const cleanup of subscriptionCleanups) {
        cleanup();
      }
    };
  }, [agentPubkey, identity, identityLoading, client]);
}
