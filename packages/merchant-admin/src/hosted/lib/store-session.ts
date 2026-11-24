import type { EventTemplate, NostrEvent } from 'nostr-tools';
import type { HostedApi } from './api';
import type { ProvenPayouts } from './proven';
import type { Meta } from './types';

/** What the store screens call. */
export type StoreApi = Pick<
  HostedApi,
  | 'meta'
  | 'store'
  | 'createStore'
  | 'putConfig'
  | 'products'
  | 'prepareOwnerEvent'
  | 'commitOwnerEvent'
  | 'request'
>;

/** A signed-in owner's session, as every store screen gets it. */
export interface StoreSession {
  api: StoreApi;
  /** O, hex. */
  owner: string;
  /** The committed operator (`PAYCORE_OPERATOR`): the only one an authorization may name. */
  operator: string;
  meta: Meta;
  /** O's signature: the signer in the page's memory. */
  signEvent: (template: EventTemplate) => Promise<NostrEvent>;
  /** The payout proofs made and checked in this browser session. */
  proven: ProvenPayouts;
  /** Seconds. */
  localNow: () => number;
  /** How a followed request waits between reads (tests shorten it). */
  sleep?: (ms: number) => Promise<void>;
}
