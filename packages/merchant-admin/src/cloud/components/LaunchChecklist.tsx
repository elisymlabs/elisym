import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { ToneBadge } from '../../components/ToneBadge';
import type { ConsoleApi } from '../lib/api';
import { explain, explainAnswer } from '../lib/errors';
import { fieldOf } from '../lib/fields';
import type { StoreStatus } from '../lib/status';
import type { StoreStatusPoll } from '../lib/use-status';

interface Props {
  api: ConsoleApi;
  tenantId: string;
  status: StoreStatus;
  poll: StoreStatusPoll;
  /** The operator launches this store (an invited one). */
  byOperator: boolean;
  /** The domain the store keeps (its nip05), if any: checked again whenever it changes. */
  domain: string | undefined;
  /** Launched (or found launched): the store is read again. */
  onLaunched: () => void;
}

interface Check {
  key: string;
  label: string;
  ok: boolean;
  /** What to do while it does not hold. */
  todo: string;
}

/** The domain check, as `GET /tenants/:id/domain` answers it: read once, and on "Check again". */
type DomainCheck = { state: 'reading' } | { state: 'ok' } | { state: 'failed'; reason: string };

/** Why the domain check did not pass, in the check's own words when it gave them. */
function domainReason(answer: { status: number; body: unknown }): string {
  if (answer.status !== 200) {
    return explainAnswer(answer.body, answer.status);
  }
  const reason = fieldOf(answer.body, 'reason');
  return typeof reason === 'string' ? reason : explain(undefined, 200);
}

/**
 * The checks Launch runs, each green or saying what to do (plan section 3,
 * Launch): the store paid and not held, its key made, nothing still applying,
 * its settings, payouts and a product kept, and its domain when it names one.
 * Launch is enabled only when every check holds, and it is the merchant's
 * click; the step then waits for the store to be live.
 */
export function LaunchChecklist({
  api,
  tenantId,
  status,
  poll,
  byOperator,
  domain: keptDomain,
  onLaunched,
}: Props) {
  const [domain, setDomain] = useState<DomainCheck>({ state: 'reading' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [launched, setLaunched] = useState(false);
  const inFlight = useRef(false);
  const domainSet = status.gates.domainSet;

  // Only the newest check counts: one asked before the domain changed never turns the gate green.
  const checks = useRef(0);
  const checkDomain = useCallback(async () => {
    checks.current += 1;
    const asked = checks.current;
    setDomain({ state: 'reading' });
    const answer = await api.request('GET', `/tenants/${tenantId}/domain`);
    if (asked !== checks.current) {
      return;
    }
    if (answer.status === 200 && fieldOf(answer.body, 'levelA') === true) {
      setDomain({ state: 'ok' });
      return;
    }
    setDomain({ state: 'failed', reason: domainReason(answer) });
  }, [api, tenantId]);

  useEffect(() => {
    if (domainSet) {
      void checkDomain();
    }
  }, [domainSet, keptDomain, checkDomain]);

  const activation = status.gates.activation;
  const gates: Check[] = [
    {
      key: 'paid',
      label: 'Paid',
      ok: activation === undefined,
      todo: activation === undefined ? '' : explainAnswer({ error: activation }, 409),
    },
    {
      key: 'home',
      label: 'Store key made',
      ok: status.gates.homeReady,
      todo: 'Preparing your store: this takes a minute.',
    },
    {
      key: 'setup',
      label: 'Name, payouts and a product saved',
      ok: status.gates.storeSetUp,
      todo: 'Finish the steps above.',
    },
    {
      key: 'idle',
      label: 'Nothing still applying',
      ok: status.gates.noCyclePending,
      todo: 'A change is still applying: wait a moment.',
    },
    ...(domainSet
      ? [
          {
            key: 'domain',
            label: 'Your domain names this store',
            ok: domain.state === 'ok',
            todo: domain.state === 'failed' ? domain.reason : 'Checking your domain...',
          },
        ]
      : []),
  ];
  const ready = gates.every((check) => check.ok);

  const launch = async () => {
    if (inFlight.current || !ready) {
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError('');
    const answer = await api.request('POST', `/tenants/${tenantId}/launch`);
    inFlight.current = false;
    setBusy(false);
    if (answer.status === 200 || fieldOf(answer.body, 'error') === 'already_activated') {
      setLaunched(true);
      poll.watch();
      onLaunched();
      return;
    }
    setError(explainAnswer(answer.body, answer.status));
    poll.watch();
  };

  if (byOperator) {
    return (
      <p className="text-14 text-text-2 leading-relaxed">
        We launch it with you, once it is set up.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-16">
      <ul aria-live="polite" className="flex flex-col gap-8">
        {gates.map((check) => (
          <li key={check.key} data-check={check.key} className="flex flex-col gap-2">
            <span className="text-14 flex items-center gap-8">
              <ToneBadge tone={check.ok ? 'ok' : 'wait'}>{check.ok ? 'Done' : 'To do'}</ToneBadge>
              {check.label}
            </span>
            {check.ok ? null : <span className="text-13 text-text-2 pl-4">{check.todo}</span>}
          </li>
        ))}
      </ul>
      {ready ? null : (
        <Button
          size="sm"
          onClick={() => {
            poll.watch();
            if (domainSet) {
              void checkDomain();
            }
          }}
          className="self-start"
        >
          Check again
        </Button>
      )}
      <Button
        variant="primary"
        size="lg"
        disabled={!ready || busy || launched}
        onClick={() => void launch()}
        className="self-start"
      >
        Launch the store
      </Button>
      {launched ? (
        <p role="status" className="text-13 text-text-2">
          Launching: your store starts in a minute or two.
        </p>
      ) : null}
      {error === '' ? null : (
        <p role="alert" className="text-13 text-error">
          {error}
        </p>
      )}
    </div>
  );
}
