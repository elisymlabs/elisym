/**
 * The TypeScript decoder reads a `Config` account the way the program writes
 * it. `pending_admin` is an `Option<Pubkey>` (1 or 33 bytes), so `evm_treasury`
 * sits at one of two offsets; and an account written before the field existed
 * (`_reserved: [u8; 128]`) must read as "no EVM treasury". The program-side
 * twins of these cases are the Mollusk tests in `programs/elisym-config`.
 */
import { CONFIG_DISCRIMINATOR, getConfigDecoder } from '@elisym/config-client';
import { address, getAddressEncoder } from '@solana/kit';
import { describe, expect, it } from 'vitest';

const ADMIN = address('9vSzVjVGUKqs6vEk1sKc3RPCRkAQfKHDzEkqM6ErqJkz');
const PENDING = address('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU');
const TREASURY = address('GY7vnWMkKpftU4nQ16C2ATkj1JwrQpHhknkaBUn67VTy');
const EVM_TREASURY = Uint8Array.from({ length: 20 }, (_value, index) => index + 1);
/** 8 + `Config::INIT_SPACE`: what every live config account was allocated with. */
const ACCOUNT_SIZE = 246;

function configImage(options: {
  pendingAdmin?: string;
  /** The 128 bytes after `last_updated`: the old `_reserved`, or `evm_treasury` + the new one. */
  tail: Uint8Array;
}): Uint8Array {
  const addressBytes = getAddressEncoder();
  const parts: number[] = [...CONFIG_DISCRIMINATOR, 1, 254, ...addressBytes.encode(ADMIN)];
  if (options.pendingAdmin === undefined) {
    parts.push(0);
  } else {
    parts.push(1, ...addressBytes.encode(address(options.pendingAdmin)));
  }
  parts.push(...addressBytes.encode(TREASURY));
  parts.push(250 & 0xff, 250 >> 8); // fee_bps
  parts.push(0); // paused
  const lastUpdated = new Uint8Array(8);
  new DataView(lastUpdated.buffer).setBigInt64(0, 1_700_000_000n, true);
  parts.push(...lastUpdated, ...options.tail);
  const image = new Uint8Array(ACCOUNT_SIZE);
  image.set(parts);
  return image;
}

function newTail(evmTreasury: Uint8Array): Uint8Array {
  const tail = new Uint8Array(128);
  tail.set(evmTreasury);
  return tail;
}

describe('the Config account layout', () => {
  it.each([
    ['no pending admin', undefined],
    ['a pending admin', PENDING],
  ])('decodes evm_treasury with %s', (_label, pendingAdmin) => {
    const decoded = getConfigDecoder().decode(
      configImage({ pendingAdmin, tail: newTail(EVM_TREASURY) }),
    );
    expect(Array.from(decoded.evmTreasury)).toEqual(Array.from(EVM_TREASURY));
    expect(Array.from(decoded.reserved)).toEqual(new Array(108).fill(0));
    expect(decoded.admin).toBe(ADMIN);
    expect(decoded.treasury).toBe(TREASURY);
    expect(decoded.feeBps).toBe(250);
    expect(decoded.lastUpdated).toBe(1_700_000_000n);
    expect(decoded.pendingAdmin).toEqual(
      pendingAdmin === undefined ? { __option: 'None' } : { __option: 'Some', value: pendingAdmin },
    );
  });

  it.each([
    ['no pending admin', undefined],
    ['a pending admin', PENDING],
  ])(
    'reads an account written before the field existed as unset, with %s',
    (_label, pendingAdmin) => {
      const decoded = getConfigDecoder().decode(
        configImage({ pendingAdmin, tail: new Uint8Array(128) }),
      );
      expect(Array.from(decoded.evmTreasury)).toEqual(new Array(20).fill(0));
      expect(decoded.treasury).toBe(TREASURY);
      expect(decoded.feeBps).toBe(250);
    },
  );

  it('fills the account exactly with a pending admin: the size did not change', () => {
    // The widest image (Some) is the allocation; one byte more would not fit.
    const image = configImage({ pendingAdmin: PENDING, tail: newTail(EVM_TREASURY) });
    expect(getConfigDecoder().read(image, 0)[1]).toBe(ACCOUNT_SIZE);
  });
});
