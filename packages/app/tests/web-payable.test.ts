/**
 * The rule that decides whether the Buy button is live, and what it says when
 * it is not. Every send surface in the app reads this one answer.
 */
import type { CapabilityCard } from '@elisym/sdk';
import { describe, expect, it } from 'vitest';
import { offSolanaTip, paysOffSolana } from '../app/lib/webPayable';

const SOLANA_WALLET = 'GY7vnWMkKpftU4nQ16C2ATkj1JwrQpHhknkaBUn67VTy';
const EVM_WALLET = '0x0ed8e782415d51eb7192cf0fce9914a5ed23bce1';

function paidOn(chain: string, address: string): Pick<CapabilityCard, 'payment'> {
  return {
    payment: {
      chain,
      network: 'mainnet',
      address,
      job_price: 100_000,
    } as NonNullable<CapabilityCard['payment']>,
  };
}

describe('paysOffSolana', () => {
  it('lets a Solana card through', () => {
    expect(paysOffSolana(paidOn('solana', SOLANA_WALLET))).toBe(false);
  });

  it('holds a Tempo card', () => {
    expect(paysOffSolana(paidOn('tempo', EVM_WALLET))).toBe(true);
  });

  it('holds a chain nobody here has heard of', () => {
    // The gate is an allow-list, not a list of chains to refuse: a rail added
    // to the SDK tomorrow is held until this app can pay it.
    expect(paysOffSolana(paidOn('bitcoin', 'bc1qxq66e0t8d7ugdecwnmv58e90tpry23nc84pg9k'))).toBe(
      true,
    );
  });

  it('holds a zero-priced card that names another chain', () => {
    // Free is not a chain. A price of zero on a rail this app cannot pay is
    // still a buy path that has never run here, and the docstring says so.
    const free = {
      ...(paidOn('tempo', EVM_WALLET).payment as NonNullable<CapabilityCard['payment']>),
      job_price: 0,
    };
    expect(paysOffSolana({ payment: free })).toBe(true);
  });

  it('lets a free card through, payment block and all', () => {
    // Free is payable anywhere, and an absent block names no chain.
    expect(paysOffSolana({})).toBe(false);
  });
});

describe('offSolanaTip', () => {
  it('names Tempo, which it knows', () => {
    expect(offSolanaTip(paidOn('tempo', EVM_WALLET))).toContain('priced on Tempo');
  });

  it('says why the button is dead and where the buyer can go instead', () => {
    const tip = offSolanaTip(paidOn('tempo', EVM_WALLET));
    expect(tip).toContain('can only pay on Solana');
    expect(tip).toContain('CLI');
  });

  it('never spells back a chain it does not know', () => {
    // `chain` comes off an untrusted card. Anything unknown is described, not
    // echoed, so no card can choose the words in this app's own UI.
    const tip = offSolanaTip(paidOn('<script>alert(1)</script>', EVM_WALLET));
    expect(tip).toContain('another chain');
    expect(tip).not.toContain('script');
  });
});
