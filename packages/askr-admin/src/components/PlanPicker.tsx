import { useState } from 'react';
import { PRICING_URL } from '../constants';
import { ApiError } from '../lib/api';
import type { SessionDeps } from '../lib/deps';
import { errorMessage } from '../lib/errors';
import { HELP } from '../lib/help';
import { PLANS } from '../lib/plans';
import { npubOf } from '../lib/signer';
import { ContactLinks } from './ContactLinks';
import { InfoTip } from './InfoTip';
import { Notice } from './Notice';

interface Props {
  deps: Pick<SessionDeps, 'api'>;
  /** The Store ID's hex form: the paid cards quote it. */
  owner: string;
  /** Settings are stored: false only when none exist (not when they could not be read). */
  settingsSaved: boolean;
  /** Why the stored settings could not be read: shown instead of "Save your settings first". */
  configError: string;
  /** Read the store and its settings again: activation publishes the stored config (6.5). */
  onPlanChosen: () => Promise<void>;
}

const SAVE_FIRST = 'Save your settings first.';
const FREE_UNAVAILABLE = 'Free is not available right now. Message us with your Store ID.';
/** The store changed meanwhile (6.1): reading it again shows its new status. */
const CHANGED_MEANWHILE = new Set(['not_pending', 'operator_managed']);
const FREE_REFUSED = new Set(['capacity_reached', 'free_unavailable']);

const CARD = 'rounded-10 border-line flex flex-col gap-8 border px-14 py-12';
const FREE_PLAN = PLANS.find((plan) => plan.start === 'admin');
const SOLO_PAID = PLANS.filter((plan) => plan.start === 'choose' && plan.group === undefined);
const SIZES = PLANS.filter((plan) => plan.group === 'sizes');
const BY_AGREEMENT = PLANS.filter((plan) => plan.start === 'contact');

/**
 * A pending store with no plan yet chooses one (6.5): Free at once, a paid
 * plan by a message to us with the Store ID (until a checkout replaces it).
 */
export function PlanPicker({ deps, owner, settingsSaved, configError, onPlanChosen }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const startFree = async () => {
    setBusy(true);
    setError('');
    try {
      await deps.api.choosePlan('free');
      await onPlanChosen();
    } catch (failure) {
      const code = failure instanceof ApiError ? failure.code : undefined;
      if (code !== undefined && CHANGED_MEANWHILE.has(code)) {
        await onPlanChosen();
      } else if (code !== undefined && FREE_REFUSED.has(code)) {
        setError(FREE_UNAVAILABLE);
      } else if (code === 'no_settings') {
        setError(SAVE_FIRST);
      } else {
        setError(errorMessage(failure));
      }
    } finally {
      setBusy(false);
    }
  };

  let freeHint = '';
  if (!settingsSaved) {
    freeHint = configError === '' ? SAVE_FIRST : configError;
  }
  const disabled = busy || (!settingsSaved && configError === '');

  return (
    <div id="plan-picker" className="flex flex-col gap-12">
      <div className="flex items-center gap-6">
        <h3 className="text-14 font-semibold">Choose a plan</h3>
        <InfoTip help={HELP.planPicker} about="Choose a plan" />
      </div>
      <div className="grid grid-cols-1 gap-12 sm:grid-cols-2">
        {FREE_PLAN === undefined ? null : (
          <div className={CARD}>
            <p className="text-14 font-semibold">{FREE_PLAN.name}</p>
            <p className="text-13 text-text-2">{FREE_PLAN.monthly} a month</p>
            <button
              type="button"
              id="start-free"
              className="btn btn-primary self-start"
              disabled={disabled}
              aria-busy={busy}
              onClick={() => void startFree()}
            >
              Start on Free
            </button>
            {freeHint === '' ? null : <p className="text-13 text-text-2">{freeHint}</p>}
          </div>
        )}
        {SOLO_PAID.map((plan) => (
          <div key={plan.name} className={CARD}>
            <p className="text-14 font-semibold">{plan.name}</p>
            <p className="text-13 text-text-2">{plan.monthly} a month</p>
          </div>
        ))}
        {SIZES.length === 0 ? null : (
          <div className={CARD}>
            <p className="text-14 font-semibold">{SIZES.map((plan) => plan.name).join(' / ')}</p>
            <ul className="text-13 text-text-2 flex flex-col gap-2">
              {SIZES.map((plan) => (
                <li key={plan.name}>
                  {plan.name}: {plan.monthly} a month
                </li>
              ))}
            </ul>
          </div>
        )}
        {BY_AGREEMENT.map((plan) => (
          <div key={plan.name} className={CARD}>
            <p className="text-14 font-semibold">{plan.name}</p>
            <p className="text-13 text-text-2">
              {plan.from === true ? 'from ' : ''}
              {plan.monthly} a month
            </p>
          </div>
        ))}
      </div>
      {error === '' ? null : <Notice tone="error">{error}</Notice>}
      <div className="flex flex-col gap-4">
        <p className="text-13 text-text-2">
          For a paid plan, message us with your Store ID and we set it up.
        </p>
        <ContactLinks storeId={npubOf(owner)} />
      </div>
      <a
        className="text-13 text-text-2 hover:text-text self-start underline underline-offset-2"
        href={PRICING_URL}
        target="_blank"
        rel="noreferrer"
      >
        Every plan and its limits
      </a>
    </div>
  );
}
