/**
 * The store's orders (`GET /tenants/:id/orders`), read once for every page
 * that shows them (plan `admin-onboarding.md` 2.5): on mount when `enabled`,
 * and again on `reload`. Only the newest answer counts, and none after the
 * store left the page.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConsoleApi } from './api';
import { explainAnswer } from './errors';
import { type OrdersRead, ordersReadOf } from './orders';

export interface CloudOrders {
  /** The latest read that succeeded; undefined before the first. */
  read: OrdersRead | undefined;
  /** Why the latest read failed; empty when it did not. */
  error: string;
  loading: boolean;
  reload: () => void;
}

export function useCloudOrders(
  api: ConsoleApi,
  tenantId: string,
  /** A store not launched has no ledger to read: nothing is asked for it. */
  enabled: boolean,
): CloudOrders {
  const [read, setRead] = useState<OrdersRead | undefined>(undefined);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(enabled);
  const latest = useRef(0);

  const load = useCallback(async () => {
    latest.current += 1;
    const seq = latest.current;
    setLoading(true);
    const answer = await api.request('GET', `/tenants/${tenantId}/orders`);
    if (seq !== latest.current) {
      return;
    }
    setLoading(false);
    const orders = answer.status === 200 ? ordersReadOf(answer.body) : undefined;
    if (orders !== undefined) {
      setRead(orders);
      setError('');
    } else {
      setError(explainAnswer(answer.status === 200 ? undefined : answer.body, answer.status));
    }
  }, [api, tenantId]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    void load();
    return () => {
      latest.current += 1;
    };
  }, [enabled, load]);

  const reload = useCallback(() => {
    if (enabled) {
      void load();
    }
  }, [enabled, load]);

  return { read, error, loading, reload };
}
