import { useEffect, useState } from 'react';
import {
  ACTIVATION_POLL_LIMIT,
  ACTIVATION_POLL_MS,
  type BillingReturn,
  isLive,
} from '../lib/billing';
import type { StoreView } from '../lib/types';
import { Notice } from './Notice';

interface Props {
  /** How the owner came back from Stripe Checkout. */
  flag: BillingReturn;
  view: StoreView;
  /** Read the store (and its settings) again. */
  refresh: () => Promise<void>;
}

/**
 * Back from Stripe Checkout (6.1): after a payment the store is read again every few seconds
 * until Stripe's event made its plan live, since the payment page returns before the server
 * hears of it; after a cancel, that nothing was charged.
 */
export function BillingReturnNotice({ flag, view, refresh }: Props) {
  const [reads, setReads] = useState(0);
  const activated = view.status === 'active' && isLive(view.billing);
  const waiting = flag === 'success' && !activated && reads < ACTIVATION_POLL_LIMIT;

  useEffect(() => {
    if (!waiting) {
      return undefined;
    }
    const timer = setTimeout(() => {
      void refresh().finally(() => setReads((count) => count + 1));
    }, ACTIVATION_POLL_MS);
    return () => clearTimeout(timer);
  }, [waiting, reads, refresh]);

  if (flag === 'canceled') {
    return <Notice tone="info">Checkout was canceled. Nothing was charged.</Notice>;
  }
  if (activated) {
    return <Notice tone="success">Payment received. Your plan is active.</Notice>;
  }
  if (waiting) {
    return <Notice tone="info">Payment received, activating...</Notice>;
  }
  return (
    <Notice tone="warn">
      Payment received. Activation is taking longer than usual: refresh in a minute. If your plan is
      still not active, message us with your Store ID.
    </Notice>
  );
}
