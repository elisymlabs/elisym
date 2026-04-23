import { truncateKey, timeAgo, KIND_JOB_REQUEST } from '@elisym/sdk';
import Decimal from 'decimal.js-light';
import { useState, useEffect, useCallback, type ReactNode } from 'react';
import { useElisymClient } from '~/hooks/useElisymClient';
import { useIdentity } from '~/hooks/useIdentity';
import { useLocalQuery } from '~/hooks/useLocalQuery';
import { track } from '~/lib/analytics';
import { cn } from '~/lib/cn';
import { cacheGet, cacheSet } from '~/lib/localCache';

interface Order {
  jobEventId: string;
  capability: string;
  providerPubkey?: string;
  status: 'pending' | 'completed';
  result?: string;
  amount?: number;
  createdAt: number;
}

const KIND_FEEDBACK = 7000;
const REFETCH_INTERVAL_MS = 1000 * 60;
const STALE_TIME_MS = 1000 * 30;

function ResyncButton({ syncing, onClick }: { syncing: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={syncing}
      className="inline-flex cursor-pointer items-center gap-6 rounded-lg border border-border bg-surface px-12 py-4 text-[11px] font-medium text-text-2 transition-colors hover:border-accent hover:text-text disabled:opacity-50"
    >
      {syncing ? (
        <>
          <svg aria-hidden className="size-12 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.3" />
            <path
              d="M12 2a10 10 0 0 1 10 10"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
          Syncing...
        </>
      ) : (
        <>
          <svg
            aria-hidden
            className="size-12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M1 4v6h6" />
            <path d="M23 20v-6h-6" />
            <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15" />
          </svg>
          Resync
        </>
      )}
    </button>
  );
}

interface OrderRowProps {
  order: Order;
  expanded: boolean;
  onToggle: () => void;
  rated: boolean;
  onRate: (order: Order, positive: boolean) => void;
}

function OrderRow({ order, expanded, onToggle, rated, onRate }: OrderRowProps) {
  let feedbackBlock: ReactNode = null;
  if (rated) {
    feedbackBlock = <p className="mt-8 text-[11px] text-text-2">Thanks for your feedback</p>;
  } else if (order.providerPubkey) {
    feedbackBlock = (
      <div className="mt-8 flex gap-8">
        <button
          onClick={() => onRate(order, true)}
          className="cursor-pointer rounded-lg border border-border bg-surface px-12 py-4 text-xs text-text-2 transition-colors hover:border-green hover:text-green"
        >
          👍 Good
        </button>
        <button
          onClick={() => onRate(order, false)}
          className="cursor-pointer rounded-lg border border-border bg-surface px-12 py-4 text-xs text-text-2 transition-colors hover:border-error hover:text-error"
        >
          👎 Bad
        </button>
      </div>
    );
  }

  return (
    <div className="shrink-0 overflow-hidden rounded-xl border border-border bg-surface-2">
      <button
        onClick={onToggle}
        className="flex w-full cursor-pointer items-center justify-between border-none bg-transparent p-16 text-left"
      >
        <div className="flex min-w-0 items-center gap-12">
          <span
            className={cn(
              'size-8 shrink-0 rounded-full',
              order.status === 'completed' ? 'bg-green' : 'animate-pulse bg-yellow-400',
            )}
          />
          <span className="truncate text-sm font-medium">{order.capability}</span>
          {order.providerPubkey && (
            <span className="shrink-0 font-mono text-[11px] text-text-2">
              {truncateKey(order.providerPubkey, 6)}
            </span>
          )}
        </div>
        <div className="ml-12 flex shrink-0 items-center gap-12">
          {order.amount !== null && order.amount !== undefined && (
            <span className="text-xs font-semibold text-green">
              {new Decimal(order.amount).div(1e9).toFixed(2)} SOL
            </span>
          )}
          <span className="text-[11px] text-text-2">{timeAgo(order.createdAt)}</span>
          <svg
            aria-hidden
            className={cn('size-16 text-text-2 transition-transform', expanded && 'rotate-180')}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border px-16 pb-16">
          {order.result ? (
            <div>
              <div className="mt-12 rounded-lg border border-border bg-surface p-12 text-xs leading-relaxed break-words whitespace-pre-wrap text-text">
                {order.result}
              </div>
              {feedbackBlock}
            </div>
          ) : (
            <p className="mt-12 text-xs text-text-2">Waiting for provider response...</p>
          )}
        </div>
      )}
    </div>
  );
}

export function OrderHistory() {
  const { client } = useElisymClient();
  const idCtx = useIdentity();
  const pubkey = idCtx.publicKey;
  const [syncing, setSyncing] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [ratedJobs, setRatedJobs] = useState<Set<string>>(new Set());

  const { data: orders, refetch } = useLocalQuery<Order[]>({
    queryKey: ['order-history', pubkey],
    queryFn: async () => {
      const identity = idCtx.identity;
      if (!identity) {
        return [];
      }

      const requests = await client.pool.querySync({
        kinds: [KIND_JOB_REQUEST],
        authors: [pubkey],
        '#t': ['elisym'],
      });

      if (requests.length === 0) {
        return [];
      }

      const requestIds = requests.map((request) => request.id);

      const feedbacks = await client.pool.queryBatchedByTag(
        { kinds: [KIND_FEEDBACK] },
        'e',
        requestIds,
      );

      const paidRequestIds = new Set<string>();
      for (const feedback of feedbacks) {
        const statusTag = feedback.tags.find((tag) => tag[0] === 'status');
        if (statusTag?.[1] !== 'payment-completed') {
          continue;
        }
        const eTag = feedback.tags.find((tag) => tag[0] === 'e');
        if (eTag?.[1]) {
          paidRequestIds.add(eTag[1]);
        }
      }

      const resultByRequest = await client.marketplace.queryJobResults(identity, requestIds);

      const completedRequests = requests.filter(
        (request) => paidRequestIds.has(request.id) || resultByRequest.has(request.id),
      );
      if (completedRequests.length === 0) {
        return [];
      }

      return completedRequests
        .sort((a, b) => b.created_at - a.created_at)
        .map((request) => {
          const capTag = request.tags.find((tag) => tag[0] === 't' && tag[1] !== 'elisym');
          const pTag = request.tags.find((tag) => tag[0] === 'p');
          const res = resultByRequest.get(request.id);

          return {
            jobEventId: request.id,
            capability: capTag?.[1] ?? 'unknown',
            providerPubkey: pTag?.[1],
            status: res ? ('completed' as const) : ('pending' as const),
            result: res?.content,
            amount: res?.amount,
            createdAt: request.created_at,
          };
        });
    },
    enabled: !!pubkey,
    staleTime: STALE_TIME_MS,
    refetchInterval: REFETCH_INTERVAL_MS,
  });

  useEffect(() => {
    if (!orders) {
      return;
    }
    const completed = orders.filter((order) => order.status === 'completed' && order.result);
    Promise.all(
      completed.map(async (order) => {
        const isRated = await cacheGet<boolean>(`rated:${order.jobEventId}`);
        return isRated ? order.jobEventId : null;
      }),
    ).then((ids) => {
      const ratedSet = new Set(ids.filter((id): id is string => id !== null));
      if (ratedSet.size > 0) {
        setRatedJobs(ratedSet);
      }
    });
  }, [orders]);

  const rateOrder = useCallback(
    async (order: Order, positive: boolean) => {
      if (!order.providerPubkey || !idCtx.identity) {
        return;
      }
      setRatedJobs((prev) => new Set(prev).add(order.jobEventId));
      try {
        await client.marketplace.submitFeedback(
          idCtx.identity,
          order.jobEventId,
          order.providerPubkey,
          positive,
          order.capability,
        );
        await cacheSet(`rated:${order.jobEventId}`, true);
        track('rate-result', { rating: positive ? 'good' : 'bad' });
      } catch {
        // silent fail
      }
    },
    [client, idCtx.identity],
  );

  async function handleResync() {
    setSyncing(true);
    try {
      await refetch();
    } finally {
      setSyncing(false);
    }
  }

  const isEmpty = !orders || orders.length === 0;

  return (
    <div className="rounded-2xl border border-border bg-surface p-32">
      <div className="mb-16 flex flex-wrap items-center justify-between gap-12">
        <h3 className="text-base font-semibold">Order History</h3>
        <div className="flex items-center gap-8">
          <span className={cn('text-[11px] text-text-2', isEmpty && 'max-sm:hidden')}>
            Updates every 60s
          </span>
          <ResyncButton syncing={syncing} onClick={() => void handleResync()} />
        </div>
      </div>

      {isEmpty ? (
        <p className="py-16 text-center text-sm text-text-2">No orders yet.</p>
      ) : (
        <div className="flex max-h-[240px] min-h-0 flex-col gap-8 overflow-y-auto">
          {orders.map((order) => (
            <OrderRow
              key={order.jobEventId}
              order={order}
              expanded={expandedId === order.jobEventId}
              onToggle={() =>
                setExpandedId(expandedId === order.jobEventId ? null : order.jobEventId)
              }
              rated={ratedJobs.has(order.jobEventId)}
              onRate={(target, positive) => void rateOrder(target, positive)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
