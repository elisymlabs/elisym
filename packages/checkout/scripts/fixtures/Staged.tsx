import { useEffect, useState } from 'preact/hooks';
import { type Actions, Checkout } from '../../src/app/Checkout';
import type { CannedView } from './canned';

interface Props {
  canned: CannedView;
  actions: Actions;
}

/** One fixture: its view, then its `next` view once mounted, as a session would draw them. */
export function Staged({ canned, actions }: Props) {
  const [view, setView] = useState(canned.view);
  useEffect(() => {
    if (canned.next !== undefined) {
      setView(canned.next);
    }
  }, [canned.next]);
  return (
    <Checkout
      screen={{ kind: 'loading' }}
      view={view}
      banner={canned.name === 'offer' ? { orderId: 'x', state: 'completed' } : undefined}
      actions={actions}
      {...canned.props}
    />
  );
}
