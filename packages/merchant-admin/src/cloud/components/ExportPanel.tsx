import { useRef, useState } from 'react';
import { Button } from '../../components/Button';
import type { ConsoleApi } from '../lib/api';
import { explainAnswer } from '../lib/errors';
import {
  DWELL_WARNING,
  EXPORT_CONSEQUENCE,
  EXPORT_STOPPED,
  NO_NODE_WARNING,
  WITHDRAW_CONSEQUENCE,
} from '../lib/sale';
import type { StoreView } from '../lib/store-view';
import { Card } from './Card';
import { ConfirmStep } from './ConfirmStep';

interface Props {
  api: ConsoleApi;
  tenantId: string;
  view: StoreView;
  onStoreChanged: () => void;
}

/**
 * The owner's export: the store leaves the cloud with its home. A store on
 * sale is offered "withdraw before export" (the cloud delivers the orders
 * already paid before it stops); exporting before the store has stopped is
 * said to leave those orders with no node. Whether an export is under way
 * comes from the store itself (the cloud retries a failed step by itself),
 * so it holds across reloads.
 */
export function ExportPanel({ api, tenantId, view, onStoreChanged }: Props) {
  const [asking, setAsking] = useState<'withdraw' | 'export' | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);

  const post = async (path: 'withdraw' | 'export') => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setBusy(true);
    const answer = await api.request('POST', `/tenants/${tenantId}/${path}`);
    inFlight.current = false;
    setBusy(false);
    setAsking(undefined);
    setError(answer.status === 200 ? '' : explainAnswer(answer.body, answer.status));
    onStoreChanged();
  };

  let warning = '';
  if (!view.withdrawn) {
    warning = NO_NODE_WARNING;
  } else if (!view.stopped) {
    warning = DWELL_WARNING;
  }

  if (view.exporting) {
    return (
      <Card title="Leave the cloud">
        <p role="status" className="text-14 mt-12">
          Exporting: the store is being stopped and its handover packed. This can take a few
          minutes; a step that fails is tried again by the cloud.
        </p>
      </Card>
    );
  }
  return (
    <Card title="Leave the cloud">
      <p className="text-14 text-text-2 mt-12">
        Export hands you the store to run on your own node: its home (keys, orders, products,
        settings) and the store key passphrase.
      </p>
      {view.stopped ? null : (
        <p className="text-14 mt-8">
          Take the store off sale first, and export once the Sale panel says it stopped: until then
          the cloud delivers the orders already paid.
        </p>
      )}
      {view.exportStopped === undefined ? null : (
        <p role="alert" className="text-14 text-error mt-12">
          {EXPORT_STOPPED[view.exportStopped]}
        </p>
      )}
      {error === '' ? null : (
        <p role="alert" className="text-14 text-error mt-12">
          {error}
        </p>
      )}
      {asking === 'export' ? (
        <ConfirmStep
          consequence={`${EXPORT_CONSEQUENCE}${warning}`}
          confirmLabel="Confirm: export"
          busy={busy}
          onConfirm={() => void post('export')}
          onCancel={() => setAsking(undefined)}
        />
      ) : null}
      {asking === 'withdraw' ? (
        <ConfirmStep
          consequence={WITHDRAW_CONSEQUENCE}
          confirmLabel="Confirm: take it off sale"
          busy={busy}
          onConfirm={() => void post('withdraw')}
          onCancel={() => setAsking(undefined)}
        />
      ) : null}
      {asking === undefined ? (
        <div className="mt-12 flex gap-8">
          {view.withdrawn ? null : (
            <Button onClick={() => setAsking('withdraw')} variant="primary">
              Withdraw before export
            </Button>
          )}
          <Button onClick={() => setAsking('export')}>
            {view.stopped ? 'Export' : 'Export now'}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
