import { useEffect, useRef, useState } from 'react';
import { cycleOf, paidPlanOf, planName } from '../lib/billing';
import type { SessionDeps } from '../lib/deps';
import { errorMessage } from '../lib/errors';
import { HELP } from '../lib/help';
import { billingModeOf, cardActionOf, currentPlanOf } from '../lib/plan-actions';
import { PAID_THROUGH_US_TEXT, type PlanIntent } from '../lib/plan-intent';
import { PLANS } from '../lib/plans';
import { npubOf } from '../lib/signer';
import type { BillingInterval, PaidPlan, StoreView } from '../lib/types';
import { useBusyUntilLeave } from '../lib/use-busy-until-leave';
import { BillingSwitch } from './BillingSwitch';
import { ContactLinks } from './ContactLinks';
import { CurrentPlan } from './CurrentPlan';
import { Notice } from './Notice';
import { PlanCard } from './PlanCard';
import { PlanCardAction } from './PlanCardAction';
import { Section } from './Section';
import { StartFree } from './StartFree';

interface Props {
  deps: Pick<SessionDeps, 'api' | 'openUrl'>;
  view: StoreView;
  /** Settings are stored: false only when none exist (not when they could not be read). */
  settingsSaved: boolean;
  /** Why the stored settings could not be read. */
  configError: string;
  /** After Free was chosen: the store and its settings are read again. */
  onPlanChosen: () => Promise<void>;
  /** The plan chosen on the landing: its card stands out and its button takes the focus. */
  intent?: PlanIntent;
  /** A checkout or the portal opened: the chosen plan is acted on. */
  onIntentDone: () => void;
}

const ENTERPRISE_TEXT = 'For Enterprise, message us with your Store ID.';

/**
 * Everything about paying (D6): the plan the store is on, every plan with what it offers in the
 * store's state, Monthly or Yearly (yearly first, as the landing). Paid plans are bought at Stripe
 * Checkout; a paying store's changes go through the billing portal, which confirms them.
 */
export function BillingSection({
  deps,
  view,
  settingsSaved,
  configError,
  onPlanChosen,
  intent,
  onIntentDone,
}: Props) {
  const [interval, setBillingInterval] = useState<BillingInterval>(intent?.interval ?? 'year');
  const [busy, setBusy] = useBusyUntilLeave<string>();
  const [error, setError] = useState('');
  const chosenButton = useRef<HTMLButtonElement>(null);
  // Opened with a plan chosen on the landing: its button is one key press away.
  useEffect(() => {
    chosenButton.current?.focus();
  }, []);

  const mode = billingModeOf(view);
  const current = currentPlanOf(view);

  const leave = async (key: string, open: () => Promise<{ url: string }>) => {
    setBusy(key);
    setError('');
    try {
      const { url } = await open();
      // Busy until the page leaves: a second press would open a second page.
      deps.openUrl(url);
      onIntentDone();
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(undefined);
    }
  };
  const checkout = (plan: PaidPlan) => {
    void leave(plan, () => deps.api.checkout(plan, interval));
  };
  const switchTo = (plan: PaidPlan) => {
    void leave(plan, () => deps.api.billingPortal({ action: 'switch', plan, interval }));
  };
  const cancel = () => {
    void leave('cancel', () => deps.api.billingPortal({ action: 'cancel' }));
  };

  const alreadyOn =
    intent !== undefined &&
    typeof current === 'object' &&
    current.plan === intent.plan &&
    current.interval === intent.interval;
  let contactText = ENTERPRISE_TEXT;
  if (mode.kind === 'through-us') {
    contactText = mode.text;
  } else if (mode.kind === 'choosing' && !mode.checkout) {
    contactText = PAID_THROUGH_US_TEXT;
  }

  return (
    <div className="flex flex-col gap-32">
      <Section title="Your plan" info={HELP.currentPlan}>
        <CurrentPlan deps={deps} view={view} onOpened={onIntentDone} />
      </Section>
      <Section title="Plans" info={HELP.planPicker}>
        <div id="plans" className="flex flex-col gap-16">
          <div className="flex flex-wrap items-center justify-between gap-12">
            <BillingSwitch value={interval} onChange={setBillingInterval} />
            <span className="text-12 text-text-3">Prices in USD, tax included.</span>
          </div>
          {alreadyOn ? (
            <Notice tone="info">
              You are already on {planName(intent.plan)}, billed {cycleOf(intent.interval)}.
            </Notice>
          ) : null}
          {mode.kind === 'locked' ? (
            <div id="billing-locked">
              <Notice tone="warn">{mode.line}</Notice>
            </div>
          ) : null}
          <ul className="grid grid-cols-1 gap-12 sm:grid-cols-2 lg:grid-cols-3">
            {PLANS.map((plan) => {
              const paid = plan.start === 'choose' ? paidPlanOf(plan.name) : undefined;
              const chosen = paid !== undefined && intent?.plan === paid;
              return (
                <PlanCard key={plan.name} plan={plan} interval={interval} chosen={chosen}>
                  <PlanCardAction
                    action={cardActionOf(mode, plan, interval, current)}
                    plan={paid}
                    busy={busy}
                    continues={chosen && intent?.interval === interval}
                    startFree={
                      <StartFree
                        deps={deps}
                        settingsSaved={settingsSaved}
                        configError={configError}
                        onPlanChosen={onPlanChosen}
                      />
                    }
                    {...(chosen ? { focusRef: chosenButton } : {})}
                    onCheckout={checkout}
                    onSwitch={switchTo}
                    onCancel={cancel}
                  />
                </PlanCard>
              );
            })}
          </ul>
          {error === '' ? null : <Notice tone="error">{error}</Notice>}
          <div className="flex flex-col gap-4">
            <p className="text-13 text-text-2">{contactText}</p>
            <ContactLinks storeId={npubOf(view.owner)} />
          </div>
        </div>
      </Section>
    </div>
  );
}
