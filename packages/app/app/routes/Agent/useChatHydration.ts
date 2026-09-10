import {
  attachmentsOf,
  decodeJobPayload,
  KIND_JOB_FEEDBACK,
  KIND_JOB_REQUEST,
  nip44Decrypt,
  parsePaymentRequest,
  type DecodedJobPayload,
  type ElisymClient,
  type ElisymIdentity,
  type PaymentAssetRef,
} from '@elisym/sdk';
import { useQuery } from '@tanstack/react-query';
import { verifyEvent, type Event as NostrEvent } from 'nostr-tools';
import { useElisymClient } from '~/hooks/useElisymClient';
import { useIdentity } from '~/hooks/useIdentity';
import { readChatSession, recordCompletion, repairMintedSession } from '~/lib/chatSession';
import { mergeHydratedEntry, readThread, type HydratedChatEntry } from '~/lib/chatThread';
import { decodeResult, resultDisplay } from '~/lib/fileResult';
import { sessionCandidatesOf } from './useChatThread';

const STALE_TIME_MS = 1000 * 30;
const REFETCH_INTERVAL_MS = 1000 * 60;

/**
 * The signature that should block each job's confirm sheet, from the customer's
 * own call reports.
 *
 * Exported and pure because of what it decides: pick the wrong event and the
 * sheet either refuses a retry the customer is entitled to or points them at
 * the wrong transaction to go and check.
 *
 * The author is re-verified rather than trusted to the filter - a relay is
 * bound only by its own honesty - and the NEWEST report wins, because relay
 * order is arbitrary and a job carries more than one whenever a first call
 * failed and a later one was signed. Events without both an `e` anchor and a
 * `call_tx` tag are ignored, which is every rating and payment report.
 *
 * `created_at` is the author's own clock, so "newest" is only as good as it.
 * That is not a hole a provider can reach - every report counted here is one
 * the VIEWER signed, and the check above proves it - but two of the customer's
 * own devices with skewed clocks can order their reports wrongly, and the sheet
 * would then name the older signature as the one to go and check. Both
 * signatures block signing again, so the cost is a confusing pointer rather
 * than a second call. The alternative, trusting relay arrival order, is worse:
 * it is arbitrary between relays.
 */
export function newestCallSignatures(
  reports: readonly NostrEvent[],
  viewerPubkey: string,
): Map<string, string> {
  const signatureByJobId = new Map<string, string>();
  const newestByJobId = new Map<string, number>();
  for (const report of reports) {
    if (!verifyEvent(report) || report.pubkey !== viewerPubkey) {
      continue;
    }
    const jobEventId = report.tags.find((tag) => tag[0] === 'e')?.[1];
    const signature = report.tags.find((tag) => tag[0] === 'call_tx')?.[1];
    if (!jobEventId || !signature) {
      continue;
    }
    const seen = newestByJobId.get(jobEventId);
    if (seen === undefined || report.created_at > seen) {
      newestByJobId.set(jobEventId, report.created_at);
      signatureByJobId.set(jobEventId, signature);
    }
  }
  return signatureByJobId;
}

/**
 * Fetch the viewer's completed jobs with this agent from the relays and decode
 * them into thread entries stamped with the hydrating identity. The 5100
 * envelope decode additionally reads `session.id` (the customer can always
 * decrypt its own payloads), so relay-recovered messages regain their session
 * grouping, dividers, and the adoption source on a new device.
 */
async function fetchHydratedEntries(
  client: ElisymClient,
  identity: ElisymIdentity,
  viewerPubkey: string,
  agentPubkey: string,
): Promise<HydratedChatEntry[]> {
  // Verify: a relay is only bound by its own filter honesty, so drop any request
  // event not actually signed by the viewer before decrypting its content against
  // the viewer's key (mirrors the reconcile / queryJobResults' author filter).
  const requests = (
    (await client.pool.querySync({
      kinds: [KIND_JOB_REQUEST],
      authors: [viewerPubkey],
      '#p': [agentPubkey],
    })) as NostrEvent[]
  ).filter((event) => verifyEvent(event) && event.pubkey === viewerPubkey);

  if (requests.length === 0) {
    return [];
  }

  const requestIds = requests.map((req) => req.id);
  const [resultMap, rawFeedbacks, rawCallReports] = await Promise.all([
    // Author-bound to the agent: forged kind-6100 protection, same as every
    // sibling queryJobResults call site.
    client.marketplace
      .queryJobResults(identity, requestIds, undefined, agentPubkey)
      .catch(() => new Map()),
    client.pool
      .queryBatchedByTag({ kinds: [KIND_JOB_FEEDBACK], authors: [agentPubkey] }, 'e', requestIds)
      .catch(() => [] as NostrEvent[]),
    // The customer's OWN call reports. This browser's IndexedDB is otherwise
    // the only record that a call was signed, so losing it - a re-imported
    // identity, the same nsec on another device, cleared site data - brings the
    // thread back with the envelope intact and no claim, and the sheet offers
    // an already-executed call as fresh. Authored by the viewer, not the agent.
    client.pool
      .queryBatchedByTag({ kinds: [KIND_JOB_FEEDBACK], authors: [viewerPubkey] }, 'e', requestIds)
      .catch(() => [] as NostrEvent[]),
  ]);
  // Same relay-honesty rule as the request query above: drop feedback events
  // not actually signed by the agent before trusting their payment-request tags.
  const feedbacks = (rawFeedbacks as NostrEvent[]).filter(
    (event) => verifyEvent(event) && event.pubkey === agentPubkey,
  );

  const callSignatureByJobId = newestCallSignatures(rawCallReports as NostrEvent[], viewerPubkey);

  const assetByJobId = new Map<string, PaymentAssetRef>();
  for (const feedback of feedbacks) {
    const statusTag = feedback.tags.find((tag) => tag[0] === 'status');
    if (statusTag?.[1] !== 'payment-required') {
      continue;
    }
    const eTag = feedback.tags.find((tag) => tag[0] === 'e');
    const amountTag = feedback.tags.find((tag) => tag[0] === 'amount');
    const requestJson = amountTag?.[2];
    if (!eTag?.[1] || !requestJson || assetByJobId.has(eTag[1])) {
      continue;
    }
    const parsed = parsePaymentRequest(requestJson);
    if (parsed.ok && parsed.data.asset) {
      assetByJobId.set(eTag[1], parsed.data.asset);
    }
  }

  const out: HydratedChatEntry[] = [];
  for (const req of requests) {
    // Hydration only sees completed jobs - result-less requests are skipped.
    // Pending/failed entries exist only locally: they are this device's
    // in-flight state.
    const result = resultMap.get(req.id);
    if (!result || !result.content) {
      continue;
    }

    const capability = req.tags.find((tag) => tag[0] === 't' && tag[1] !== 'elisym')?.[1];

    let prompt: string | undefined;
    let promptAttachment: HydratedChatEntry['promptAttachment'];
    let sessionId: string | undefined;
    const isEncrypted = req.tags.some((tag) => tag[0] === 'encrypted');
    const recipient = req.tags.find((tag) => tag[0] === 'p')?.[1];
    try {
      const plaintext =
        isEncrypted && recipient
          ? nip44Decrypt(req.content, identity.secretKey, recipient)
          : req.content;
      // Decode the input envelope directly (not via decodeResult) so the
      // `session.id` survives alongside the genuine text note and the file
      // attachment. A malformed envelope degrades to raw text.
      let decodedInput: DecodedJobPayload;
      try {
        decodedInput = decodeJobPayload(plaintext);
      } catch {
        decodedInput = { text: plaintext };
      }
      prompt = decodedInput.text?.trim() ? decodedInput.text : undefined;
      promptAttachment = attachmentsOf(decodedInput)[0];
      sessionId = decodedInput.session?.id;
    } catch {
      // decryption failed, leave prompt/promptAttachment/sessionId undefined
    }

    // queryJobResults returns the raw decrypted content (no envelope decode),
    // so decode here - mirroring the BuyContext poll path.
    const decoded = decodeResult(result.content);
    const resultText = resultDisplay(decoded);
    const resultAttachments = decoded.attachments;
    const asset = assetByJobId.get(req.id);
    const callSignature = callSignatureByJobId.get(req.id);

    out.push({
      jobEventId: req.id,
      customerPubkey: viewerPubkey,
      // Wire absence of a session stays ABSENT (never the `null` one-shot
      // marker - that is a send-path-only fact).
      ...(sessionId !== undefined ? { sessionId } : {}),
      capability: capability ?? '',
      prompt: prompt ?? '',
      ...(promptAttachment !== undefined ? { promptAttachment } : {}),
      ...(result.amount !== undefined ? { priceLamports: result.amount } : {}),
      ...(asset !== undefined ? { asset } : {}),
      result: resultText,
      ...(resultAttachments.length > 0 ? { resultAttachments } : {}),
      // `sent`, not `landed`: the report carries no verdict, and the MCP client
      // publishes one for `assume-landed` as well. It blocks the sheet either
      // way and asks the customer to check the signature.
      ...(callSignature !== undefined ? { callSignature, callStatus: 'sent' as const } : {}),
      // Epoch milliseconds - Nostr created_at is seconds.
      ts: req.created_at * 1000,
    });
  }

  return out;
}

/**
 * Relay hydration, now feeding the thread store (stage 2): fetch, merge via
 * `mergeHydratedEntry` (atomic pending/failed -> completed), bump
 * `completedCount` for transitions that actually fired, then run the
 * minted-session repair - all inside the query function so the repair is
 * re-evaluated at EVERY settle (the ~60s refetch), even when the relay data
 * is unchanged. Bumps apply before the same settle's repair evaluation, per
 * the design's within-settle ordering rule.
 *
 * Query data is a content-free count - the thread store is the local cache;
 * no decrypted plaintext is persisted outside it.
 */
export function useChatHydration(agentPubkey: string): { hydrating: boolean } {
  const { client } = useElisymClient();
  const idCtx = useIdentity();
  const identity = idCtx.identity;
  const viewerPubkey = idCtx.publicKey;

  const enabled = Boolean(agentPubkey && viewerPubkey && !idCtx.loading);

  const { data } = useQuery<number>({
    queryKey: ['chat-thread-hydration', agentPubkey, viewerPubkey],
    queryFn: async () => {
      const hydrated = await fetchHydratedEntries(client, identity, viewerPubkey, agentPubkey);
      for (const entry of hydrated) {
        const merged = await mergeHydratedEntry(agentPubkey, entry);
        if (merged.completedTransitionFired && merged.sessionId !== undefined) {
          // Keyed to the transition actually firing: a settle re-observing an
          // already-completed entry bumps nothing, and a job completed live
          // cannot double-bump via its later hydration echo.
          await recordCompletion(viewerPubkey, agentPubkey, merged.sessionId);
        }
      }
      // Repair evaluation, every settle. Candidate list and the pending flag
      // are plain snapshot reads taken before the lock-held mutation.
      const thread = await readThread(agentPubkey);
      const candidates = sessionCandidatesOf(thread, viewerPubkey);
      const current = readChatSession(viewerPubkey, agentPubkey);
      const hasPendingUnderCurrentId =
        current !== undefined &&
        thread.some(
          (entry) =>
            entry.status === 'pending' &&
            entry.customerPubkey === viewerPubkey &&
            entry.sessionId === current.sessionId,
        );
      await repairMintedSession(viewerPubkey, agentPubkey, candidates, hasPendingUnderCurrentId);
      return hydrated.length;
    },
    staleTime: STALE_TIME_MS,
    refetchInterval: REFETCH_INTERVAL_MS,
    enabled,
  });

  return { hydrating: enabled && data === undefined };
}
