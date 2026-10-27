import { useState } from 'react';
import type { MockChain } from './ChainMark';
import { Icon } from './Icon';
import { PayWithSelect } from './PayWithSelect';

export interface MockPayout {
  id: string;
  chain: MockChain;
  chainLabel: string;
  coin: string;
}

/** The payouts the drawing offers, as a store paid on every network lists them. */
export const MOCK_PAYOUTS: readonly MockPayout[] = [
  { id: 'solana-usdc', chain: 'solana', chainLabel: 'Solana', coin: 'USDC' },
  { id: 'tempo-usdce', chain: 'tempo', chainLabel: 'Tempo', coin: 'USDC.e' },
  { id: 'tempo-pathusd', chain: 'tempo', chainLabel: 'Tempo', coin: 'pathUSD' },
  { id: 'ethereum-usdc', chain: 'ethereum', chainLabel: 'Ethereum', coin: 'USDC' },
  { id: 'arbitrum-usdc', chain: 'arbitrum', chainLabel: 'Arbitrum', coin: 'USDC' },
  { id: 'base-usdc', chain: 'base', chainLabel: 'Base', coin: 'USDC' },
];

/**
 * A drawing of the checkout modal: no wallet and no network behind it. Only its
 * "Pay with" picker works, as the real one does. The wallets a buyer sees are
 * the ones installed in their browser, so the drawing names none.
 */
export function CheckoutMock() {
  const [payoutId, setPayoutId] = useState(MOCK_PAYOUTS[0]?.id ?? '');
  const payout = MOCK_PAYOUTS.find((candidate) => candidate.id === payoutId) ?? MOCK_PAYOUTS[0];
  if (payout === undefined) {
    return null;
  }
  return (
    <div className="relative w-full max-w-360 lg:mx-auto">
      <div
        aria-hidden="true"
        className="bg-accent/15 absolute -inset-24 -z-10 rounded-full blur-3xl"
      />
      <figure
        aria-label="A drawing of the checkout"
        className="rounded-20 border-line-2 bg-surface relative border p-20 shadow-2xl shadow-black/30"
      >
        <span
          aria-hidden="true"
          className="text-text-3 text-18 absolute top-14 right-16 leading-none"
        >
          ×
        </span>
        <p className="text-17 pr-20 leading-snug font-semibold">Pro plan, 1 month</p>
        <p className="text-13 text-text-2 mt-2">Acme Studio</p>
        <p className="text-28 mt-14 font-bold tracking-tight">29.00 USD</p>

        <PayWithSelect payouts={MOCK_PAYOUTS} selected={payout} onSelect={setPayoutId} />

        <div aria-hidden="true" className="select-none">
          <p className="text-14 mt-16 font-semibold">Choose a wallet</p>
          <div className="rounded-12 border-line-2 mt-8 flex items-center gap-10 border px-12 py-10">
            <span className="rounded-8 bg-accent-soft text-accent-ink grid size-30 place-items-center">
              <Icon name="wallet" className="size-16" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="text-14 block font-medium">Your browser wallet</span>
              <span className="text-11 text-text-3 block">{`Any installed wallet for ${payout.chainLabel}`}</span>
            </span>
            <svg
              viewBox="0 0 24 24"
              className="text-text-3 size-16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m9 6 6 6-6 6" />
            </svg>
          </div>

          <div className="border-line mt-16 border-t pt-12 text-center">
            <p className="text-13 font-medium text-indigo-600 underline underline-offset-2 dark:text-indigo-400">
              Your purchases
            </p>
            <p className="text-11 text-text-3 mt-6">
              Checkout by Elisym · payments go straight to the store
            </p>
          </div>
        </div>
      </figure>
    </div>
  );
}
