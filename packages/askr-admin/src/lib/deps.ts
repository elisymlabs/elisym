import { AdminApi } from './api';
import { type RelayReader, relayReader } from './relay';
import type { Signer } from './signer';

/** The API calls the screens make: the real client, or a test double. */
export type AdminClient = Pick<
  AdminApi,
  | 'createStore'
  | 'store'
  | 'storeEvents'
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
}

export function createSessionDeps(signer: Signer): SessionDeps {
  return {
    signer,
    api: new AdminApi({ signer }),
    reader: relayReader(),
    now: () => Math.floor(Date.now() / 1000),
  };
}
