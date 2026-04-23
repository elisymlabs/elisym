import { timeAgo, KIND_JOB_FEEDBACK, KIND_JOB_RESULT } from '@elisym/sdk';
import Decimal from 'decimal.js-light';
import { useElisymClient } from '~/hooks/useElisymClient';
import { useLocalQuery } from '~/hooks/useLocalQuery';
import type { ActivityEvent } from './types';

interface Props {
  agentPubkey: string;
  productCount: number;
}

const STALE_TIME_MS = 1000 * 30;
const REFETCH_INTERVAL_MS = 1000 * 60;

export function AgentActivity({ agentPubkey, productCount }: Props) {
  const { client } = useElisymClient();

  const { data: events } = useLocalQuery<ActivityEvent[]>({
    queryKey: ['agent-public-activity', agentPubkey],
    queryFn: async () => {
      const results = await client.pool.querySync({
        kinds: [KIND_JOB_RESULT],
        authors: [agentPubkey],
        limit: 100,
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

      const amountByJobId = new Map<string, number>();
      for (const feedback of feedbacks) {
        const statusTag = feedback.tags.find((tag) => tag[0] === 'status');
        if (statusTag?.[1] !== 'payment-required') {
          continue;
        }
        const eTag = feedback.tags.find((tag) => tag[0] === 'e');
        const amountTag = feedback.tags.find((tag) => tag[0] === 'amount');
        const lamports = amountTag?.[1] ? parseInt(amountTag[1], 10) : undefined;
        if (eTag?.[1] && lamports && Number.isFinite(lamports)) {
          amountByJobId.set(eTag[1], lamports);
        }
      }

      return results
        .map((event) => {
          const eTag = event.tags.find((tag) => tag[0] === 'e');
          const capTag = event.tags.find((tag) => tag[0] === 't' && tag[1] !== 'elisym');
          const amountTag = event.tags.find((tag) => tag[0] === 'amount');
          const jobId = eTag?.[1];
          const directAmount = amountTag?.[1] ? parseInt(amountTag[1], 10) : undefined;
          const fallbackAmount = jobId ? amountByJobId.get(jobId) : undefined;
          const amountLamports =
            directAmount && Number.isFinite(directAmount) ? directAmount : fallbackAmount;
          return {
            id: event.id,
            createdAt: event.created_at,
            capability: capTag?.[1],
            amountLamports,
          };
        })
        .sort((a, b) => b.createdAt - a.createdAt);
    },
    staleTime: STALE_TIME_MS,
    refetchInterval: REFETCH_INTERVAL_MS,
  });

  if (!events || events.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center px-16 py-56">
        <p className="m-0 text-sm text-text-2">No activity yet</p>
        <p className="m-0 mt-4 text-sm text-text-2/60">
          Jobs completed by this agent will appear here
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
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
                <span className="truncate rounded-full bg-tag-bg px-8 py-2 text-[10px] font-semibold tracking-wide text-text-2 uppercase">
                  {event.capability}
                </span>
              )}
            </div>
            <span className="text-[11px] text-text-2">{timeAgo(event.createdAt)}</span>
          </div>
          {!event.amountLamports ? (
            <span className="shrink-0 rounded-full bg-stat-sky-bg px-10 py-4 text-[11px] font-semibold tracking-wide text-stat-sky uppercase">
              Free
            </span>
          ) : (
            <span className="shrink-0 rounded-full bg-stat-emerald-bg px-10 py-4 text-xs font-semibold text-stat-emerald tabular-nums">
              +{new Decimal(event.amountLamports).div(1e9).toFixed(4)} SOL
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
