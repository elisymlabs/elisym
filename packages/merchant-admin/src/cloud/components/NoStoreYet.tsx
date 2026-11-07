import { useCallback, useState } from 'react';
import { Button } from '../../components/Button';
import type { ApiAnswer, ConsoleApi } from '../lib/api';
import type { TierCard } from '../lib/tiers';
import { KeyInUseWarning } from './KeyInUseWarning';
import { PlanPicker } from './PlanPicker';
import { RedeemForm } from './RedeemForm';
import { SignupForm } from './SignupForm';

interface Props {
  api: ConsoleApi;
  loadTiers: () => Promise<ApiAnswer>;
  /** The plan a `/start` link chose, if any: picked at once when it can be started. */
  startTier: string | undefined;
  termsVersion: string;
  termsUrl: string | undefined;
  /** What the sign-in found (the relays showed nothing, say). */
  notice: string | undefined;
  /** The key already signed for a store on the relays. */
  inUse: boolean;
  /** A store now belongs to this key (signed up or redeemed): read it again. */
  onStore: () => void;
}

/**
 * A key with no store here (plan `admin-onboarding.md` 2.3): never a dead end.
 * An invite comes first (the operator made a store for this key), then the
 * plans and the signup for the one picked.
 */
export function NoStoreYet({
  api,
  loadTiers,
  startTier,
  termsVersion,
  termsUrl,
  notice,
  inUse,
  onStore,
}: Props) {
  const [invite, setInvite] = useState(false);
  const [chosen, setChosen] = useState<TierCard | undefined>(undefined);
  const choose = useCallback((tier: TierCard) => setChosen(tier), []);
  // A signup on its way: kept here, since picking another plan remounts the form.
  const [signingUp, setSigningUp] = useState(false);

  return (
    <>
      {notice === undefined ? null : (
        <div
          role="status"
          className="rounded-12 bg-surface-2 text-14 text-text-2 flex flex-col gap-8 p-16"
        >
          <p>{notice}</p>
          <p>
            If this is the key of a store you run yourself, do not create a store here with it:
            check the key, or try again later.
          </p>
        </div>
      )}
      {invite ? (
        <RedeemForm api={api} onDone={onStore} />
      ) : (
        <p className="text-14 text-text-2">
          Have an invite from us?{' '}
          <Button size="sm" onClick={() => setInvite(true)}>
            Use your invite
          </Button>
        </p>
      )}
      {inUse ? <KeyInUseWarning /> : null}
      <PlanPicker
        loadTiers={loadTiers}
        preselect={startTier}
        chosen={chosen?.id}
        onChoose={choose}
        locked={signingUp}
      />
      {chosen === undefined ? null : (
        <SignupForm
          key={chosen.id}
          api={api}
          tier={chosen}
          termsVersion={termsVersion}
          termsUrl={termsUrl}
          onDone={onStore}
          onTermsChanged={onStore}
          onBusy={setSigningUp}
        />
      )}
    </>
  );
}
