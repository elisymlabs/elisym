import { useEffect, useRef, useState } from 'react';
import {
  ACTIVATION_POLL_LIMIT,
  ACTIVATION_POLL_MS,
  ACTIVE_TEXT,
  type BillingReturn,
  UPDATED_TEXT,
  isLive,
} from '../lib/billing';
import type { StoreView } from '../lib/types';
import { Notice } from './Notice';

interface Props {
  /** How the owner came back from Stripe. */
  flag: BillingReturn;
  view: StoreView;
  /** Read the store (and its settings) again. */
  refresh: () => Promise<void>;
  /** What is said once the paid plan is live; Onboarding says what is left to do. */
  activeText?: string;
}

/**
 * Back from Stripe (6.1): after a payment the store is read again every few seconds until
 * Stripe's event made its plan live, since the payment page returns before the server hears of
 * it; after a cancel, that nothing was charged; after a portal change (D8), the store is read
 * once and the change may show a moment later.
 */
export function BillingReturnNotice({ flag, view, refresh, activeText = ACTIVE_TEXT }: Props) {
  const [reads, setReads] = useState(0);
  const activated = view.status === 'active' && isLive(view.billing);
  const waiting = flag === 'success' && !activated && reads < ACTIVATION_POLL_LIMIT;
  /** Set once the portal return's one read started: StrictMode's second effect starts no second. */
  const readOnce = useRef(false);

  useEffect(() => {
    if (flag !== 'updated' || readOnce.current) {
      return;
    }
    readOnce.current = true;
    void refresh();
  }, [flag, refresh]);

  useEffect(() => {
    if (!waiting) {
      return undefined;
    }
    const timer = setTimeout(() => {
      void refresh().finally(() => setReads((count) => count + 1));
    }, ACTIVATION_POLL_MS);
    return () => clearTimeout(timer);
  }, [waiting, reads, refresh]);

  if (flag === 'updated') {
    return <Notice tone="success">{UPDATED_TEXT}</Notice>;
  }
  if (flag === 'canceled') {
    return <Notice tone="info">Checkout was canceled. Nothing was charged.</Notice>;
  }
  if (activated) {
    return <Notice tone="success">{activeText}</Notice>;
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
