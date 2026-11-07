import { useRef, useState } from 'react';
import { Button } from '../../components/Button';
import type { ConsoleApi } from '../lib/api';
import { explainAnswer } from '../lib/errors';
import { fieldOf } from '../lib/fields';
import { billingPageUrl, cardRefusalText, cryptoRefusalText, stripeSessionUrl } from '../lib/rails';
import type { StoreView } from '../lib/store-view';
import { Card } from './Card';

interface Props {
  api: ConsoleApi;
  tenantId: string;
  view: StoreView;
  /** The Pay Core billing page, if the cloud has one. */
  billingUrl: string | undefined;
  /** A top-level navigation to Stripe (no Stripe script runs on the console). */
  navigate: (url: string) => void;
  /** The view went stale (a refusal of a step it showed open): read it again. */
  onStale: () => void;
  /** Its heading's level: `h3` in the checklist, under "Getting started". */
  level?: 'h2' | 'h3';
}

/**
 * Paying for the store: by card (Stripe Checkout, then its portal) or by
 * crypto (the Pay Core billing page on its own domain), one rail at a time.
 */
export function BillingPanel({
  api,
  tenantId,
  view,
  billingUrl,
  navigate,
  onStale,
  level = 'h2',
}: Props) {
  // Its rails head one level under its own heading.
  const Sub = level === 'h2' ? 'h3' : 'h4';
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const toStripe = async (path: 'checkout' | 'portal') => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError('');
    const answer = await api.request('POST', `/tenants/${tenantId}/${path}`);
    const url = answer.status === 200 ? stripeSessionUrl(fieldOf(answer.body, 'url')) : undefined;
    if (url !== undefined) {
      // Stays busy: the page is leaving for Stripe.
      navigate(url);
      return;
    }
    inFlight.current = false;
    setBusy(false);
    setError(
      answer.status === 200
        ? 'The cloud did not answer with a Stripe page.'
        : explainAnswer(answer.body, answer.status),
    );
    if (answer.status === 409) {
      onStale();
    }
  };

  const cryptoOpen = view.crypto.open && billingUrl !== undefined;
  return (
    <Card title="Billing" level={level}>
      <div className="mt-16 flex flex-col gap-16">
        <div className="flex flex-col gap-8">
          <Sub className="text-15 font-semibold">Card</Sub>
          {view.card.open ? (
            <Button
              disabled={busy}
              onClick={() => void toStripe('checkout')}
              variant="primary"
              size="lg"
            >
              Pay by card
            </Button>
          ) : (
            <p className="text-14 text-text-2">
              {cardRefusalText(view.card.refusal ?? { code: 'unknown' })}
            </p>
          )}
          {view.card.refusal?.code === 'rail_off' ? null : (
            <Button disabled={busy} onClick={() => void toStripe('portal')}>
              Manage card billing
            </Button>
          )}
        </div>
        <div className="flex flex-col gap-8">
          <Sub className="text-15 font-semibold">Crypto</Sub>
          {cryptoOpen ? (
            <a
              href={billingPageUrl(billingUrl, tenantId, view.billingRef)}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-10 border-line-2 text-15 border py-10 text-center font-semibold"
            >
              Pay by crypto
            </a>
          ) : (
            <p className="text-14 text-text-2">
              {cryptoRefusalText(
                billingUrl === undefined
                  ? { code: 'rail_off' }
                  : (view.crypto.refusal ?? { code: 'unknown' }),
              )}
            </p>
          )}
          {view.card.refusal?.code === 'rail_off' ? null : (
            <p className="text-13 text-text-3">
              Paying by crypto does not end a card subscription: end it in the billing portal.
            </p>
          )}
        </div>
        <p role="alert" className="text-13 text-error empty:hidden">
          {error}
        </p>
      </div>
    </Card>
  );
}
