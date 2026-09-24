import { CHAINS } from '@elisym/pay-core';
import { describe, expect, it } from 'vitest';
import { paytoProofMessage, verifyPaytoProof } from '../src/wallet-proof';
import { EVM_VECTOR, USDCE_TEMPO_CAIP19, USDC_DEVNET_CAIP19, solanaWallet } from './fixtures';

describe('paytoProofMessage', () => {
  it('binds the owner and the asset', () => {
    expect(paytoProofMessage('ab', 'x:y/token:z')).toBe('elisym-payto:v1:ab:x:y/token:z');
  });
});

describe('verifyPaytoProof - EVM (EIP-191)', () => {
  const base = {
    chain: CHAINS.TEMPO_MAINNET,
    address: EVM_VECTOR.address,
    ownerPubkey: EVM_VECTOR.owner,
    caip19: USDCE_TEMPO_CAIP19,
    signature: EVM_VECTOR.signature,
  };

  it('accepts a signature an independent implementation (viem) produced', () => {
    expect(verifyPaytoProof(base)).toBe(true);
  });

  it('accepts the checksummed spelling of the same address', () => {
    expect(
      verifyPaytoProof({ ...base, address: base.address.toUpperCase().replace('0X', '0x') }),
    ).toBe(true);
  });

  it('refuses the proof for another owner', () => {
    expect(verifyPaytoProof({ ...base, ownerPubkey: 'b'.repeat(64) })).toBe(false);
  });

  it('refuses the proof for another asset', () => {
    expect(
      verifyPaytoProof({
        ...base,
        caip19: 'eip155:4217/erc20:0x20c0000000000000000000000000000000000000',
      }),
    ).toBe(false);
  });

  it('refuses the proof for another address', () => {
    expect(verifyPaytoProof({ ...base, address: `0x${'1'.repeat(40)}` })).toBe(false);
  });

  it('refuses a malformed signature without throwing', () => {
    expect(verifyPaytoProof({ ...base, signature: '0x1234' })).toBe(false);
    expect(verifyPaytoProof({ ...base, signature: `${EVM_VECTOR.signature.slice(0, -2)}05` })).toBe(
      false,
    );
    expect(verifyPaytoProof({ ...base, signature: 'not hex at all' })).toBe(false);
  });

  it('accepts the bare recovery id (0/1) some wallets write', () => {
    const v = Number.parseInt(EVM_VECTOR.signature.slice(-2), 16) - 27;
    const bare = `${EVM_VECTOR.signature.slice(0, -2)}0${v}`;
    expect(verifyPaytoProof({ ...base, signature: bare })).toBe(true);
  });
});

describe('verifyPaytoProof - Solana (ed25519)', () => {
  const owner = 'c'.repeat(64);

  it('accepts a wallet signature over the proof message', () => {
    const wallet = solanaWallet();
    expect(
      verifyPaytoProof({
        chain: CHAINS.SOLANA_DEVNET,
        address: wallet.address,
        ownerPubkey: owner,
        caip19: USDC_DEVNET_CAIP19,
        signature: wallet.proveFor(owner, USDC_DEVNET_CAIP19),
      }),
    ).toBe(true);
  });

  it("refuses another wallet's signature", () => {
    const wallet = solanaWallet();
    const other = solanaWallet();
    expect(
      verifyPaytoProof({
        chain: CHAINS.SOLANA_DEVNET,
        address: wallet.address,
        ownerPubkey: owner,
        caip19: USDC_DEVNET_CAIP19,
        signature: other.proveFor(owner, USDC_DEVNET_CAIP19),
      }),
    ).toBe(false);
  });

  it('refuses a proof made for another owner', () => {
    const wallet = solanaWallet();
    expect(
      verifyPaytoProof({
        chain: CHAINS.SOLANA_DEVNET,
        address: wallet.address,
        ownerPubkey: owner,
        caip19: USDC_DEVNET_CAIP19,
        signature: wallet.proveFor('d'.repeat(64), USDC_DEVNET_CAIP19),
      }),
    ).toBe(false);
  });

  it('refuses garbage without throwing', () => {
    const wallet = solanaWallet();
    for (const signature of ['', '0OIl', '1111']) {
      expect(
        verifyPaytoProof({
          chain: CHAINS.SOLANA_DEVNET,
          address: wallet.address,
          ownerPubkey: owner,
          caip19: USDC_DEVNET_CAIP19,
          signature,
        }),
      ).toBe(false);
    }
  });
});
