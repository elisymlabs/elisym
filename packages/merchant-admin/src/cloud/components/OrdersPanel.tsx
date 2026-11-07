import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { OrdersSection } from '../../components/OrdersSection';
import { Section } from '../../components/Section';
import type { ConsoleApi } from '../lib/api';
import { explainAnswer } from '../lib/errors';
import { orderRowsOf } from '../lib/order-rows';
import type { OrderCommand, OrdersRead } from '../lib/orders';
import { payoutAssets } from '../lib/payouts';
import { shownTime } from '../lib/store-view';
import type { CloudOrders } from '../lib/use-cloud-orders';
import { CommandConfirm } from './CommandConfirm';
import { HandAnswer } from './HandAnswer';
import { HandAnswered } from './HandAnswered';
import { OrderActions } from './OrderActions';

interface Props {
  api: ConsoleApi;
  tenantId: string;
  network: 'mainnet' | 'devnet';
  /** The store's orders, read once for the whole page. */
  orders: CloudOrders;
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
 * The cloud store's Orders page: the shared order list over the store's
 * ledger (read through cloud-api: the store key stays in the cloud), the
 * orders waiting for the owner's answer above it, orders answered by hand and
 * expired ones below it. Each order's own commands sit in its details, and
 * are confirmed before they are queued; the CSV is the cloud's own.
 */
export function OrdersPanel({ api, tenantId, network, orders, download }: Props) {
  const [csvError, setCsvError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [asked, setAsked] = useState<OrderCommand | undefined>(undefined);
  const { read } = orders;
  // The button that asked a command: the focus goes back to it once the confirmation closes.
  const opener = useRef<HTMLElement | null>(null);
  const ask = (command: OrderCommand) => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setAsked(command);
  };
  useEffect(() => {
    if (asked !== undefined || opener.current === null) {
      return;
    }
    if (opener.current.isConnected) {
      opener.current.focus();
    }
    opener.current = null;
  }, [asked]);

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
  const rows = read === undefined ? [] : orderRowsOf(read.orders);
  const byKey = new Map((read?.orders ?? []).map((order) => [order.key, order]));

  const before = (
    <>
      {read === undefined && orders.loading ? (
        <p className="text-14 text-text-3">Loading...</p>
      ) : null}
      {orders.error === '' ? null : (
        <p role="alert" className="text-14 text-error">
          {orders.error}
        </p>
      )}
      {csvError === '' ? null : (
        <p role="alert" className="text-14 text-error">
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
          onFinished={orders.reload}
        />
      )}
      {waiting.length === 0 ? null : (
        <section className="rounded-16 border-line bg-surface border p-16">
          <h2 className="text-15 font-semibold">Waiting for your answer</h2>
          <ul>
            {waiting.map((each) => (
              <HandAnswer
                key={each.key}
                orderKey={each.key}
                reasons={each.reasons}
                assets={refundAssets}
                onAsk={ask}
                busy={asked !== undefined}
              />
            ))}
          </ul>
        </section>
      )}
    </>
  );

  const after =
    read === undefined ? null : (
      <>
        {read.answeredByHand.length === 0 ? null : (
          <section>
            <h2 className="text-15 font-semibold">Answered by hand</h2>
            <ul>
              {read.answeredByHand.map((answer) => (
                <HandAnswered
                  key={answer.key}
                  answer={answer}
                  onAsk={ask}
                  busy={asked !== undefined}
                />
              ))}
            </ul>
          </section>
        )}
        {read.closed.length === 0 ? null : (
          <section>
            <h2 className="text-15 font-semibold">Closed</h2>
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
    );

  const reread = (
    <Button disabled={orders.loading} onClick={orders.reload}>
      Read the orders again
    </Button>
  );

  // Not read yet (or the read failed): no list, so a failure never shows as "no orders".
  if (read === undefined) {
    return (
      <Section
        title="Orders"
        heading="h1"
        description="Every order of your store, with what your store credited for it."
        actions={reread}
      >
        {before}
      </Section>
    );
  }

  return (
    <OrdersSection
      rows={rows}
      busy={orders.loading}
      source="cloud"
      csv={{
        title: 'Every order of your store, whatever the filters',
        run: () => void exportCsv(),
        busy: exporting,
      }}
      tools={reread}
      before={before}
      after={after}
      actionsFor={(row) => {
        const order = byKey.get(row.key);
        return order === undefined ? null : (
          <OrderActions order={order} onAsk={ask} busy={asked !== undefined} />
        );
      }}
    />
  );
}
