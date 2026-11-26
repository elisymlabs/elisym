import { type ReactNode, useState } from 'react';
import { ApiError } from '../lib/api';
import { type ConfigEdit, fullConfig } from '../lib/config-input';
import { errorMessage } from '../lib/errors';
import { type PayoutRowValue, ROWS_PROBLEMS, payoutRows, payoutsOf } from '../lib/payout-rows';
import type { StoreSession } from '../lib/store-session';
import type { Payout, StoreConfig } from '../lib/types';
import { BUTTON_SECONDARY } from '../styles';
import { Notice } from './Notice';
import { PayoutRow } from './PayoutRow';

interface Props {
  session: StoreSession;
  config: StoreConfig;
  /** More of the config this form saves with the payouts (the first save names the inbox relays). */
  edit?: ConfigEdit;
  /** Fields shown above Save. */
  children?: ReactNode;
  onSaved: (config: StoreConfig, payouts: Payout[]) => void;
  /** The config changed elsewhere since it was read: the caller reads it again and says so. */
  onStale: () => void;
}

/** The payout rows of the store's network, each proven by its wallet, saved as the whole config. */
export function PayoutsForm({ session, config, edit = {}, children, onSaved, onStale }: Props) {
  const coins = session.meta.networks[config.network]?.coins ?? [];
  const [rows, setRows] = useState<PayoutRowValue[]>(() => payoutRows(config.draftPayouts, coins));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const change = (index: number, row: PayoutRowValue) => {
    setRows((current) => current.map((item, position) => (position === index ? row : item)));
  };

  const save = async () => {
    const built = payoutsOf(rows);
    if (!built.ok) {
      setProblem(ROWS_PROBLEMS[built.problem]);
      return;
    }
    setBusy(true);
    setProblem(undefined);
    try {
      const saved = await session.api.putConfig(
        fullConfig(config, { ...edit, payouts: built.payouts }),
      );
      onSaved(saved.config, built.payouts);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'stale_config') {
        onStale();
      } else {
        setProblem(errorMessage(error));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-16">
      <ul className="flex flex-col gap-16">
        {rows.map((row, index) => (
          <PayoutRow
            key={`${row.caip19}:${index}`}
            index={index}
            row={row}
            session={session}
            onChange={(next) => change(index, next)}
          />
        ))}
      </ul>
      {children}
      <div>
        <button
          type="button"
          className={BUTTON_SECONDARY}
          disabled={busy}
          onClick={() => void save()}
        >
          Save payouts
        </button>
      </div>
      {problem === undefined ? null : <Notice tone="error">{problem}</Notice>}
    </div>
  );
}
