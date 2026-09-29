/**
 * The checkout core end to end on devnet, against the test merchant
 * (`packages/merchant-node`, `elisym-merchant run`): load the offer, order, pay with
 * a local key standing in for the wallet, watch the payment, hear the delivery.
 *
 *   BUYER_SECRETS=~/.elisym/<agent>/.secrets.json bun scripts/e2e-devnet.ts <naddr>
 *
 * Devnet only: the key must hold devnet SOL for fees and devnet USDC.
 */
import { readFileSync } from 'node:fs';
import { loadOffer } from '@elisym/commerce/buyer';
import { type OrderDeps, applyStatus, listenForStatus, placeOrder } from '@elisym/commerce/buyer';
import { isTerminal } from '@elisym/commerce/buyer';
import { OrderStore } from '@elisym/commerce/buyer';
import { createRelayClient } from '@elisym/commerce/buyer';
import {
  type SolanaWallet,
  composeOrderPayment,
  payWithSolana,
  watchSolanaPayment,
} from '@elisym/commerce/buyer';
import { signerFromSecretKeyBase58 } from '@elisym/pay-core';
import {
  createSolanaRpc,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
} from '@solana/kit';
import { IDBFactory } from 'fake-indexeddb';
import { finalizeEvent } from 'nostr-tools/pure';
import { IndexedDbOrderBackend, openOrderDatabase } from '../src/core/order-store-idb';

const RPC_URL = 'https://api.devnet.solana.com';
const PAGE_ORIGIN = 'https://merchant.example';
const WATCH_EVERY_MS = 5_000;
const GIVE_UP_MS = 5 * 60_000;

function log(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const naddr = process.argv[2];
  const secretsPath = process.env.BUYER_SECRETS;
  if (naddr === undefined || secretsPath === undefined) {
    throw new Error('usage: BUYER_SECRETS=<path> bun scripts/e2e-devnet.ts <naddr>');
  }
  let secrets: { solana_secret_key?: unknown };
  try {
    secrets = JSON.parse(readFileSync(secretsPath, 'utf8')) as { solana_secret_key?: unknown };
  } catch {
    // Never the parser's own message: it can quote the file, which may hold a key.
    throw new Error('BUYER_SECRETS is not a readable JSON secrets file');
  }
  if (typeof secrets.solana_secret_key !== 'string') {
    throw new Error('no plain solana_secret_key in that file');
  }
  const signer = await signerFromSecretKeyBase58(secrets.solana_secret_key);
  const wallet: SolanaWallet = {
    address: signer.address,
    async signTransaction(bytes) {
      const transaction = getTransactionDecoder().decode(bytes);
      const signed = await partiallySignTransaction([signer.keyPair], transaction);
      return new Uint8Array(getTransactionEncoder().encode(signed));
    },
  };
  log(`buyer wallet ${wallet.address}`);

  const rpc = createSolanaRpc(RPC_URL);
  const store = new OrderStore(
    new IndexedDbOrderBackend(await openOrderDatabase(new IDBFactory())),
  );
  const readClient = createRelayClient();
  const deps: OrderDeps & { rpc: typeof rpc } = {
    store,
    readClient,
    clientFor: (buyerSecretKey) =>
      createRelayClient({ auth: async (template) => finalizeEvent(template, buyerSecretKey) }),
    rpc,
  };

  const offer = await loadOffer(naddr, {
    client: readClient,
    pageOrigin: PAGE_ORIGIN,
    families: ['solana'],
    network: 'devnet',
  });
  if (!offer.ok) {
    throw new Error(`offer refused: ${offer.refusal} (${offer.message})`);
  }
  const payout = offer.payouts[0];
  if (payout === undefined) {
    throw new Error('no payout');
  }
  log(
    `offer "${offer.offer.product.title}" level ${offer.offer.level}, ${payout.amount} subunits to ${payout.target.address}`,
  );
  if (offer.confirm.length > 0 || offer.notices.length > 0) {
    log(`warnings: ${[...offer.confirm, ...offer.notices].join(', ')}`);
  }

  const slot = await rpc.getSlot({ commitment: 'finalized' }).send();
  const chainTime = Number(await rpc.getBlockTime(slot).send());
  const placed = await placeOrder(
    { offer, payout, chainTime, deviceTime: Math.floor(Date.now() / 1000) },
    deps,
  );
  if (!placed.ok) {
    throw new Error(`order not placed: ${placed.reason}`);
  }
  log(
    `order ${placed.record.orderId} acknowledged by ${placed.record.acknowledgedRelays.join(', ')}`,
  );
  const composed = await composeOrderPayment(placed.record, store);
  if (!composed.ok) {
    throw new Error(`request not composed: ${composed.reason}`);
  }

  const paid = await payWithSolana(composed.record, wallet, { fresh: offer, chainTime }, deps);
  if (!paid.ok) {
    throw new Error(
      `not paid: ${paid.reason}${paid.detail === undefined ? '' : ` (${paid.detail})`}${
        paid.needed === undefined ? '' : ` needs ${paid.needed}, has ${paid.available}`
      }`,
    );
  }
  log(`sent ${paid.signature}; receipt ${paid.record.receiptWrap === undefined ? 'not ' : ''}sent`);

  let delivered: string | undefined;
  const listening = listenForStatus(paid.record, paid.record.inboxRelays, deps, (message) => {
    log(`store status: ${message.status}`);
    void applyStatus(store, paid.record.orderId, message, Math.floor(Date.now() / 1000)).then(
      (record) => {
        if (record?.state === 'completed') {
          delivered = record.status?.delivery;
        }
      },
    );
  });

  const orderId = paid.record.orderId;
  const started = Date.now();
  let found = false;
  try {
    await watchUntilAnswered();
  } finally {
    listening.close();
    readClient.close();
  }

  async function watchUntilAnswered(): Promise<void> {
    while (Date.now() - started < GIVE_UP_MS && delivered === undefined) {
      const current = await store.get(orderId);
      if (current === undefined) {
        throw new Error('record lost');
      }
      // Delivered or refunded: the store has answered.
      if (isTerminal(current)) {
        break;
      }
      if (!found) {
        const watch = await watchSolanaPayment(current, deps);
        log(`watch: ${watch.state}`);
        if (watch.state === 'paid') {
          found = true;
          log(`payment found: ${watch.record.paidTx}`);
        } else if (watch.state === 'closed') {
          log(`the store answered first: ${watch.record.state}`);
          break;
        } else if (watch.state === 'over') {
          throw new Error('attempt over without a payment');
        }
      }
      await sleep(WATCH_EVERY_MS);
    }
  }
  const final = await store.get(paid.record.orderId);
  const delivery = final?.state === 'completed' ? final.status?.delivery : delivered;
  log(`final state ${final?.state}, delivery ${delivery ?? 'none'}`);
  if (delivery === undefined) {
    throw new Error(`no delivery (state ${final?.state})`);
  }
}

await main();
process.exit(0);
