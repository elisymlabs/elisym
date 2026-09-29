/**
 * One contender in the two-process race of `orders-store.test.ts`: set the
 * marker of order `race` at version 2 in the agent directory `argv[2]`, as
 * attempt `argv[3]`, and print the store's answer.
 */
import { OrderStore } from '@elisym/commerce/buyer';
import { FileOrderBackend } from '../../src/storage/orders.js';

const [, , dir, attemptId] = process.argv;
if (dir === undefined || attemptId === undefined) {
  throw new Error('usage: orders-race-child <agent dir> <attempt id>');
}
const store = new OrderStore(new FileOrderBackend(dir, { durable: false }));
const result = await store.setMarker('race', 2, {
  rail: 'solana',
  attemptId,
  setAt: 1,
  blockhash: 'B',
  lastValidBlockHeight: '1',
  slot: '1',
});
process.stdout.write(
  JSON.stringify({ ok: result.ok, reason: result.ok ? undefined : result.reason }),
);
