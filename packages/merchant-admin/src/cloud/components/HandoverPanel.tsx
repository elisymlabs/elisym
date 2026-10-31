import { useRef, useState } from 'react';
import { Button } from '../../components/Button';
import type { ConsoleApi } from '../lib/api';
import { explainAnswer } from '../lib/errors';
import { DESTROY_CONSEQUENCE } from '../lib/sale';
import { type ExportView, shownTime } from '../lib/store-view';
import { Card } from './Card';
import { ConfirmStep } from './ConfirmStep';

interface Props {
  api: ConsoleApi;
  tenantId: string;
  exported: ExportView;
  download: (data: string | Uint8Array<ArrayBuffer>, fileName: string) => void;
  onStoreChanged: () => void;
  /** The cloud's copy was destroyed: the store page gives way. */
  onDestroyed: () => void;
}

/**
 * An exported store: its handover archive to download, and the owner's
 * confirmation that its own node runs, which destroys the cloud's copy at
 * once (else the cloud destroys it on the date shown).
 */
export function HandoverPanel({
  api,
  tenantId,
  exported,
  download,
  onStoreChanged,
  onDestroyed,
}: Props) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);

  const fetchArchive = async () => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setBusy(true);
    const answer = await api.requestBytes(`/tenants/${tenantId}/export/archive`);
    inFlight.current = false;
    setBusy(false);
    if (answer.status === 200) {
      setError('');
      download(answer.bytes, `${tenantId}-handover.tar.gz`);
    } else {
      setError(explainAnswer(answer.body, answer.status));
    }
  };

  const destroy = async () => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setBusy(true);
    const answer = await api.request('POST', `/tenants/${tenantId}/export/confirm`);
    inFlight.current = false;
    setBusy(false);
    setAsking(false);
    if (answer.status === 200) {
      setError('');
      onDestroyed();
    } else {
      setError(explainAnswer(answer.body, answer.status));
    }
  };

  return (
    <Card title="Handover">
      <p className="text-14 mt-12">
        {exported.exportedAt === undefined
          ? 'The store left our cloud.'
          : `The store left our cloud on ${shownTime(exported.exportedAt)}.`}{' '}
        Run it on your own node with the handover: its HANDOVER.md has the steps.
      </p>
      {exported.destroyAt === undefined ? null : (
        <p className="text-14 text-text-2 mt-8">
          The cloud still holds the store key (it can read the orders and, where it vouches for the
          store, name a new owner) until {shownTime(exported.destroyAt)}: it destroys its copy then,
          or as soon as you confirm your own node runs.
        </p>
      )}
      {error === '' ? null : (
        <p role="alert" className="text-14 text-error mt-12">
          {error}
        </p>
      )}
      {exported.archiveReady ? (
        <>
          <p className="text-14 text-text-2 mt-8">
            The handover holds the store key passphrase: keep it as safe as your owner key.
          </p>
          {asking ? (
            <ConfirmStep
              consequence={DESTROY_CONSEQUENCE}
              confirmLabel="Confirm: destroy the cloud's copy"
              busy={busy}
              onConfirm={() => void destroy()}
              onCancel={() => setAsking(false)}
            />
          ) : (
            <div className="mt-12 flex flex-wrap gap-8">
              <Button disabled={busy} onClick={() => void fetchArchive()} variant="primary">
                Download the handover
              </Button>
              <Button disabled={busy} onClick={() => setAsking(true)}>
                My own node runs: destroy the cloud&apos;s copy
              </Button>
            </div>
          )}
        </>
      ) : (
        <>
          <p role="status" className="text-14 mt-8">
            The handover is being packed: refresh in a minute.
          </p>
          <Button onClick={onStoreChanged} className="mt-12">
            Refresh
          </Button>
        </>
      )}
    </Card>
  );
}
