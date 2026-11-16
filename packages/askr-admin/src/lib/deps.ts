import type { NostrEvent } from 'nostr-tools';
import { AdminApi } from './api';
import { SignedJournal } from './journal';
import { type RelayReader, relayReader } from './relay';
import type { Signer } from './signer';

/** The API calls the screens make: the real client, or a test double. */
export type AdminClient = Pick<
  AdminApi,
  | 'createStore'
  | 'store'
  | 'storeEvents'
  | 'storedEvents'
  | 'pinnedWidget'
  | 'catalog'
  | 'putPolicy'
  | 'deletePolicy'
  | 'putConnector'
  | 'deleteConnector'
  | 'previewConnector'
  | 'enableConnector'
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
}

export function createSessionDeps(signer: Signer): SessionDeps {
  return {
    signer,
    api: new AdminApi({ signer }),
    reader: relayReader(),
    now: () => Math.floor(Date.now() / 1000),
    journal: new SignedJournal(),
  };
}

/** Store O-signed events on the server and remember them for later signatures. */
export async function postSigned(deps: SessionDeps, events: NostrEvent[]): Promise<void> {
  await deps.api.storeEvents(events);
  deps.journal.note(events);
}
