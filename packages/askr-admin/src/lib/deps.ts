import type { NostrEvent } from 'nostr-tools';
import { EXTENSION_SYNC_POLL_MS, SYNC_POLL_MS } from '../constants';
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

/** How often to re-read the store during a sync: rarely when every read may prompt an extension. */
export function syncPollMs(signer: Pick<Signer, 'kind'>): number {
  return signer.kind === 'extension' ? EXTENSION_SYNC_POLL_MS : SYNC_POLL_MS;
}
