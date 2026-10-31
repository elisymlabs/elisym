import type { RelayQuery } from './key-in-use';
import type { OwnerSigner } from './owner-key';
import type { WalletProviders } from './wallet';

/** What signing the owner's events needs, handed down from the signed-in console. */
export interface OwnerTools {
  /** The owner key (held by the console in a ref; it signs, it is never shown). */
  signer: OwnerSigner;
  /** Reads the owner's events from the default relays. */
  relayQuery: RelayQuery;
  /** The page's wallet extensions, for a payout's proof. */
  wallets: WalletProviders;
  /** The cloud's domain, which the AUTH names as the store's operator. */
  operator: string;
  /** The local clock, in seconds: what owner events are dated by. */
  localNow: () => number;
  /** Hands a file to the browser to save. */
  download: (data: string | Uint8Array<ArrayBuffer>, fileName: string) => void;
}
