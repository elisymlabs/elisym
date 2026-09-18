import {
  NATIVE_ASSET_SENTINEL,
  deriveAssetStatsAddress,
  deriveEventAuthorityAddress,
  deriveNetworkStatsAddress,
} from '@elisym/config-client';
import { MEMO_PROGRAM_ADDRESS } from '@solana-program/memo';
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
} from '@solana-program/token';
import { type Address, address, getAddressDecoder } from '@solana/kit';
import { beforeEach, describe, expect, it } from 'vitest';
import { ELISYM_PROTOCOL_TAG, USDC_SOLANA_DEVNET, getProtocolProgramId } from '../src';
import { COMPUTE_BUDGET_PROGRAM_ADDRESS_STR } from '../src/onchain/checks';
import { SYSTEM_PROGRAM_ADDRESS_STR } from '../src/onchain/constants';
import { TOKEN_2022_PROGRAM_ADDRESS_STR } from '../src/payment/assets';
import {
  degenerateReference,
  degenerateReferenceSync,
  degenerateReferenceDerivations,
  resetDegenerateReferenceCache,
} from '../src/payment/degenerate-reference';
import type { PaymentRequestData } from '../src/types';

const ADDRESS_DECODER = getAddressDecoder();
function makeAddress(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return ADDRESS_DECODER.decode(bytes) as string;
}

const RECIPIENT = makeAddress();
const TREASURY = address(makeAddress());
const FEE_ADDRESS = makeAddress();

function makeRequest(overrides: Partial<PaymentRequestData> = {}): PaymentRequestData {
  return {
    recipient: RECIPIENT,
    amount: 1_000_000,
    reference: makeAddress(),
    fee_address: FEE_ADDRESS,
    fee_amount: 0,
    created_at: Math.floor(Date.now() / 1000),
    expiry_secs: 3600,
    network: 'devnet',
    ...overrides,
  } as PaymentRequestData;
}

const usdcAsset = {
  chain: 'solana',
  token: 'usdc',
  mint: USDC_SOLANA_DEVNET.mint,
  decimals: USDC_SOLANA_DEVNET.decimals,
};

beforeEach(() => {
  resetDegenerateReferenceCache();
});

describe('a reference the payment is computed from', () => {
  describe('the half that needs no await', () => {
    it.each([
      ['the recipient', () => RECIPIENT],
      ['the treasury from config', () => TREASURY as string],
      ['the fee address', () => FEE_ADDRESS],
      ['the protocol tag', () => ELISYM_PROTOCOL_TAG as string],
      ['the classic token program', () => TOKEN_PROGRAM_ADDRESS as string],
      ['the Token-2022 program', () => TOKEN_2022_PROGRAM_ADDRESS_STR],
      ['the ATA program', () => ASSOCIATED_TOKEN_PROGRAM_ADDRESS as string],
      ['the system program', () => SYSTEM_PROGRAM_ADDRESS_STR],
      ['the compute budget program', () => COMPUTE_BUDGET_PROGRAM_ADDRESS_STR],
      ['the memo program', () => MEMO_PROGRAM_ADDRESS as string],
      ['the protocol program', () => getProtocolProgramId('devnet') as string],
    ])('refuses a reference equal to %s', (_label, reference) => {
      const request = makeRequest({ reference: reference() });
      expect(degenerateReferenceSync(request, 'devnet', TREASURY)).toBe('degenerate_reference');
    });

    it('refuses a reference equal to the asset mint', () => {
      const request = makeRequest({
        reference: USDC_SOLANA_DEVNET.mint,
        asset: usdcAsset,
      } as never);
      expect(degenerateReferenceSync(request, 'devnet', TREASURY)).toBe('degenerate_reference');
    });

    it('passes a randomly generated reference - the only kind the SDK builds', () => {
      expect(degenerateReferenceSync(makeRequest(), 'devnet', TREASURY)).toBeUndefined();
    });

    it('does not treat an absent fee address as a match', () => {
      // `undefined` must not "equal" a missing field: a third-party provider
      // can leave `fee_address` out, and every reference would otherwise refuse.
      const request = makeRequest({ fee_address: undefined });
      expect(degenerateReferenceSync(request, 'devnet', TREASURY)).toBeUndefined();
    });
  });

  describe('the derived half', () => {
    it.each([
      [
        'the network stats PDA',
        async () => await deriveNetworkStatsAddress(getProtocolProgramId('devnet')),
      ],
      [
        'the event authority PDA',
        async () => await deriveEventAuthorityAddress(getProtocolProgramId('devnet')),
      ],
      [
        'the native asset stats PDA',
        async () =>
          await deriveAssetStatsAddress(getProtocolProgramId('devnet'), NATIVE_ASSET_SENTINEL),
      ],
    ])('refuses a reference equal to %s', async (_label, derive) => {
      const request = makeRequest({ reference: (await derive()) as string });
      expect(await degenerateReference(request, 'devnet', TREASURY)).toBe('degenerate_reference');
    });

    it.each([
      ['the recipient', () => RECIPIENT],
      ['the treasury', () => TREASURY as string],
      ['the fee address', () => FEE_ADDRESS],
    ])("refuses a reference equal to %s's associated token account", async (_label, owner) => {
      const [ata] = await findAssociatedTokenPda({
        owner: address(owner()),
        mint: address(USDC_SOLANA_DEVNET.mint as string),
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      const request = makeRequest({ reference: ata as string, asset: usdcAsset } as never);
      expect(await degenerateReference(request, 'devnet', TREASURY)).toBe('degenerate_reference');
    });

    it('does not throw on an owner that is not an address', async () => {
      // `findAssociatedTokenPda` encodes its owner and throws on a bad string.
      // A malformed owner contributes no ATA and is caught by the check that
      // owns it, not by this one.
      const request = makeRequest({ fee_address: 'not-an-address', asset: usdcAsset } as never);
      expect(await degenerateReference(request, 'devnet', TREASURY)).toBeUndefined();
    });
  });

  describe('deriving once per call', () => {
    it('reuses the derived set for a second call with the same key', async () => {
      const first = makeRequest({ asset: usdcAsset } as never);
      const second = makeRequest({ asset: usdcAsset } as never);
      await degenerateReference(first, 'devnet', TREASURY);
      const afterFirst = degenerateReferenceDerivations();
      await degenerateReference(second, 'devnet', TREASURY);

      expect(afterFirst).toBe(1);
      expect(degenerateReferenceDerivations()).toBe(1);
    });

    it('derives again when a key component changes', async () => {
      const request = makeRequest({ asset: usdcAsset } as never);
      await degenerateReference(request, 'devnet', TREASURY);
      await degenerateReference(
        makeRequest({ recipient: makeAddress(), asset: usdcAsset } as never),
        'devnet',
        TREASURY,
      );

      expect(degenerateReferenceDerivations()).toBe(2);
    });

    it('derives again after the treasury rotates', async () => {
      // The treasury is read from on-chain config and can be rotated there. A
      // set cached against the old one would survive the rotation and stop
      // catching a reference equal to the new treasury's ATA.
      const request = makeRequest({ asset: usdcAsset } as never);
      await degenerateReference(request, 'devnet', TREASURY);
      await degenerateReference(request, 'devnet', address(makeAddress()));

      expect(degenerateReferenceDerivations()).toBe(2);
    });
  });

  describe('a network string the type does not admit', () => {
    it('still refuses the entries that do not need a program id', async () => {
      // The CLI reaches this with a request parsed out of its own ledger by
      // `JSON.parse`, with no schema in between. Losing the whole check on an
      // unknown network would drop it exactly where it is fully computable.
      const request = makeRequest({ reference: RECIPIENT, network: 'mainnet-beta' } as never);
      expect(await degenerateReference(request, 'devnet', TREASURY)).toBe('degenerate_reference');
    });

    it('does not throw deriving what it cannot', async () => {
      const request = makeRequest({ network: 'mainnet-beta' } as never);
      expect(await degenerateReference(request, 'devnet', TREASURY)).toBeUndefined();
    });
  });

  it('throws on an asset it cannot resolve, both halves', async () => {
    const unknown = { chain: 'solana', token: 'nosuch', decimals: 6 };
    const request = makeRequest({ asset: unknown } as never);
    expect(() => degenerateReferenceSync(request, 'devnet', TREASURY)).toThrow(/Unknown asset/);
    await expect(degenerateReference(request, 'devnet', TREASURY)).rejects.toThrow(/Unknown asset/);
  });
});
