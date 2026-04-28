import {
  KIND_JOB_FEEDBACK,
  KIND_JOB_REQUEST,
  nip44Decrypt,
  parsePaymentRequest,
  type PaymentAssetRef,
} from '@elisym/sdk';
import type { Event as NostrEvent } from 'nostr-tools';
import { useElisymClient } from '~/hooks/useElisymClient';
import { useIdentity } from '~/hooks/useIdentity';
import { useLocalQuery } from '~/hooks/useLocalQuery';
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
        const isEncrypted = req.tags.some((tag) => tag[0] === 'encrypted');
        const recipient = req.tags.find((tag) => tag[0] === 'p')?.[1];
        try {
          prompt =
            isEncrypted && recipient
              ? nip44Decrypt(req.content, viewerSecret, recipient)
              : req.content;
        } catch {
          // decryption failed, leave prompt undefined
        }

        out.push({
          id: req.id,
          capability,
          result: result.content,
          createdAt: req.created_at * 1000,
          priceLamports: result.amount,
          asset: assetByJobId.get(req.id),
          prompt,
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
