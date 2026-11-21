import { useEffect, useState } from 'react';
import { paidPlanOf } from '../lib/billing';
import type { SessionDeps } from '../lib/deps';
import { errorMessage } from '../lib/errors';
import { PLANS } from '../lib/plans';
import type { BillingInterval, PaidPlan } from '../lib/types';
import { Notice } from './Notice';

interface Props {
  deps: Pick<SessionDeps, 'api' | 'openUrl'>;
}

const CARD = 'rounded-10 border-line flex flex-col gap-8 border px-14 py-12';
const PAID = PLANS.flatMap((plan) => {
  const slug = plan.start === 'choose' ? paidPlanOf(plan.name) : undefined;
  return slug === undefined ? [] : [{ ...plan, slug }];
});
const INTERVALS: readonly { value: BillingInterval; label: string }[] = [
  { value: 'month', label: 'Monthly' },
  { value: 'year', label: 'Yearly' },
];

/**
 * The paid plans with an Upgrade button each (6.1): Stripe Checkout for the chosen plan, billed
 * monthly or yearly, tax included in the price. The store moves to the plan once the payment went through.
 */
export function PaidPlans({ deps }: Props) {
  const [interval, setBillingInterval] = useState<BillingInterval>('month');
  const [busy, setBusy] = useState<PaidPlan>();
  const [error, setError] = useState('');
  // Back from Checkout with the browser's back button, the page may come from its cache with the
  // buttons still busy: they work again.
  useEffect(() => {
    const ready = () => setBusy(undefined);
    globalThis.addEventListener('pageshow', ready);
    return () => globalThis.removeEventListener('pageshow', ready);
  }, []);

  const upgrade = async (plan: PaidPlan) => {
    setBusy(plan);
    setError('');
    try {
      const { url } = await deps.api.checkout(plan, interval);
      // Busy until the page leaves: a second press would open a second checkout.
      deps.openUrl(url);
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(undefined);
    }
  };

  return (
    <div id="paid-plans" className="flex flex-col gap-12">
      <div className="flex flex-wrap items-center gap-8" role="group" aria-label="Billing period">
        {INTERVALS.map((option) => (
          <button
            key={option.value}
            type="button"
            id={`interval-${option.value}`}
            className={`btn ${interval === option.value ? 'btn-primary' : ''}`}
            aria-pressed={interval === option.value}
            onClick={() => setBillingInterval(option.value)}
          >
            {option.label}
          </button>
        ))}
        <span className="text-12 text-text-3">Prices in USD, tax included.</span>
      </div>
      <div className="grid grid-cols-1 gap-12 sm:grid-cols-2">
        {PAID.map((plan) => (
          <div key={plan.slug} className={CARD}>
            <p className="text-14 font-semibold">{plan.name}</p>
            <p className="text-13 text-text-2">
              {interval === 'year'
                ? `${plan.yearlyPerMonth ?? plan.monthly} a month, ${plan.yearlyTotal ?? ''} billed yearly`
                : `${plan.monthly} a month`}
            </p>
            <button
              type="button"
              id={`upgrade-${plan.slug}`}
              className="btn btn-primary self-start"
              disabled={busy !== undefined}
              aria-busy={busy === plan.slug}
              onClick={() => void upgrade(plan.slug)}
            >
              Upgrade
            </button>
          </div>
        ))}
      </div>
      {error === '' ? null : <Notice tone="error">{error}</Notice>}
    </div>
  );
}
