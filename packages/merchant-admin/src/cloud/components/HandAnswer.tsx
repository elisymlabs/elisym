import { useState } from 'react';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { type OrderCommand, refundSubunits, refundTxOf } from '../lib/orders';
import type { PayoutAsset } from '../lib/payouts';

interface Props {
  /** The order the owner answers by hand. */
  orderKey: string;
  /** Why it waits for the owner: the payments the store could not settle. */
  reasons: string[];
  /** The coins a refund can be reported in (the rails the store's refunds are read on). */
  assets: PayoutAsset[];
  onAsk: (command: OrderCommand) => void;
  busy: boolean;
}

/**
 * An order only its owner can answer (a payment that reached the payout but
 * that the store could not settle): close it as completed, or report a refund
 * the owner sent. Each is confirmed before it is queued.
 */
export function HandAnswer({ orderKey, reasons, assets, onAsk, busy }: Props) {
  const [refunding, setRefunding] = useState(false);
  const [tx, setTx] = useState('');
  const [amount, setAmount] = useState('');
  const [asset, setAsset] = useState(assets[0]?.caip19 ?? '');
  const [problem, setProblem] = useState('');

  const askRefund = () => {
    const subunits = refundSubunits(amount, asset);
    const refundTx = refundTxOf(tx, asset);
    if (refundTx === undefined) {
      setProblem(
        'Paste the transaction of the refund you sent, on the chain of the coin refunded (a Solana signature, or a Tempo hash).',
      );
      return;
    }
    if (subunits === undefined) {
      setProblem('The amount is not one this coin takes (a positive number, within its decimals).');
      return;
    }
    setProblem('');
    onAsk({ kind: 'refund', key: orderKey, tx: refundTx, amount: subunits, asset, again: false });
  };

  return (
    <li className="border-line flex flex-col gap-8 border-b py-12">
      <p className="text-13 break-all">Order {orderKey}</p>
      <ul className="text-13 text-text-2 list-disc pl-20">
        {reasons.map((reason, index) => (
          <li key={`${index} ${reason}`} className="break-all">
            {reason}
          </li>
        ))}
      </ul>
      <div className="flex gap-8">
        <Button
          disabled={busy}
          onClick={() => onAsk({ kind: 'complete', key: orderKey, again: false })}
          size="sm"
        >
          Complete by hand
        </Button>
        <Button
          disabled={busy || assets.length === 0}
          onClick={() => setRefunding(!refunding)}
          size="sm"
        >
          Report a refund
        </Button>
      </div>
      {refunding ? (
        <div className="flex flex-col gap-8">
          <label className="text-13 flex flex-col gap-4">
            Refund transaction
            <Input name="refund-tx" value={tx} onChange={(event) => setTx(event.target.value)} />
          </label>
          <label className="text-13 flex flex-col gap-4">
            Amount refunded
            <Input
              name="refund-amount"
              value={amount}
              inputMode="decimal"
              onChange={(event) => setAmount(event.target.value)}
            />
          </label>
          <label className="text-13 flex flex-col gap-4">
            Refunded in
            <select
              name="refund-asset"
              value={asset}
              onChange={(event) => setAsset(event.target.value)}
              className="rounded-10 border-line-2 text-14 border px-12 py-8"
            >
              {assets.map((choice) => (
                <option key={choice.caip19} value={choice.caip19}>
                  {choice.label}
                </option>
              ))}
            </select>
          </label>
          {problem === '' ? null : (
            <p role="alert" className="text-13 text-error">
              {problem}
            </p>
          )}
          <Button
            disabled={busy}
            onClick={askRefund}
            variant="primary"
            size="sm"
            className="self-start"
          >
            Review the refund report
          </Button>
        </div>
      ) : null}
    </li>
  );
}
