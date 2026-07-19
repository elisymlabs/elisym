import type { FileAttachment } from '@elisym/sdk';
import { useEffect, useRef } from 'react';
import { JOB_WAIT_TIMEOUT_MS } from '~/contexts/BuyContext';
import { useElisymClient } from '~/hooks/useElisymClient';
import { useIdentity } from '~/hooks/useIdentity';
import { recordCompletion, UNPAID_PENDING_MAX_AGE_MS } from '~/lib/chatSession';
import { agePendingEntries, completeEntry, readThread } from '~/lib/chatThread';
import { decodeResult, resultDisplay } from '~/lib/fileResult';

/**
 * Tab-open reconcile (stage 2): when the Chat tab opens, run a one-shot
 * `queryJobResults` for the current identity's still-`pending` entries -
 * author-bound to the agent pubkey (forged-6100 protection, same as every
 * sibling call site) - completing what resolved, then age unpaid pending
 * entries past 24h to `failed` (paid entries stay `pending`: money was sent,
 * the state must stay visible). Entries still pending and inside the 600s
 * result window get a re-subscription for the remainder of the window.
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
      const pendingEntries = thread.filter(
        (entry) => entry.status === 'pending' && entry.customerPubkey === identity.publicKey,
      );

      if (pendingEntries.length > 0) {
        try {
          const resultsByJob = await client.marketplace.queryJobResults(
            identity,
            pendingEntries.map((entry) => entry.jobEventId),
            undefined,
            agentPubkey,
          );
          for (const entry of pendingEntries) {
            if (cancelled) {
              return;
            }
            const res = resultsByJob.get(entry.jobEventId);
            // Skip missing or undecryptable results (the latter surfaces as
            // empty content + decryptionFailed), like the live subscription.
            if (!res || res.decryptionFailed || !res.content) {
              continue;
            }
            const decoded = decodeResult(res.content);
            await completeReconciled(
              entry.jobEventId,
              entry.sessionId,
              resultDisplay(decoded),
              decoded.attachments,
            );
          }
        } catch {
          // transient relay error - the next tab open / hydration retries
        }
      }

      await agePendingEntries(agentPubkey, UNPAID_PENDING_MAX_AGE_MS);
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

    void reconcile();
    return () => {
      cancelled = true;
      for (const cleanup of subscriptionCleanups) {
        cleanup();
      }
    };
  }, [agentPubkey, identity, identityLoading, client]);
}
