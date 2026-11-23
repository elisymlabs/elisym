import { startStoreNode } from '@merchant-node/store-node';

/**
 * Filled in by step 19 (boot order); for now it proves the merchant-node code bundles.
 *
 * Shutdown order (SIGTERM / SIGINT), each awaited before the next:
 * 1. `pump.stop()` - no new round; the round in progress and the drains the
 *    rounds started are done.
 * 2. `holder.idle()` - every kicked drain, suspension round and offer check
 *    still running is done (control tasks on the stores' queues).
 * 3. `supervisor.shutdown()` - every node stopped, the leases released.
 * The supervisor last: a drain or a tick still running after it would find
 * its stores gone (`NotServed`) halfway through a request.
 */
export const STORE_NODE_ENTRY = startStoreNode;
