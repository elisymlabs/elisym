// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { History, OrderRow } from '../../src/admin/history';
import { renderHistory } from '../../src/admin/render';

function rendered(fee: string): string {
  const row: OrderRow = {
    key: 'k',
    buyerPubkey: 'b'.repeat(64),
    orderId: 'o',
    createdAt: 1_790_000_000,
    conflict: false,
    orderNotLoaded: true,
    state: 'delivered',
    credits: [{ tx: 'tx', amount: '1000000', fee, medium: 'solana-devnet' }],
    refunds: [],
    reported: [],
    unlistedMedium: false,
  };
  const history: History = { rows: [row], totals: { perAsset: [], unknownAsset: [] } };
  const body = document.createElement('tbody');
  renderHistory(document, history, {
    body,
    totals: document.createElement('ul'),
    empty: document.createElement('p'),
  });
  return body.textContent ?? '';
}

describe('the credited column', () => {
  it('shows the elisym fee under a credit that carried one, and nothing for a credit without', () => {
    expect(rendered('30000')).toContain('of which elisym fee 30000 subunits');
    expect(rendered('0')).not.toContain('elisym fee');
  });
});
