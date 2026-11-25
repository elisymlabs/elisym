import type { EventTemplate, NostrEvent } from 'nostr-tools';
import type { HostedApi } from './api';
import type { ProvenPayouts } from './proven';
import type { Signer } from './signer';
import type { Meta } from './types';

/** What the store screens call. */
export type StoreApi = Pick<
  HostedApi,
  | 'meta'
  | 'store'
  | 'createStore'
  | 'putConfig'
  | 'products'
  | 'putProduct'
  | 'deleteProduct'
  | 'prepareOwnerEvent'
  | 'commitOwnerEvent'
  | 'request'
  | 'orders'
  | 'handAnswer'
  | 'rotateWebhookSecret'
  | 'suspend'
  | 'prepareMove'
  | 'move'
>;

/** A move the server took: the page goes on as the new owner, following the store's setup request. */
export interface CompletedMove {
  /** O': from now on the page's only key. */
  signer: Signer;
  /** The setup request to follow, read by O'; none when there is nothing to follow. */
  requestId: string | undefined;
}

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
  /** After a move: O is closed and the page goes on signed in as O'. */
  switchOwner: (move: CompletedMove) => void;
}
