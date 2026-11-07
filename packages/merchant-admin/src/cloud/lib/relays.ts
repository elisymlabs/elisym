/**
 * The relays the cloud part of the admin reads the owner's own events from
 * (the owner's payout list and the store's AUTH, never cloud-api's copy):
 * `DEFAULT_RELAYS` and the elisym relay, once each.
 */
import { DEFAULT_RELAYS } from '@elisym/commerce/buyer';

/** The relay the cloud's stores list on; the admin reads owner events there too. */
export const ELISYM_RELAY = 'wss://relay.elisym.network';

/** The relays the cloud part reads: `DEFAULT_RELAYS` and the elisym relay, once each. */
export const CLOUD_RELAYS: readonly string[] = [...new Set([...DEFAULT_RELAYS, ELISYM_RELAY])];
