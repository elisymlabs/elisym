/** The owner's sale and leaving steps, as each confirmation says them (plan sections 3-4). */

/** What taking the store off sale does. */
export const WITHDRAW_CONSEQUENCE =
  'Take every product off sale now. Orders already paid are still delivered: the store keeps running until they are (at least 3 days 15 min), then it stops. It stays off sale, paid or not, until you Resume it.';

/** What Resume does. */
export const RESUME_CONSEQUENCE =
  'Put the store back on sale: its products and payouts, as you saved them, go out again. RPCs and inbox relays the withdrawal replaced stay replaced: set them again in the store settings if you want yours back.';

/** What an export does. */
export const EXPORT_CONSEQUENCE =
  'Export the store: the cloud stops it for good and hands over its home and the store key passphrase. This cannot be undone: the store does not come back to the cloud.';

/** Added to the export's consequence for a store still on sale. */
export const NO_NODE_WARNING =
  ' It is on sale now: until your own node starts, nothing delivers its orders. Start yours within 3 days 15 min, or paid orders go undelivered.';

/** Added to the export's consequence for a store off sale that has not stopped yet. */
export const DWELL_WARNING =
  ' The cloud is still delivering the orders already paid: exporting now ends that, and until your own node starts nothing delivers them. Start yours within 3 days 15 min, or paid orders go undelivered. Waiting until the store has stopped avoids this.';

/** What confirming the own node destroys. */
export const DESTROY_CONSEQUENCE =
  "Destroy the cloud's copy of the store now: its home, its backups, the store key passphrase and the handover archive. Your owner key is freed, and this admin no longer shows the store. Download the handover first: this cannot be undone.";

/**
 * Why an export stopped and what to do: its last setup (dropping the dedicated relays) was
 * refused. A store taken off sale first exports without the payout list (its setup publishes
 * only store-signed events).
 */
export const EXPORT_STOPPED: Record<'resign' | 'revoked', string> = {
  resign:
    'The export stopped: the store refused its payout list, which must be signed again. Sign it again in Payouts, then export again; or take the store off sale first, then export (an off-sale store needs no payout list).',
  revoked:
    'The export stopped: you revoked this store. Re-authorize it in Payouts, then export again; or take the store off sale first, then export (an off-sale store needs no authorization).',
};
