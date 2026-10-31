import { useRef, useState } from 'react';
import { Button } from '../../components/Button';
import type { ConsoleApi } from '../lib/api';
import { explain } from '../lib/errors';
import { fieldOf } from '../lib/fields';
import { type TierCard, paidBy } from '../lib/tiers';
import { Card } from './Card';

interface Props {
  api: ConsoleApi;
  /** The plan picked (a self-serve plan with a way to pay). */
  tier: TierCard;
  termsVersion: string;
  /** Where the terms of service are read. */
  termsUrl: string | undefined;
  onDone: () => void;
  /** The terms changed since they were shown: the admin reads them again. */
  onTermsChanged: () => void;
  /** A signup went out (true) or came back refused (false): the plans wait for it. */
  onBusy: (busy: boolean) => void;
}

/** This access key opens a store on the picked plan, once the terms are accepted. */
export function SignupForm({
  api,
  tier,
  termsVersion,
  termsUrl,
  onDone,
  onTermsChanged,
  onBusy,
}: Props) {
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Set before any await: a second click in the same moment sends nothing.
  const inFlight = useRef(false);

  const signUp = async () => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setBusy(true);
    onBusy(true);
    const answer = await api.request('POST', '/signup', { tier: tier.id, terms: termsVersion });
    if (answer.status === 200) {
      // Stays busy: the console reloads with the store.
      onDone();
      return;
    }
    inFlight.current = false;
    setBusy(false);
    onBusy(false);
    const code = fieldOf(answer.body, 'error');
    setError(explain(code, answer.status));
    if (code === 'terms_not_accepted') {
      setAccepted(false);
      onTermsChanged();
    }
  };

  return (
    <Card title={`Start a ${tier.name} store (${tier.price})`}>
      <p className="text-14 text-text-2 mt-8 leading-relaxed">
        This access key becomes the store&apos;s owner. You pay the first month next; nothing runs
        until you do.
      </p>
      <p className="text-13 text-text-3 mt-4">{paidBy(tier.payable)}</p>
      <label className="text-14 mt-16 flex items-start gap-8">
        <input
          type="checkbox"
          checked={accepted}
          onChange={(event) => setAccepted(event.target.checked)}
        />
        <span>
          I accept the{' '}
          {termsUrl === undefined ? (
            'terms of service'
          ) : (
            <a
              href={termsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2"
            >
              terms of service
            </a>
          )}{' '}
          (version {termsVersion}).
        </span>
      </label>
      <p role="alert" className="text-13 text-error mt-8 empty:hidden">
        {error}
      </p>
      <Button
        disabled={!accepted || busy}
        onClick={() => void signUp()}
        variant="primary"
        size="lg"
        full
        className="mt-16"
      >
        Create my store
      </Button>
    </Card>
  );
}
