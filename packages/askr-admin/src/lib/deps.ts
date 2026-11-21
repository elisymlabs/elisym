import type { NostrEvent } from 'nostr-tools';
import { AdminApi } from './api';
import { type BillingReturn, takeBillingReturn } from './billing';
import { SignedJournal } from './journal';
import { type RelayReader, relayReader } from './relay';
import type { Signer } from './signer';

/** The API calls the screens make: the real client, or a test double. */
export type AdminClient = Pick<
  AdminApi,
  | 'createStore'
  | 'setContactEmail'
  | 'store'
  | 'storeEvents'
  | 'choosePlan'
  | 'checkout'
  | 'billingPortal'
  | 'storedEvents'
  | 'pinnedWidget'
  | 'catalog'
  | 'putPolicy'
  | 'deletePolicy'
  | 'putConnector'
  | 'deleteConnector'
  | 'previewConnector'
  | 'enableConnector'
  | 'disableConnector'
  | 'rotateAssistant'
  | 'movedSettings'
  | 'recover'
>;

/** Everything a signed-in session uses. */
export interface SessionDeps {
  signer: Signer;
  api: AdminClient;
  reader: RelayReader;
  /** Unix seconds. */
  now: () => number;
  /** What this session signed and the server stored. */
  journal: SignedJournal;
  /** Leave for a page outside the admin (Stripe Checkout, the billing portal). */
  openUrl: (url: string) => void;
  /**
   * Whether the admin was opened on the way back from Stripe Checkout (`?billing=`): read from
   * the address the first time the signed-in admin asks, the same answer after.
   */
  takeBillingReturn: () => BillingReturn | undefined;
}

export function createSessionDeps(signer: Signer): SessionDeps {
  let billingReturn: { value: BillingReturn | undefined } | undefined;
  return {
    signer,
    api: new AdminApi({ signer }),
    reader: relayReader(),
    now: () => Math.floor(Date.now() / 1000),
    journal: new SignedJournal(),
    openUrl: (url) => globalThis.location.assign(url),
    takeBillingReturn: () => {
      billingReturn ??= { value: takeBillingReturn(globalThis.location, globalThis.history) };
      return billingReturn.value;
    },
  };
}

/** Store O-signed events on the server and remember them for later signatures. */
export async function postSigned(
  deps: SessionDeps,
  events: NostrEvent[],
): Promise<{ stored: string[] }> {
  const stored = await deps.api.storeEvents(events);
  deps.journal.note(events);
  return stored;
}
