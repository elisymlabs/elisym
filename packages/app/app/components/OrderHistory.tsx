import { truncateKey, timeAgo, KIND_JOB_REQUEST } from '@elisym/sdk';
import Decimal from 'decimal.js-light';
import type { Filter } from 'nostr-tools';
import { useState, useEffect, useCallback } from 'react';
import { useElisymClient } from '~/hooks/useElisymClient';
import { useIdentity } from '~/hooks/useIdentity';
import { useLocalQuery } from '~/hooks/useLocalQuery';
import { track } from '~/lib/analytics';
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
      // Fetch job requests authored by this pubkey
      const requests = await client.pool.querySync({
        kinds: [KIND_JOB_REQUEST],
        authors: [pubkey],
        '#t': ['elisym'],
      } as Filter);

      if (requests.length === 0) {
        return [];
      }

      const requestIds = requests.map((r) => r.id);

      // Fetch feedback (kind:7000) to find which jobs were paid
      const feedbacks = await client.pool.queryBatchedByTag(
        { kinds: [7000] } as Filter,
        'e',
        requestIds,
      );

      // Collect request IDs that have payment-completed feedback
      const paidRequestIds = new Set<string>();
      for (const fb of feedbacks) {
        const statusTag = fb.tags.find((t) => t[0] === 'status');
        if (statusTag?.[1] !== 'payment-completed') {
          continue;
        }
        const eTag = fb.tags.find((t) => t[0] === 'e');
        if (eTag?.[1]) {
          paidRequestIds.add(eTag[1]);
        }
      }

      // Query and decrypt results via SDK
      const identity = idCtx.identity!;
      const resultByRequest = await client.marketplace.queryJobResults(identity, requestIds);

      // Keep requests that were paid OR have a result (free)
      const completedRequests = requests.filter(
        (r) => paidRequestIds.has(r.id) || resultByRequest.has(r.id),
      );
      if (completedRequests.length === 0) {
        return [];
      }

      return completedRequests
        .sort((a, b) => b.created_at - a.created_at)
        .map((req) => {
          const capTag = req.tags.find((t) => t[0] === 't' && t[1] !== 'elisym');
          const pTag = req.tags.find((t) => t[0] === 'p');
          const res = resultByRequest.get(req.id);

          return {
            jobEventId: req.id,
            capability: capTag?.[1] ?? 'unknown',
            providerPubkey: pTag?.[1],
            status: res ? ('completed' as const) : ('pending' as const),
            result: res?.content,
            amount: res?.amount,
            createdAt: req.created_at,
          };
        });
    },
    enabled: !!pubkey,
    staleTime: 1000 * 30,
    refetchInterval: 1000 * 60,
  });

  // Load rated status from IndexedDB
  useEffect(() => {
    if (!orders) {
      return;
    }
    const completed = orders.filter((o) => o.status === 'completed' && o.result);
    Promise.all(
      completed.map(async (o) => {
        const isRated = await cacheGet<boolean>(`rated:${o.jobEventId}`);
        return isRated ? o.jobEventId : null;
      }),
    ).then((ids) => {
      const set = new Set(ids.filter(Boolean) as string[]);
      if (set.size > 0) {
        setRatedJobs(set);
      }
    });
  }, [orders]);

  const rateOrder = useCallback(
    async (jobEventId: string, providerPubkey: string, positive: boolean, capability: string) => {
      setRatedJobs((prev) => new Set(prev).add(jobEventId));
      try {
        const identity = idCtx.identity;
        await client.marketplace.submitFeedback(
          identity,
          jobEventId,
          providerPubkey,
          positive,
          capability,
        );
        await cacheSet(`rated:${jobEventId}`, true);
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

  if (!orders || orders.length === 0) {
    return (
      <div className="bg-surface border border-border rounded-2xl p-8">
        <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
          <h3 className="text-base font-semibold">Order History</h3>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-text-2 max-sm:hidden">Updates every 60s</span>
            <button
              onClick={handleResync}
              disabled={syncing}
              className="inline-flex items-center gap-1.5 py-1 px-3 rounded-lg border border-border bg-surface text-[11px] font-medium text-text-2 cursor-pointer hover:border-accent hover:text-text disabled:opacity-50 transition-colors"
            >
              {syncing ? (
                <>
                  <svg className="size-3 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="2"
                      opacity="0.3"
                    />
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
                    className="size-3"
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
          </div>
        </div>
        <p className="text-sm text-text-2 text-center py-4">No orders yet.</p>
      </div>
    );
  }

  return (
    <div className="bg-surface border border-border rounded-2xl p-8">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-base font-semibold">Order History</h3>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-text-2">Updates every 60s</span>
          <button
            onClick={handleResync}
            disabled={syncing}
            className="inline-flex items-center gap-1.5 py-1 px-3 rounded-lg border border-border bg-surface text-[11px] font-medium text-text-2 cursor-pointer hover:border-accent hover:text-text disabled:opacity-50 transition-colors"
          >
            {syncing ? (
              <>
                <svg className="size-3 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="2"
                    opacity="0.3"
                  />
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
                  className="size-3"
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
        </div>
      </div>

      <div className="flex flex-col gap-2 max-h-[240px] overflow-y-auto min-h-0">
        {orders.map((order) => (
          <div
            key={order.jobEventId}
            className="border border-border rounded-xl bg-surface-2 overflow-hidden shrink-0"
          >
            <button
              onClick={() =>
                setExpandedId(expandedId === order.jobEventId ? null : order.jobEventId)
              }
              className="w-full flex items-center justify-between p-4 bg-transparent border-none cursor-pointer text-left"
            >
              <div className="flex items-center gap-3 min-w-0">
                <span
                  className={`size-2 rounded-full shrink-0 ${
                    order.status === 'completed' ? 'bg-[#1d9e75]' : 'bg-yellow-400 animate-pulse'
                  }`}
                />
                <span className="text-sm font-medium truncate">{order.capability}</span>
                {order.providerPubkey && (
                  <span className="text-[11px] text-text-2 font-mono shrink-0">
                    {truncateKey(order.providerPubkey, 6)}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3 shrink-0 ml-3">
                {order.amount !== null && order.amount !== undefined && (
                  <span className="text-xs font-semibold text-green">
                    {new Decimal(order.amount).div(1e9).toFixed(2)} SOL
                  </span>
                )}
                <span className="text-[11px] text-text-2">{timeAgo(order.createdAt)}</span>
                <svg
                  className={`size-4 text-text-2 transition-transform ${expandedId === order.jobEventId ? 'rotate-180' : ''}`}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </div>
            </button>

            {expandedId === order.jobEventId && (
              <div className="px-4 pb-4 border-t border-border">
                {order.result ? (
                  <div>
                    <div className="mt-3 p-3 bg-surface rounded-lg border border-border text-xs text-text leading-relaxed whitespace-pre-wrap break-words">
                      {order.result}
                    </div>
                    {(() => {
                      if (ratedJobs.has(order.jobEventId)) {
                        return (
                          <p className="text-[11px] text-text-2 mt-2">Thanks for your feedback</p>
                        );
                      }
                      if (order.providerPubkey) {
                        return (
                          <div className="flex gap-2 mt-2">
                            <button
                              onClick={() =>
                                rateOrder(
                                  order.jobEventId,
                                  order.providerPubkey!,
                                  true,
                                  order.capability,
                                )
                              }
                              className="py-1 px-3 rounded-lg border border-border bg-surface text-xs text-text-2 cursor-pointer hover:border-green hover:text-green transition-colors"
                            >
                              👍 Good
                            </button>
                            <button
                              onClick={() =>
                                rateOrder(
                                  order.jobEventId,
                                  order.providerPubkey!,
                                  false,
                                  order.capability,
                                )
                              }
                              className="py-1 px-3 rounded-lg border border-border bg-surface text-xs text-text-2 cursor-pointer hover:border-error hover:text-error transition-colors"
                            >
                              👎 Bad
                            </button>
                          </div>
                        );
                      }
                      return null;
                    })()}
                  </div>
                ) : (
                  <p className="mt-3 text-xs text-text-2">Waiting for provider response...</p>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
