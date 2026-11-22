import { type ReactNode, useState } from 'react';
import { ApiError } from '../lib/api';
import { contactEmailOf } from '../lib/contact';
import type { SessionDeps } from '../lib/deps';
import { errorMessage } from '../lib/errors';
import { PAID_THROUGH_US_TEXT, type PlanIntent } from '../lib/plan-intent';
import { saveSettings } from '../lib/save';
import { npubOf } from '../lib/signer';
import { EMPTY_FORM } from '../lib/store-form';
import type { StoreView } from '../lib/types';
import { useBusyUntilLeave } from '../lib/use-busy-until-leave';
import { ContactLinks } from './ContactLinks';
import { Notice } from './Notice';
import { PlanIntentLine } from './PlanIntentLine';
import { type PlanStep, PlanSteps } from './PlanSteps';
import { Section } from './Section';
import { StoreSettingsForm } from './StoreSettingsForm';
import { TextField } from './TextField';

interface Props {
  deps: SessionDeps;
  /** The store, once created. */
  view: StoreView | undefined;
  onCreated: (view: StoreView) => void;
  onDone: () => Promise<void>;
  onSignOut: () => void;
  /** The paid plan chosen on the landing: paid for right after the store is created (D4). */
  intent?: PlanIntent;
  /** Its checkout opened, or it was dismissed or cannot be bought here. */
  onIntentDone?: () => void;
  /** Back from Stripe: what the return says, above the steps. */
  billingNotice?: ReactNode;
  /** Where a visitor who chose a plan on the landing is: 2 before paying, 3 just paid. */
  step?: PlanStep;
}

const INTENT_CREATE_TEXT = 'Create your store to go on to checkout.';
const INTENT_STEP_TWO_TEXT = 'Pay for it now, or describe your store first.';

/**
 * Create the store, then sign its first config and key authorization in one step (7.3). With a
 * plan chosen on the landing, its checkout follows the store's creation: checkout needs no
 * settings, so the store is described after paying, or before.
 */
export function Onboarding({
  deps,
  view,
  onCreated,
  onDone,
  onSignOut,
  intent,
  onIntentDone = () => undefined,
  billingNotice,
  step,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** A refused checkout, said next to Continue to checkout in step 2. */
  const [checkoutError, setCheckoutError] = useState('');
  const [leaving, setLeaving] = useBusyUntilLeave<true>();
  const [typedEmail, setTypedEmail] = useState('');
  const email = contactEmailOf(typedEmail);
  const ownerNpub = npubOf(deps.signer.pubkey);

  /** Open the chosen plan's checkout: true once the page is leaving for it. */
  const checkout = async (chosen: PlanIntent): Promise<boolean> => {
    setCheckoutError('');
    try {
      const { url } = await deps.api.checkout(chosen.plan, chosen.interval);
      deps.openUrl(url);
      onIntentDone();
      return true;
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === 'billing_unavailable') {
        setCheckoutError(PAID_THROUGH_US_TEXT);
        onIntentDone();
      } else {
        setCheckoutError(errorMessage(failure));
      }
      return false;
    }
  };

  const create = async () => {
    setBusy(true);
    setError('');
    let created: StoreView;
    try {
      created = await deps.api.createStore(email);
    } catch (failure) {
      // The chosen plan stays: a retry creates the store and goes on to its checkout.
      setError(errorMessage(failure));
      setBusy(false);
      return;
    }
    // The checkout first: step 2 then says why it was refused, next to its retry.
    if (intent !== undefined) {
      await checkout(intent);
    }
    setBusy(false);
    onCreated(created);
  };

  const continueToCheckout = async (chosen: PlanIntent) => {
    setLeaving(true);
    if (!(await checkout(chosen))) {
      setLeaving(undefined);
    }
  };

  let createLabel = intent === undefined ? 'Create my store' : 'Create my store and pay';
  if (busy) {
    createLabel = 'Creating...';
  }
  return (
    <main className="mx-auto flex max-w-720 flex-col gap-20 px-16 py-32">
      <header className="flex items-center justify-between gap-12">
        <h1 className="text-24 font-semibold">Set up your assistant</h1>
        <button type="button" className="btn" onClick={onSignOut}>
          Sign out
        </button>
      </header>
      {step === undefined ? null : <PlanSteps current={step} />}
      {billingNotice}
      {intent === undefined ? (
        <Notice tone="info">
          Save your settings, then choose a plan in Billing: Free starts at once, with nothing to
          pay; a paid plan starts as soon as you pay for it.
        </Notice>
      ) : null}
      {view === undefined && intent !== undefined ? (
        <PlanIntentLine intent={intent} next={INTENT_CREATE_TEXT} onDismiss={onIntentDone} />
      ) : null}
      {view !== undefined && intent !== undefined && view.billing.checkoutAvailable ? (
        <PlanIntentLine intent={intent} next={INTENT_STEP_TWO_TEXT} onDismiss={onIntentDone}>
          <button
            type="button"
            id="intent-checkout"
            className="btn btn-primary"
            disabled={leaving === true}
            aria-busy={leaving === true}
            onClick={() => void continueToCheckout(intent)}
          >
            Continue to checkout
          </button>
        </PlanIntentLine>
      ) : null}
      {view === undefined || checkoutError === '' ? null : (
        <Notice tone="error">
          <span className="flex flex-col gap-4">
            <span>{checkoutError}</span>
            {checkoutError === PAID_THROUGH_US_TEXT ? <ContactLinks storeId={ownerNpub} /> : null}
          </span>
        </Notice>
      )}
      {view === undefined ? (
        <Section
          title="Create your store"
          description="This sets up your assistant on the Askr server for this Store ID."
        >
          <p className="text-13 text-text-3 font-mono break-all">{ownerNpub}</p>
          <TextField
            id="onboarding-email"
            label="Your email"
            value={typedEmail}
            placeholder="you@yourshop.com"
            hint="Where the Askr operator writes to you about your plan and account: when its budget runs out, or when your store is activated. Kept on the Askr server only, never published."
            onChange={setTypedEmail}
          />
          {error === '' ? null : <Notice tone="error">{error}</Notice>}
          <div>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || email === undefined}
              onClick={() => void create()}
            >
              {createLabel}
            </button>
          </div>
        </Section>
      ) : (
        <div className="flex flex-col gap-20">
          <div className="flex flex-col gap-2">
            <h2 className="text-18 font-semibold">Describe your store</h2>
            <p className="text-13 text-text-2">
              You sign these settings with your secret key. They tell the assistant what to sell and
              where it may run.
            </p>
          </div>
          <StoreSettingsForm
            initial={EMPTY_FORM}
            submitLabel="Sign and save"
            onSubmit={async (form) => {
              const outcome = await saveSettings({ deps, view, form });
              if (outcome.connectorError !== undefined) {
                throw new Error(outcome.connectorError);
              }
              await onDone();
              return 'Saved.';
            }}
          />
        </div>
      )}
    </main>
  );
}
