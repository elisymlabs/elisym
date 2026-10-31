import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { Field } from '../../components/Field';
import { Input } from '../../components/Input';
import { describedBy } from '../../lib/field';
import type { ConsoleApi } from '../lib/api';
import { explainAnswer } from '../lib/errors';
import { fieldOf } from '../lib/fields';
import { saveVerdict } from '../lib/save-wait';
import { choiceOf, emptyForm } from '../lib/settings';
import type { StoreStatus } from '../lib/status';
import type { KeptStore } from '../lib/use-kept-store';
import type { StoreStatusPoll } from '../lib/use-status';

interface Props {
  api: ConsoleApi;
  tenantId: string;
  status: StoreStatus;
  poll: StoreStatusPoll;
  kept: KeptStore;
  /** The name was saved and kept. */
  onSettled?: () => void;
}

/**
 * The store's name: one field. A rename sends the whole choice the store has
 * (or waits to keep) with only its name replaced, so it never drops a rail,
 * the domain, the webhook or an own RPC; and it waits until the store keeps
 * the name (by state, never by a cycle id).
 */
export function NameStep({ api, tenantId, status, poll, kept, onSettled }: Props) {
  const startForm = kept.read?.waitingForm ?? kept.read?.form;
  const [name, setName] = useState(status.kept.name ?? '');
  const [touched, setTouched] = useState(false);
  // The name saved, and the status read asked for after it: only that read (or a later one) judges it.
  const [sent, setSent] = useState<{ name: string; seq: number } | undefined>(undefined);
  const [error, setError] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  // Prefilled from what is kept until the merchant types.
  const keptName = status.kept.name;
  useEffect(() => {
    if (!touched && keptName !== undefined) {
      setName(keptName);
    }
  }, [keptName, touched]);

  const verdict = saveVerdict({
    sentSeq: sent?.seq,
    statusSeq: poll.statusSeq,
    kept: sent !== undefined && status.kept.name === sent.name,
    pending: status.pending,
  });
  const applied = verdict === 'applied';
  const refused = verdict === 'refused';
  const waiting = verdict === 'waiting';

  // Said once per save: a step opened again later stays open.
  const settledFor = useRef<typeof sent>(undefined);
  useEffect(() => {
    if (applied && settledFor.current !== sent) {
      settledFor.current = sent;
      onSettled?.();
    }
  }, [applied, sent, onSettled]);
  const shownProblems = refused ? (status.lastProblems.store ?? []) : problems;

  const save = async () => {
    if (inFlight.current || startForm === undefined) {
      return;
    }
    const trimmed = name.trim();
    if (trimmed === '') {
      setError('Give your store a name.');
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError('');
    setProblems([]);
    const form =
      kept.read?.saved === true || kept.read?.waitingForm !== undefined ? startForm : emptyForm();
    const answer = await api.request('POST', `/tenants/${tenantId}/store`, {
      ...choiceOf({ ...form, name: trimmed }),
    });
    inFlight.current = false;
    setBusy(false);
    if (answer.status === 200) {
      kept.reload();
      setSent({ name: trimmed, seq: poll.watch() });
      return;
    }
    const detail = fieldOf(answer.body, 'detail');
    if (fieldOf(answer.body, 'error') === 'store_refused' && typeof detail === 'string') {
      setProblems(detail.split('\n'));
      return;
    }
    setError(explainAnswer(answer.body, answer.status));
  };

  if (status.storePubkey === undefined) {
    return (
      <p role="status" className="text-14 text-text-2">
        Preparing your store: this takes a minute.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-16">
      <Field
        id="setup-store-name"
        label="Store name"
        hint="As buyers see it in the checkout."
        error={error === '' ? undefined : error}
      >
        <Input
          id="setup-store-name"
          value={name}
          maxLength={100}
          autoComplete="off"
          aria-describedby={describedBy(
            'setup-store-name',
            'hint',
            error === '' ? undefined : error,
          )}
          onChange={(event) => {
            setTouched(true);
            setName(event.target.value);
          }}
        />
      </Field>
      <Button
        variant="primary"
        size="lg"
        disabled={busy || startForm === undefined || waiting}
        onClick={() => void save()}
        className="self-start"
      >
        {status.kept.name === undefined ? 'Save and continue' : 'Save the name'}
      </Button>
      {waiting ? (
        <p role="status" className="text-13 text-text-2">
          {poll.expired ? 'Still applying, we keep trying.' : 'Saving...'}
        </p>
      ) : null}
      {poll.expired && waiting ? (
        <Button size="sm" onClick={poll.watch} className="self-start">
          Check again
        </Button>
      ) : null}
      {applied ? (
        <p role="status" className="text-13 text-text-2">
          Saved.
        </p>
      ) : null}
      {refused && shownProblems.length === 0 ? (
        <p role="alert" className="text-13 text-error">
          Something failed on our side; we have been alerted.
        </p>
      ) : null}
      {shownProblems.length === 0 ? null : (
        <ul role="alert" className="text-13 text-error list-disc pl-20">
          {shownProblems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
