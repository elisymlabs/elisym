import { type ReactNode, useState } from 'react';
import { billingLine } from '../lib/billing';
import type { SessionDeps } from '../lib/deps';
import { errorMessage } from '../lib/errors';
import type { BillingView } from '../lib/types';
import { useBusyUntilLeave } from '../lib/use-busy-until-leave';
import { Notice } from './Notice';

interface Props {
  deps: Pick<SessionDeps, 'api' | 'openUrl'>;
  billing: BillingView;
  /** The portal opened: the page is leaving. */
  onOpened?: () => void;
}

/**
 * The store's paid plan as Stripe last told the server (renews on, ends on, a payment failed),
 * and Manage billing: the Stripe portal to change plan, payment method or cancel.
 */
export function BillingStatus({ deps, billing, onOpened }: Props) {
  const [busy, setBusy] = useBusyUntilLeave<true>();
  const [error, setError] = useState('');
  const line = billingLine(billing);

  const manage = async () => {
    setBusy(true);
    setError('');
    try {
      const { url } = await deps.api.billingPortal();
      deps.openUrl(url);
      onOpened?.();
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(undefined);
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
          disabled={busy === true}
          aria-busy={busy === true}
          onClick={() => void manage()}
        >
          Manage billing
        </button>
      ) : null}
      {error === '' ? null : <Notice tone="error">{error}</Notice>}
    </div>
  );
}
