import {
  KIND_JOB_FEEDBACK,
  KIND_JOB_REQUEST,
  type FileAttachment,
  nip44Decrypt,
  parsePaymentRequest,
  type PaymentAssetRef,
} from '@elisym/sdk';
import type { Event as NostrEvent } from 'nostr-tools';
import { useElisymClient } from '~/hooks/useElisymClient';
import { useIdentity } from '~/hooks/useIdentity';
import { useLocalQuery } from '~/hooks/useLocalQuery';
import { decodeResult, resultDisplay } from '~/lib/fileResult';
import type { Artifact } from './types';

const STALE_TIME_MS = 1000 * 30;
const REFETCH_INTERVAL_MS = 1000 * 60;

/**
 * Fetches the viewer's completed jobs with this agent from Nostr relays.
 * Returns partial Artifact records without cardName (resolved by the caller
 * against live capability cards, so renames pick up on the next render).
 */
export function useNostrArtifacts(agentPubkey: string) {
  const { client } = useElisymClient();
  const idCtx = useIdentity();
  const identity = idCtx.identity;
  const viewerPubkey = idCtx.publicKey;
  const viewerSecret = identity.secretKey;

  const enabled = Boolean(agentPubkey && viewerPubkey && !idCtx.loading);

  const { data } = useLocalQuery<Omit<Artifact, 'cardName'>[]>({
    queryKey: ['agent-nostr-history', agentPubkey, viewerPubkey],
    queryFn: async () => {
      const requests = (await client.pool.querySync({
        kinds: [KIND_JOB_REQUEST],
        authors: [viewerPubkey],
        '#p': [agentPubkey],
      })) as NostrEvent[];

      if (requests.length === 0) {
        return [];
      }

      const requestIds = requests.map((req) => req.id);
      const [resultMap, feedbacks] = await Promise.all([
        client.marketplace
          .queryJobResults(identity, requestIds, undefined, agentPubkey)
          .catch(() => new Map()),
        client.pool
          .queryBatchedByTag(
            { kinds: [KIND_JOB_FEEDBACK], authors: [agentPubkey] },
            'e',
            requestIds,
          )
          .catch(() => [] as NostrEvent[]),
      ]);

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

      const out: Omit<Artifact, 'cardName'>[] = [];
      for (const req of requests) {
        const result = resultMap.get(req.id);
        if (!result || !result.content) {
          continue;
        }

        const capability = req.tags.find((tag) => tag[0] === 't' && tag[1] !== 'elisym')?.[1];

        let prompt: string | undefined;
        let promptAttachment: FileAttachment | undefined;
        const isEncrypted = req.tags.some((tag) => tag[0] === 'encrypted');
        const recipient = req.tags.find((tag) => tag[0] === 'p')?.[1];
        try {
          const plaintext =
            isEncrypted && recipient
              ? nip44Decrypt(req.content, viewerSecret, recipient)
              : req.content;
          // A file input is wrapped in an `elisym-job/*` envelope. Keep the GENUINE
          // text note (not the `📎 name` placeholder) so the modal can show it next
          // to a real file preview; the file itself renders via promptAttachment,
          // never as raw JSON. An input is always a single file.
          const decodedInput = decodeResult(plaintext);
          prompt = decodedInput.text?.trim() ? decodedInput.text : undefined;
          promptAttachment = decodedInput.attachments[0];
        } catch {
          // decryption failed, leave prompt/promptAttachment undefined
        }

        // queryJobResults returns the raw decrypted content (no envelope decode),
        // so decode here - mirroring the BuyContext poll path. A file result with a
        // blossom member becomes downloadable in the browser; one without falls back
        // to a notice; a normal result yields its inline text.
        const decoded = decodeResult(result.content);
        const resultText = resultDisplay(decoded);
        const resultAttachments = decoded.attachments;

        out.push({
          id: req.id,
          capability,
          result: resultText,
          createdAt: req.created_at * 1000,
          priceLamports: result.amount,
          asset: assetByJobId.get(req.id),
          prompt,
          promptAttachment,
          // The input is encrypted to the `p`-tag recipient (= agentPubkey, the query
          // filter); NIP-44's conversation key is symmetric, so the customer decrypts
          // its own input against that same pubkey.
          promptProviderPubkey: promptAttachment ? agentPubkey : undefined,
          resultAttachments,
          // The result author is `agentPubkey` (the query filters by it), which is
          // also the blossom content-key wrapper - the decrypt sender.
          resultProviderPubkey: resultAttachments.length > 0 ? agentPubkey : undefined,
        });
      }

      return out.sort((a, b) => b.createdAt - a.createdAt);
    },
    staleTime: STALE_TIME_MS,
    refetchInterval: REFETCH_INTERVAL_MS,
    enabled,
  });

  return { artifacts: data, loading: enabled && data === undefined };
}
