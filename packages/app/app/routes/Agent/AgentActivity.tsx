import {
  timeAgo,
  KIND_JOB_FEEDBACK,
  KIND_JOB_RESULT,
  parsePaymentRequest,
  resolveKnownAsset,
  type PaymentAssetRef,
} from '@elisym/sdk';
import { useElisymClient } from '~/hooks/useElisymClient';
import { useLocalQuery } from '~/hooks/useLocalQuery';
import { compactZeros, formatDecimal } from '~/lib/formatPrice';
import type { ActivityEvent } from './types';

const DEFAULT_SOL_DECIMALS = 9;
const DEFAULT_SOL_SYMBOL = 'SOL';

function formatActivityAmount(amount: number, asset: PaymentAssetRef | undefined): string {
  if (!asset) {
    return `${compactZeros(formatDecimal(amount, DEFAULT_SOL_DECIMALS))} ${DEFAULT_SOL_SYMBOL}`;
  }
  const known = resolveKnownAsset(asset.chain, asset.token, asset.mint);
  const symbol = known?.symbol ?? asset.token.toUpperCase();
  return `${compactZeros(formatDecimal(amount, asset.decimals))} ${symbol}`;
}

interface Props {
  agentPubkey: string;
  productCount: number;
}

const STALE_TIME_MS = 1000 * 30;
const REFETCH_INTERVAL_MS = 1000 * 60;
const ACTIVITY_SKELETON_COUNT = 4;
const MAX_ACTIVITY_EVENTS = 10;

export function AgentActivity({ agentPubkey, productCount }: Props) {
  const { client } = useElisymClient();

  const { data: events } = useLocalQuery<ActivityEvent[]>({
    queryKey: ['agent-public-activity', agentPubkey],
    queryFn: async () => {
      const results = await client.pool.querySync({
        kinds: [KIND_JOB_RESULT],
        authors: [agentPubkey],
        limit: MAX_ACTIVITY_EVENTS,
      });

      const jobIds = results
        .map((event) => event.tags.find((tag) => tag[0] === 'e')?.[1])
        .filter((value): value is string => Boolean(value));

      const feedbacks =
        jobIds.length > 0
          ? await client.pool.queryBatchedByTag(
              { kinds: [KIND_JOB_FEEDBACK], authors: [agentPubkey] },
              'e',
              jobIds,
            )
          : [];

      // Per NIP-90 elisym, the payment-required feedback's amount tag is
      // shaped as [amount, raw, paymentRequestJson, chain]. The third element
      // carries the asset descriptor (SOL/USDC/...) so we can render the
      // activity row in the right currency instead of always SOL.
      interface FeedbackInfo {
        amount: number;
        asset?: PaymentAssetRef;
      }
      const infoByJobId = new Map<string, FeedbackInfo>();
      for (const feedback of feedbacks) {
        const statusTag = feedback.tags.find((tag) => tag[0] === 'status');
        if (statusTag?.[1] !== 'payment-required') {
          continue;
        }
        const eTag = feedback.tags.find((tag) => tag[0] === 'e');
        const amountTag = feedback.tags.find((tag) => tag[0] === 'amount');
        const raw = amountTag?.[1] ? parseInt(amountTag[1], 10) : undefined;
        if (!eTag?.[1] || !raw || !Number.isFinite(raw)) {
          continue;
        }
        let asset: PaymentAssetRef | undefined;
        const requestJson = amountTag?.[2];
        if (requestJson) {
          const parsed = parsePaymentRequest(requestJson);
          if (parsed.ok && parsed.data.asset) {
            asset = parsed.data.asset;
          }
        }
        infoByJobId.set(eTag[1], { amount: raw, asset });
      }

      return results
        .map((event) => {
          const eTag = event.tags.find((tag) => tag[0] === 'e');
          const capTag = event.tags.find((tag) => tag[0] === 't' && tag[1] !== 'elisym');
          const amountTag = event.tags.find((tag) => tag[0] === 'amount');
          const jobId = eTag?.[1];
          const directAmount = amountTag?.[1] ? parseInt(amountTag[1], 10) : undefined;
          const fallback = jobId ? infoByJobId.get(jobId) : undefined;
          const amount =
            directAmount && Number.isFinite(directAmount) ? directAmount : fallback?.amount;
          return {
            id: event.id,
            createdAt: event.created_at,
            capability: capTag?.[1],
            amount,
            asset: fallback?.asset,
          };
        })
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, MAX_ACTIVITY_EVENTS);
    },
    staleTime: STALE_TIME_MS,
    refetchInterval: REFETCH_INTERVAL_MS,
  });

  if (!events) {
    return <AgentActivitySkeleton />;
  }

  if (events.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center px-16 py-56">
        <p className="m-0 text-sm text-text-2">No activity yet</p>
        <p className="m-0 mt-4 text-center text-sm text-text-2/60">
          Jobs completed by this agent will appear here
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="m-0 mb-8 px-2 text-xs text-text-2 opacity-60">Last 10 completed jobs</p>
      {events.map((event) => (
        <div
          key={event.id}
          className="group flex items-center gap-12 rounded-xl py-8 transition-colors"
        >
          <div className="flex size-32 shrink-0 items-center justify-center rounded-full bg-surface-2 text-text-2">
            <svg aria-hidden viewBox="0 0 20 20" fill="currentColor" className="size-16">
              <path
                fillRule="evenodd"
                d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0L3.3 9.7a1 1 0 0 1 1.4-1.4l3.8 3.8 6.8-6.8a1 1 0 0 1 1.4 0Z"
                clipRule="evenodd"
              />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-8">
              <span className="truncate text-sm font-medium">Job completed</span>
              {productCount > 1 && event.capability && (
                <span className="truncate rounded-full bg-tag-bg px-8 py-2 font-mono text-[10px] font-medium tracking-wide text-text-2 uppercase">
                  {event.capability}
                </span>
              )}
            </div>
            <span className="text-[11px] text-text-2">{timeAgo(event.createdAt)}</span>
          </div>
          {!event.amount ? (
            <span className="shrink-0 rounded-full bg-stat-sky-bg px-10 py-4 font-mono text-[11px] font-medium tracking-wide text-stat-sky uppercase">
              Free
            </span>
          ) : (
            <span className="shrink-0 rounded-full bg-stat-emerald-bg px-10 py-4 font-mono text-xs font-medium text-stat-emerald tabular-nums">
              +{formatActivityAmount(event.amount, event.asset)}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function AgentActivitySkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <p className="m-0 mb-8 px-2 text-xs text-text-2 opacity-60">Last 10 completed jobs</p>
      {Array.from({ length: ACTIVITY_SKELETON_COUNT }).map((_, index) => (
        <div key={index} className="flex items-center gap-12 py-8">
          <div className="skeleton size-32 shrink-0 rounded-full" />
          <div className="flex min-w-0 flex-1 flex-col gap-6">
            <div className="skeleton h-12 w-96 rounded-full" />
            <div className="skeleton h-10 w-64 rounded-full" />
          </div>
          <div className="skeleton h-20 w-72 shrink-0 rounded-full" />
        </div>
      ))}
    </div>
  );
}
