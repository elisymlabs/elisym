import type { TrustLevel } from '@elisym/commerce';
import { TrustChip } from './TrustChip';

export interface StoreInfo {
  name: string | undefined;
  level: TrustLevel;
  domain: string | undefined;
}

interface Props {
  store: StoreInfo | undefined;
  testNetwork: boolean;
}

/** The store, as named by its own (untrusted) profile, and how far it is verified. */
export function Header({ store, testNetwork }: Props) {
  return (
    <header class="header">
      <h1 id="store-name" tabindex={-1}>
        {store === undefined ? 'Checkout' : (store.name ?? 'Unnamed store')}
      </h1>
      <div class="badges">
        {testNetwork ? <span class="badge">Test network</span> : null}
        {store === undefined ? null : <TrustChip level={store.level} domain={store.domain} />}
      </div>
    </header>
  );
}
