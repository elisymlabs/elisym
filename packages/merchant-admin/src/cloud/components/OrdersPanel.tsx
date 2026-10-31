import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import type { ConsoleApi } from '../lib/api';
import { explainAnswer } from '../lib/errors';
import { type OrderCommand, type OrdersRead, ordersReadOf } from '../lib/orders';
import { payoutAssets } from '../lib/payouts';
import { shownTime } from '../lib/store-view';
import { Card } from './Card';
import { CommandConfirm } from './CommandConfirm';
import { HandAnswer } from './HandAnswer';
import { HandAnswered } from './HandAnswered';
import { OrderItem } from './OrderItem';

interface Props {
  api: ConsoleApi;
  tenantId: string;
  network: 'mainnet' | 'devnet';
  /** Hands a file to the browser to save. */
  download: (data: string | Uint8Array<ArrayBuffer>, fileName: string) => void;
}

/** The rails whose refund transactions the store reads (a Solana signature or a Tempo hash). */
const REFUND_RAILS: ReadonlySet<string> = new Set(['solana', 'tempo']);

interface Waiting {
  key: string;
  reasons: string[];
}

/** The orders only the owner can answer, each with why: open ones the store could not settle, and closed ones whose payment did. */
function waitingOn(read: OrdersRead): Waiting[] {
  const waiting = new Map<string, string[]>();
  const add = (key: string, reason: string) => {
    waiting.set(key, [...(waiting.get(key) ?? []), reason]);
  };
  for (const order of read.orders) {
    if (order.payment !== null) {
      continue;
    }
    for (const tx of order.feeUnresolved) {
      add(order.key, `Paid in ${tx}, but its fee went to no treasury the store knows.`);
    }
    if (order.blockedTx !== null) {
      add(order.key, `Paid in ${order.blockedTx}, but your payout's policy blocked it.`);
    }
  }
  for (const payment of read.unresolvedPayments) {
    add(
      payment.key,
      `Paid in ${payment.tx} (${shownTime(payment.at)}) after the order closed, with a fee that went to no treasury the store knows.`,
    );
  }
  return Array.from(waiting, ([key, reasons]) => ({ key, reasons }));
}

/**
 * The store's orders, read from its ledger through cloud-api (the store key
 * stays in the cloud): open and paid orders, the ones waiting for the owner's
 * answer, orders answered by hand, and expired ones as bare keys. The owner
 * commands are confirmed before they are queued; a CSV holds the same data.
 */
export function OrdersPanel({ api, tenantId, network, download }: Props) {
  const [read, setRead] = useState<OrdersRead | undefined>(undefined);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [csvError, setCsvError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [asked, setAsked] = useState<OrderCommand | undefined>(undefined);
  const latest = useRef(0);

  const load = useCallback(async () => {
    latest.current += 1;
    const seq = latest.current;
    setLoading(true);
    const answer = await api.request('GET', `/tenants/${tenantId}/orders`);
    if (seq !== latest.current) {
      return;
    }
    setLoading(false);
    const orders = answer.status === 200 ? ordersReadOf(answer.body) : undefined;
    if (orders !== undefined) {
      setRead(orders);
      setError('');
    } else {
      setError(explainAnswer(answer.status === 200 ? undefined : answer.body, answer.status));
    }
  }, [api, tenantId]);

  useEffect(() => {
    void load();
    return () => {
      latest.current += 1;
    };
  }, [load]);

  const exportCsv = async () => {
    if (exporting) {
      return;
    }
    setExporting(true);
    const answer = await api.request('GET', `/tenants/${tenantId}/orders.csv`);
    setExporting(false);
    if (answer.status === 200 && typeof answer.body === 'string') {
      setCsvError('');
      download(answer.body, `${tenantId}-orders.csv`);
    } else {
      setCsvError(explainAnswer(answer.status === 200 ? undefined : answer.body, answer.status));
    }
  };

  const refundAssets = payoutAssets(network, REFUND_RAILS);
  const waiting = read === undefined ? [] : waitingOn(read);

  return (
    <Card title="Orders">
      <div className="mt-12 flex gap-8">
        <Button disabled={loading} onClick={() => void load()}>
          Read the orders again
        </Button>
        <Button disabled={exporting} onClick={() => void exportCsv()}>
          Download CSV
        </Button>
      </div>
      {read === undefined && loading ? (
        <p className="text-14 text-text-3 mt-12">Loading...</p>
      ) : null}
      {error === '' ? null : (
        <p role="alert" className="text-14 text-error mt-12">
          {error}
        </p>
      )}
      {csvError === '' ? null : (
        <p role="alert" className="text-14 text-error mt-12">
          {csvError}
        </p>
      )}
      {asked === undefined ? null : (
        <CommandConfirm
          key={JSON.stringify(asked)}
          api={api}
          tenantId={tenantId}
          command={asked}
          onClose={() => setAsked(undefined)}
          onFinished={() => void load()}
        />
      )}
      {read === undefined ? null : (
        <>
          {waiting.length === 0 ? null : (
            <section className="mt-16">
              <h3 className="text-15 font-semibold">Waiting for your answer</h3>
              <ul>
                {waiting.map((each) => (
                  <HandAnswer
                    key={each.key}
                    orderKey={each.key}
                    reasons={each.reasons}
                    assets={refundAssets}
                    onAsk={setAsked}
                    busy={asked !== undefined}
                  />
                ))}
              </ul>
            </section>
          )}
          <section className="mt-16">
            <h3 className="text-15 font-semibold">Open and paid</h3>
            {read.orders.length === 0 ? (
              <p className="text-14 text-text-3 mt-8">No orders yet.</p>
            ) : (
              <ul>
                {read.orders.map((order) => (
                  <OrderItem
                    key={order.key}
                    order={order}
                    onAsk={setAsked}
                    busy={asked !== undefined}
                  />
                ))}
              </ul>
            )}
          </section>
          {read.answeredByHand.length === 0 ? null : (
            <section className="mt-16">
              <h3 className="text-15 font-semibold">Answered by hand</h3>
              <ul>
                {read.answeredByHand.map((answer) => (
                  <HandAnswered
                    key={answer.key}
                    answer={answer}
                    onAsk={setAsked}
                    busy={asked !== undefined}
                  />
                ))}
              </ul>
            </section>
          )}
          {read.closed.length === 0 ? null : (
            <section className="mt-16">
              <h3 className="text-15 font-semibold">Closed</h3>
              <p className="text-13 text-text-3">
                Unpaid orders past their life, and orders answered by hand: only the key is kept.
              </p>
              <ul className="text-13 text-text-2">
                {read.closed.map((key) => (
                  <li key={key} className="break-all">
                    {key}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </Card>
  );
}
