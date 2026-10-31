import { useRef, useState } from 'react';
import { Button } from '../../components/Button';
import type { ConsoleApi } from '../lib/api';
import { explainAnswer } from '../lib/errors';
import { fieldOf } from '../lib/fields';
import { RESUME_CONSEQUENCE, WITHDRAW_CONSEQUENCE } from '../lib/sale';
import { type StoreView, shownTime } from '../lib/store-view';
import { useFollowedCycle } from '../lib/use-followed-cycle';
import { Card } from './Card';
import { ConfirmStep } from './ConfirmStep';

interface Props {
  api: ConsoleApi;
  tenantId: string;
  view: StoreView;
  /** The store changed: its view is read again. */
  onStoreChanged: () => void;
}

/** Whether the store is on sale, and the owner's withdraw and Resume, each confirmed first. */
export function SalePanel({ api, tenantId, view, onStoreChanged }: Props) {
  const [asking, setAsking] = useState<'withdraw' | 'resume' | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  // A Resume runs as a cycle (the listings go out in its setup): it is followed until it ran.
  const [resumeCycle, setResumeCycle] = useState<number | undefined>(undefined);
  const resumed = useFollowedCycle(api, tenantId, resumeCycle, onStoreChanged);

  const send = async (step: 'withdraw' | 'resume') => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setBusy(true);
    const answer = await api.request('POST', `/tenants/${tenantId}/${step}`);
    inFlight.current = false;
    setBusy(false);
    setAsking(undefined);
    setError(answer.status === 200 ? '' : explainAnswer(answer.body, answer.status));
    const cycleId = fieldOf(answer.body, 'cycleId');
    if (step === 'resume' && answer.status === 200 && typeof cycleId === 'number') {
      setResumeCycle(cycleId);
    }
    onStoreChanged();
  };

  const since = view.withdrawnAt === undefined ? '' : ` since ${shownTime(view.withdrawnAt)}`;
  const resuming =
    resumeCycle !== undefined && (resumed === undefined || resumed.stage === 'waiting');
  let status = 'On sale.';
  if (view.exporting) {
    status = 'Being exported: see Leave the cloud.';
  } else if (resuming && !view.withdrawn) {
    status = 'Going back on sale: its listings go out once the change is applied.';
  } else if (view.withdrawn && view.stopped) {
    status = `Off sale${since}, and stopped.`;
  } else if (view.withdrawn) {
    status = `Off sale${since}. Paid orders are still delivered until the store stops.`;
  }
  let resumeProblem = '';
  let resumeRetry = '';
  if (resumed?.stage === 'failed' && resumed.retried) {
    resumeRetry = `A step failed and the cloud tries it again: ${resumed.reason}. The listings go out once it goes through.`;
  } else if (resumed?.stage === 'failed') {
    resumeProblem = `Resume did not go through: ${resumed.reason}. Refresh the store to see where it stands.`;
  } else if (resumed?.stage === 'lost' || resumed?.stage === 'replaced') {
    resumeProblem = 'Resume cannot be followed here: refresh the store to see where it stands.';
  }
  let why = '';
  if (view.exporting) {
    // Said by the export.
  } else if (view.held) {
    why = 'elisym holds the store: contact elisym.';
  } else if (view.withdrawn && view.ownerWithdrawn) {
    why = 'You took it off sale: it stays so until you Resume it.';
  } else if (view.withdrawn) {
    why = 'It went off sale when its paid time ran out: pay to put it back on sale.';
  }

  return (
    <Card title="Sale">
      <p role="status" className="text-14 mt-12">
        {status}
      </p>
      {why === '' ? null : <p className="text-14 text-text-2 mt-4">{why}</p>}
      {error === '' ? null : (
        <p role="alert" className="text-14 text-error mt-12">
          {error}
        </p>
      )}
      {resumeRetry === '' ? null : (
        <p role="status" className="text-14 text-text-2 mt-12">
          {resumeRetry}
        </p>
      )}
      {resumeProblem === '' ? null : (
        <p role="alert" className="text-14 text-error mt-12">
          {resumeProblem}
        </p>
      )}
      {view.exporting || resuming || asking !== undefined ? null : (
        <div className="mt-12 flex gap-8">
          {view.withdrawn ? null : (
            <Button onClick={() => setAsking('withdraw')}>Take the store off sale</Button>
          )}
          {view.withdrawn && !view.held ? (
            <Button onClick={() => setAsking('resume')}>Resume</Button>
          ) : null}
        </div>
      )}
      {view.exporting || resuming || asking === undefined ? null : (
        <ConfirmStep
          consequence={asking === 'withdraw' ? WITHDRAW_CONSEQUENCE : RESUME_CONSEQUENCE}
          confirmLabel={asking === 'withdraw' ? 'Confirm: take it off sale' : 'Confirm: Resume'}
          busy={busy}
          onConfirm={() => void send(asking)}
          onCancel={() => setAsking(undefined)}
        />
      )}
    </Card>
  );
}
