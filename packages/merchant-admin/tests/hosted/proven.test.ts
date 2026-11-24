import { describe, expect, it } from 'vitest';
import { ProvenPayouts } from '../../src/hosted/lib/proven';

const SOLANA =
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const OTHER_EVM = 'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const BASE = 'eip155:84532/erc20:0x036cbd53842c5426634e7929541ec2318f3dcf7e';

describe('the payouts proven in this browser session', () => {
  it('knows an EVM address in any case, a Solana address only exactly, and each per coin', () => {
    const proven = new ProvenPayouts();
    proven.add(BASE, '0xAbCd00000000000000000000000000000000Ef01');
    proven.add(SOLANA, 'FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM');
    expect(proven.has(BASE, '0xabcd00000000000000000000000000000000ef01')).toBe(true);
    expect(proven.has(BASE, '0xABCD00000000000000000000000000000000EF01')).toBe(true);
    expect(proven.has(SOLANA, 'FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM')).toBe(true);
    expect(proven.has(SOLANA, 'fhvo3mql8pw5ph5u2cn4xe33dokiyznuwugph2hmhlum')).toBe(false);
    expect(proven.has(BASE, 'FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM')).toBe(false);
    // The same address proven for one coin is not proven for another.
    expect(proven.has(OTHER_EVM, '0xabcd00000000000000000000000000000000ef01')).toBe(false);
    expect(new ProvenPayouts().has(BASE, '0xabcd00000000000000000000000000000000ef01')).toBe(false);
  });
});
