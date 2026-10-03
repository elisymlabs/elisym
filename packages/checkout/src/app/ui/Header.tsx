import type { StoreInfo } from '../session';
import { TrustChip } from './TrustChip';

interface Props {
  store: StoreInfo | undefined;
  testNetwork: boolean;
}

/**
 * The store, as named by its own (untrusted) profile, and how far it is
 * verified - no chip when the level is not known now (an order's old snapshot).
 */
export function Header({ store, testNetwork }: Props) {
  return (
    <header class="header">
      <h1 id="store-name" tabindex={-1}>
        {store === undefined ? 'Checkout' : (store.name ?? 'Unnamed store')}
      </h1>
      <div class="badges">
        {testNetwork ? <span class="badge">Test network</span> : null}
        {store?.level === undefined ? null : (
          <TrustChip level={store.level} domain={store.domain} />
        )}
      </div>
    </header>
  );
}
