import { type ReactNode, useEffect, useState } from 'react';
import { billingLine } from '../lib/billing';
import type { SessionDeps } from '../lib/deps';
import { errorMessage } from '../lib/errors';
import type { BillingView } from '../lib/types';
import { Notice } from './Notice';

interface Props {
  deps: Pick<SessionDeps, 'api' | 'openUrl'>;
  billing: BillingView;
}

/**
 * The store's paid plan as Stripe last told the server (renews on, ends on, a payment failed),
 * and Manage billing: the Stripe portal to change plan, payment method or cancel.
 */
export function BillingStatus({ deps, billing }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const line = billingLine(billing);
  // Back from the portal with the browser's back button, the page may come from its cache with
  // the button still busy: it works again.
  useEffect(() => {
    const ready = () => setBusy(false);
    globalThis.addEventListener('pageshow', ready);
    return () => globalThis.removeEventListener('pageshow', ready);
  }, []);

  const manage = async () => {
    setBusy(true);
    setError('');
    try {
      const { url } = await deps.api.billingPortal();
      deps.openUrl(url);
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  };

  if (line === '' && !billing.manageable) {
    return null;
  }
  let said: ReactNode = null;
  if (line !== '') {
    said =
      billing.status === 'past_due' ? (
        <Notice tone="warn">{line}</Notice>
      ) : (
        <p className="text-14 text-text-2">{line}</p>
      );
  }
  return (
    <div id="billing-status" className="flex flex-col gap-8">
      {said}
      {billing.enabled && billing.manageable ? (
        <button
          type="button"
          id="manage-billing"
          className="btn self-start"
          disabled={busy}
          aria-busy={busy}
          onClick={() => void manage()}
        >
          Manage billing
        </button>
      ) : null}
      {error === '' ? null : <Notice tone="error">{error}</Notice>}
    </div>
  );
}
