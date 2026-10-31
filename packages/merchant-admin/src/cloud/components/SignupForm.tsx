import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import type { ConsoleApi } from '../lib/api';
import { explain } from '../lib/errors';
import { fieldOf } from '../lib/fields';
import { type StartTier, startTierFrom } from '../lib/tiers';
import { Card } from './Card';

interface Props {
  api: ConsoleApi;
  /** The tier id the `/start` link named (the catalog says whether it may be started). */
  tier: string;
  termsVersion: string;
  /** Where the terms of service and acceptable-use policy are read. */
  termsUrl: string | undefined;
  onDone: () => void;
  /** The terms changed since they were shown: the console reads them again. */
  onTermsChanged: () => void;
}

/** `/start`: this key opens a store on the chosen plan, once the terms are accepted. */
export function SignupForm({ api, tier, termsVersion, termsUrl, onDone, onTermsChanged }: Props) {
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Set before any await: a second click in the same moment sends nothing.
  const inFlight = useRef(false);
  // Undefined while the catalog loads; `none` when it names no tier a merchant may start;
  // `unloaded` when it could not be read (another try is offered).
  const [plan, setPlan] = useState<StartTier | 'none' | 'unloaded' | undefined>(undefined);
  const [loads, setLoads] = useState(0);

  useEffect(() => {
    let current = true;
    void api.request('GET', '/tiers').then((answer) => {
      if (current) {
        // A 200 that is not a catalog (a proxy's page) is unreadable, not a plan the catalog refuses.
        const catalog = answer.status === 200 && Array.isArray(fieldOf(answer.body, 'tiers'));
        setPlan(catalog ? (startTierFrom(answer.body, tier) ?? 'none') : 'unloaded');
      }
    });
    return () => {
      current = false;
    };
  }, [api, tier, loads]);

  const signUp = async () => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setBusy(true);
    const answer = await api.request('POST', '/signup', { tier, terms: termsVersion });
    if (answer.status === 200) {
      // Stays busy: the console reloads with the store.
      onDone();
      return;
    }
    inFlight.current = false;
    setBusy(false);
    const code = fieldOf(answer.body, 'error');
    setError(explain(code, answer.status));
    if (code === 'terms_not_accepted') {
      setAccepted(false);
      onTermsChanged();
    }
  };

  if (plan === 'none') {
    return (
      <Card title="Start a store">
        <p role="alert" className="text-14 text-text-2 mt-8 leading-relaxed">
          This plan cannot be started here. Pick a plan on the pricing page, or contact us.
        </p>
      </Card>
    );
  }

  if (plan === 'unloaded') {
    return (
      <Card title="Start a store">
        <p role="alert" className="text-14 text-error mt-8 leading-relaxed">
          The plans could not be loaded. Check your connection and try again.
        </p>
        <Button
          onClick={() => {
            setPlan(undefined);
            setLoads((count) => count + 1);
          }}
          size="lg"
          full
          className="mt-16"
        >
          Try again
        </Button>
      </Card>
    );
  }

  return (
    <Card
      title={plan === undefined ? 'Start a store' : `Start a ${plan.name} store (${plan.price})`}
    >
      <p className="text-14 text-text-2 mt-8 leading-relaxed">
        This key becomes the store&apos;s owner. You pay after this step; nothing runs until you do.
      </p>
      <label className="text-14 mt-16 flex items-start gap-8">
        <input
          type="checkbox"
          checked={accepted}
          onChange={(event) => setAccepted(event.target.checked)}
        />
        <span>
          I accept the{' '}
          {termsUrl === undefined ? (
            'terms of service and acceptable-use policy'
          ) : (
            <a
              href={termsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2"
            >
              terms of service and acceptable-use policy
            </a>
          )}{' '}
          (version {termsVersion}).
        </span>
      </label>
      <p role="alert" className="text-13 text-error mt-8 empty:hidden">
        {error}
      </p>
      <Button
        disabled={!accepted || busy || plan === undefined}
        onClick={() => void signUp()}
        variant="primary"
        size="lg"
        full
        className="mt-16"
      >
        Create the store
      </Button>
    </Card>
  );
}
