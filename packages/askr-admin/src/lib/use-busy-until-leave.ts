import { useEffect, useState } from 'react';

/**
 * Which button is at work, for buttons that leave the page (Stripe Checkout, the billing portal):
 * busy until the page leaves, so a second press opens no second page; back from Stripe with the
 * browser's back button the page may come from its cache with the buttons still busy, so a
 * `pageshow` makes them work again.
 */
export function useBusyUntilLeave<Value>(): [
  Value | undefined,
  (value: Value | undefined) => void,
] {
  const [busy, setBusy] = useState<Value>();
  useEffect(() => {
    const ready = () => setBusy(undefined);
    globalThis.addEventListener('pageshow', ready);
    return () => globalThis.removeEventListener('pageshow', ready);
  }, []);
  return [busy, setBusy];
}
