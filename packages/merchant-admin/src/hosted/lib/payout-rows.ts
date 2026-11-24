import type { Payout } from './types';
import { familyOf } from './wallets';

/** One payout row of the editor: a coin, the address (empty: not used), its wallet signature. */
export interface PayoutRowValue {
  caip19: string;
  address: string;
  signature?: string;
}

/** The saved payouts first, in their order, then each other coin the server takes on the store's network. */
export function payoutRows(saved: readonly Payout[], coins: readonly string[]): PayoutRowValue[] {
  const rows: PayoutRowValue[] = saved.map((payout) => ({ ...payout }));
  for (const coin of coins) {
    if (!saved.some((payout) => payout.caip19 === coin)) {
      rows.push({ caip19: coin, address: '' });
    }
  }
  return rows;
}

export type RowsProblem = 'none' | 'unsigned';

export const ROWS_PROBLEMS: Readonly<Record<RowsProblem, string>> = {
  none: 'Add at least one payout address, signed by its wallet. Your settings cannot be saved without one.',
  unsigned: 'Sign each payout address with its wallet before saving.',
};

/** The payouts to save (EVM addresses lowercase), or why there are none. */
export function payoutsOf(
  rows: readonly PayoutRowValue[],
): { ok: true; payouts: Payout[] } | { ok: false; problem: RowsProblem } {
  const used = rows.filter((row) => row.address.trim() !== '');
  if (used.length === 0) {
    return { ok: false, problem: 'none' };
  }
  const payouts: Payout[] = [];
  for (const row of used) {
    if (row.signature === undefined) {
      return { ok: false, problem: 'unsigned' };
    }
    const address = row.address.trim();
    payouts.push({
      caip19: row.caip19,
      address: familyOf(row.caip19) === 'evm' ? address.toLowerCase() : address,
      signature: row.signature,
    });
  }
  return { ok: true, payouts };
}
