import {
  USDC_SOLANA_DEVNET,
  USDC_SOLANA_MAINNET,
  type CapabilityCard,
  type DelegationStatus,
} from '@elisym/sdk';
import { describe, expect, it } from 'vitest';
import {
  delegatedBuyHoldReason,
  resolveDelegatedBuyMode,
  usesDelegatedRail,
  type DelegatedBuyMode,
} from '../app/lib/delegatedBuyMode';

type DelegationCard = Pick<CapabilityCard, 'payment' | 'delegation'>;

const PROVIDER_WALLET = 'GY7vnWMkKpftU4nQ16C2ATkj1JwrQpHhknkaBUn67VTy';
const CUSTOMER_WALLET = '9vSzQ7m1RkUcP4eWbN2hTgY6aJ3xLdF8sK5vCq1ZrHnE';
const DELEGATE = 'Dg8Kz1bG4Tq9Yf3wXv2nPmL7sHc5aRuJ6eWkQ4tNyZ1B';
const OTHER_DELEGATE = 'Hx3Mq8vT2cN6pRk9WbJ4yZs7LfGd5aUe1KtQwP2nVmCx';
const PRICE = 410_000;

const USDC_PAYMENT: NonNullable<CapabilityCard['payment']> = {
  chain: 'solana',
  network: 'devnet',
  address: PROVIDER_WALLET,
  job_price: PRICE,
  token: 'usdc',
  mint: USDC_SOLANA_DEVNET.mint,
  decimals: 6,
  symbol: 'USDC',
};

const DELEGATION: NonNullable<CapabilityCard['delegation']> = {
  mechanism: 'spl-approve',
  suggested_cap_subunits: '50000000',
  delegate_pubkey: DELEGATE,
};

const DELEGATED_CARD: DelegationCard = { payment: USDC_PAYMENT, delegation: DELEGATION };

function statusOf(overrides: Partial<DelegationStatus> = {}): DelegationStatus {
  return {
    delegate: DELEGATE,
    remainingCap: BigInt(PRICE),
    mint: USDC_SOLANA_DEVNET.mint ?? '',
    owner: CUSTOMER_WALLET,
    balance: BigInt(PRICE),
    ...overrides,
  };
}

function modeOf(overrides: Partial<Parameters<typeof resolveDelegatedBuyMode>[0]> = {}) {
  return resolveDelegatedBuyMode({
    card: DELEGATED_CARD,
    walletAddress: CUSTOMER_WALLET,
    canSignMessage: true,
    isFetched: true,
    isError: false,
    status: statusOf(),
    ...overrides,
  });
}

describe('usesDelegatedRail', () => {
  it('holds for a paid canonical-USDC card that advertises a delegation', () => {
    expect(usesDelegatedRail(DELEGATED_CARD)).toBe(true);
  });

  it('does not hold without a delegation', () => {
    expect(usesDelegatedRail({ payment: USDC_PAYMENT })).toBe(false);
  });

  it('does not hold for a free card', () => {
    expect(
      usesDelegatedRail({ payment: { ...USDC_PAYMENT, job_price: 0 }, delegation: DELEGATION }),
    ).toBe(false);
  });

  it('does not hold for a SOL-priced card', () => {
    const solPayment = {
      chain: 'solana',
      network: 'devnet',
      address: PROVIDER_WALLET,
      job_price: 1_000_000,
    };
    expect(usesDelegatedRail({ payment: solPayment, delegation: DELEGATION })).toBe(false);
  });

  it("does not hold for a card that calls itself usdc but names another cluster's mint", () => {
    const foreignMint = { ...USDC_PAYMENT, mint: USDC_SOLANA_MAINNET.mint };
    expect(usesDelegatedRail({ payment: foreignMint, delegation: DELEGATION })).toBe(false);
  });
});

describe('resolveDelegatedBuyMode', () => {
  it('pays per job when the card is not on the delegated rail', () => {
    expect(modeOf({ card: { payment: USDC_PAYMENT } })).toBe('per-job');
  });

  it('stays per-job with no wallet, so the surface can offer Connect', () => {
    expect(modeOf({ walletAddress: undefined })).toBe('per-job');
  });

  it('holds a wallet that cannot sign messages, whatever the read says', () => {
    expect(modeOf({ canSignMessage: false })).toBe('wallet-unsupported');
    expect(modeOf({ canSignMessage: false, isFetched: false, status: undefined })).toBe(
      'wallet-unsupported',
    );
  });

  it('is loading until the allowance read settles', () => {
    expect(modeOf({ isFetched: false, status: undefined })).toBe('loading');
  });

  it('holds a failed read instead of falling back to a per-job payment', () => {
    expect(modeOf({ isError: true, status: undefined })).toBe('check-failed');
  });

  it('holds a failed refetch even when an earlier read left a covering result', () => {
    expect(modeOf({ isError: true, status: statusOf() })).toBe('check-failed');
  });

  it('holds a settled read that carries no data', () => {
    expect(modeOf({ status: undefined })).toBe('check-failed');
  });

  it('offers Delegate when the account has no delegation', () => {
    expect(modeOf({ status: null })).toBe('delegate');
  });

  it('offers Delegate when the allowance names another delegate', () => {
    expect(modeOf({ status: statusOf({ delegate: OTHER_DELEGATE }) })).toBe('delegate');
  });

  it('offers Delegate when a revoke cleared the delegate', () => {
    expect(modeOf({ status: statusOf({ delegate: null, remainingCap: 0n }) })).toBe('delegate');
  });

  it('offers Delegate when the cap or the balance is below the price', () => {
    expect(modeOf({ status: statusOf({ remainingCap: BigInt(PRICE - 1) }) })).toBe('delegate');
    expect(modeOf({ status: statusOf({ balance: BigInt(PRICE - 1) }) })).toBe('delegate');
  });

  it('offers Use when the allowance covers the price', () => {
    expect(modeOf()).toBe('use');
  });

  it('never resolves a delegated-rail card to per-job once a wallet is connected', () => {
    const statuses = [undefined, null, statusOf(), statusOf({ remainingCap: 0n })];
    for (const canSignMessage of [true, false]) {
      for (const isFetched of [true, false]) {
        for (const isError of [true, false]) {
          for (const status of statuses) {
            expect(modeOf({ canSignMessage, isFetched, isError, status })).not.toBe('per-job');
          }
        }
      }
    }
  });
});

describe('delegatedBuyHoldReason', () => {
  it('explains every mode that holds the send', () => {
    const held: DelegatedBuyMode[] = ['loading', 'wallet-unsupported', 'check-failed'];
    for (const mode of held) {
      expect(delegatedBuyHoldReason(mode)).toEqual(expect.any(String));
    }
  });

  it('lets the surface act on the other modes', () => {
    const actionable: DelegatedBuyMode[] = ['use', 'delegate', 'per-job'];
    for (const mode of actionable) {
      expect(delegatedBuyHoldReason(mode)).toBeNull();
    }
  });
});
