import { useCallback, useEffect, useRef, useState } from 'react';
import { AuthLayout } from '../../components/AuthLayout';
import { Button } from '../../components/Button';
import { Stepper } from '../../components/Stepper';
import type { ApiAnswer, ConsoleApi } from '../lib/api';
import { type CreateStage, createSteps } from '../lib/create-steps';
import { explain } from '../lib/errors';
import { fieldOf } from '../lib/fields';
import type { TierCard } from '../lib/tiers';
import { AccessKeyStep } from './AccessKeyStep';
import { PlanPicker } from './PlanPicker';
import { SignupForm } from './SignupForm';

interface Props {
  /** Reads the plan catalog (`GET /tiers`, no auth). */
  loadTiers: () => Promise<ApiAnswer>;
  /** The plan to start on (a `/start` link's, or one picked before a sign-in), if any. */
  preselect: string | undefined;
  /** The access key made in this visit: `CloudApp` holds it, this flow never does. */
  made: { npub: string } | undefined;
  /** Signs as the made key; none before it exists. */
  api: ConsoleApi | undefined;
  termsUrl: string | undefined;
  onCreateKey: () => void;
  onSaveKey: () => void;
  /** The store exists now: the console reads it. */
  onStore: () => void;
  /** To the one sign-in field, with the plan picked so far. */
  onSignIn: (tier: string | undefined) => void;
  /** Back to the admin's front door. */
  onBack: (() => void) | undefined;
}

/** What `GET /owner` said for the made key before the signup. */
type Terms =
  | { state: 'loading' }
  | { state: 'failed'; message: string }
  | { state: 'ready'; version: string };

const HEADINGS: Record<CreateStage, string> = {
  plan: 'Choose a plan',
  key: 'Save your access key',
  signup: 'Accept the terms and create your store',
};

/**
 * Creating a store before it exists (plan `admin-onboarding.md` 2.2): a plan,
 * an access key made and saved here, then the terms and the signup. Going back
 * to the plan keeps the key; a step past the current one does not open.
 */
export function CreateFlow({
  loadTiers,
  preselect,
  made,
  api,
  termsUrl,
  onCreateKey,
  onSaveKey,
  onStore,
  onSignIn,
  onBack,
}: Props) {
  const [stage, setStage] = useState<CreateStage>('plan');
  const [chosen, setChosen] = useState<TierCard | undefined>(undefined);
  const choose = useCallback((tier: TierCard) => setChosen(tier), []);
  const [saved, setSaved] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [terms, setTerms] = useState<Terms>({ state: 'loading' });
  const [termsReads, setTermsReads] = useState(0);
  const [signingUp, setSigningUp] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const shown = useRef<CreateStage>(stage);

  // A step change moves focus to its heading; the first screen keeps the page's own focus.
  useEffect(() => {
    if (shown.current !== stage) {
      shown.current = stage;
      heading.current?.focus();
    }
  }, [stage]);

  // The terms version comes with the key's own `GET /owner`, read when the signup step opens.
  useEffect(() => {
    if (stage !== 'signup' || api === undefined) {
      return;
    }
    // A read again (the terms changed) keeps the form, and its words, on screen meanwhile.
    let current = true;
    void api.request('GET', '/owner').then((answer) => {
      if (!current) {
        return;
      }
      const version = fieldOf(answer.body, 'termsVersion');
      if (answer.status === 200 && typeof fieldOf(answer.body, 'tenantId') === 'string') {
        onStore();
      } else if (answer.status === 200 && typeof version === 'string') {
        setTerms({ state: 'ready', version });
      } else {
        setTerms({
          state: 'failed',
          message: explain(fieldOf(answer.body, 'error'), answer.status),
        });
      }
    });
    return () => {
      current = false;
    };
  }, [stage, api, termsReads, onStore]);

  const steps = createSteps(stage);
  const open = (key: string) => {
    const step = steps.find((each) => each.key === key);
    if (step !== undefined && !step.locked && !signingUp) {
      setStage(step.key);
    }
  };

  return (
    <AuthLayout>
      <div className="rounded-20 border-line bg-surface grid w-full max-w-880 gap-24 border p-24 shadow-sm sm:p-32 md:grid-cols-[200px_minmax(0,1fr)]">
        <Stepper steps={steps} onSelect={open} label="Create a store" />
        <section className="flex min-w-0 flex-col gap-16">
          <h1
            ref={heading}
            tabIndex={-1}
            className="text-24 font-semibold tracking-tight outline-none"
          >
            {HEADINGS[stage]}
          </h1>
          {stage === 'plan' ? (
            <>
              <PlanPicker
                loadTiers={loadTiers}
                preselect={chosen?.id ?? preselect}
                chosen={chosen?.id}
                onChoose={choose}
                locked={false}
              />
              <Button
                disabled={chosen === undefined}
                onClick={() => setStage('key')}
                variant="primary"
                size="lg"
                full
              >
                Continue
              </Button>
            </>
          ) : null}
          {stage === 'key' ? (
            <AccessKeyStep
              made={made}
              saved={saved}
              confirmed={confirmed}
              onCreate={onCreateKey}
              onSave={() => {
                onSaveKey();
                setSaved(true);
              }}
              onConfirm={setConfirmed}
              onContinue={() => setStage('signup')}
              onSignIn={() => onSignIn(chosen?.id)}
            />
          ) : null}
          {stage === 'signup' && chosen !== undefined && api !== undefined ? (
            <>
              {terms.state === 'loading' ? (
                <p className="text-14 text-text-3">Loading the terms...</p>
              ) : null}
              {terms.state === 'failed' ? (
                <div className="flex flex-col items-start gap-12">
                  <p role="alert" className="text-14 text-error">
                    {terms.message}
                  </p>
                  <Button onClick={() => setTermsReads((reads) => reads + 1)}>Try again</Button>
                </div>
              ) : null}
              {terms.state === 'ready' ? (
                <SignupForm
                  api={api}
                  tier={chosen}
                  termsVersion={terms.version}
                  termsUrl={termsUrl}
                  onDone={onStore}
                  onTermsChanged={() => setTermsReads((reads) => reads + 1)}
                  onBusy={setSigningUp}
                />
              ) : null}
            </>
          ) : null}
          {onBack === undefined ? null : (
            <Button onClick={onBack} size="sm" disabled={signingUp} className="self-start">
              Back
            </Button>
          )}
        </section>
      </div>
    </AuthLayout>
  );
}
