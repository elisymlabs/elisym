/**
 * `decodeMint` answers `null` for anything that is not PROVABLY a mint. The
 * verifier compares a mint's authorities across a call, so a body that merely
 * resembles a mint must never become one side of that comparison.
 */
import { describe, expect, it } from 'vitest';
import { decodeMint } from '../src/onchain/token-account';

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const MINT_LEN = 82;
const SLICE_LEN = 165;

function mintBytes(length: number): Uint8Array {
  const data = new Uint8Array(length);
  const view = new DataView(data.buffer);
  view.setUint32(0, 1, true);
  data.fill(7, 4, 36);
  data[45] = 1;
  view.setUint32(46, 1, true);
  data.fill(9, 50, 82);
  if (length > SLICE_LEN) {
    data[165] = 1;
  }
  return data;
}

describe('decodeMint', () => {
  it('reads both authorities of a classic mint', () => {
    const mint = decodeMint(mintBytes(MINT_LEN), { length: MINT_LEN, program: TOKEN_PROGRAM });
    expect(mint?.isInitialized).toBe(true);
    expect(mint?.mintAuthority).toBeDefined();
    expect(mint?.freezeAuthority).toBeDefined();
    expect(mint?.mintAuthority).not.toBe(mint?.freezeAuthority);
  });

  it('reads an absent authority as absent, not as the zero key', () => {
    const data = mintBytes(MINT_LEN);
    new DataView(data.buffer).setUint32(0, 0, true);
    const mint = decodeMint(data, { length: MINT_LEN, program: TOKEN_PROGRAM });
    expect(mint).not.toBeNull();
    expect(mint?.mintAuthority).toBeUndefined();
  });

  it('reads a Token-2022 mint with extensions from a SLICED read', () => {
    const whole = mintBytes(234);
    const sliced = whole.subarray(0, SLICE_LEN);
    expect(decodeMint(sliced, { length: 234, program: TOKEN_2022_PROGRAM })).not.toBeNull();
    expect(decodeMint(whole, { length: 234, program: TOKEN_2022_PROGRAM })).not.toBeNull();
  });

  it('refuses a buffer shorter than the layout, whatever length the node reports', () => {
    const short = mintBytes(MINT_LEN).subarray(0, 81);
    expect(decodeMint(short, { length: MINT_LEN, program: TOKEN_PROGRAM })).toBeNull();
  });

  it('refuses a classic-program account of any other length', () => {
    expect(decodeMint(mintBytes(234), { length: 234, program: TOKEN_PROGRAM })).toBeNull();
  });

  it('refuses a Token-2022 account no longer than the account layout that is not 82 bytes', () => {
    expect(decodeMint(mintBytes(165), { length: 165, program: TOKEN_2022_PROGRAM })).toBeNull();
  });

  it.each([
    ['the state byte of a token account', 108],
    ['the close-authority COption of a token account', 129],
    ['the close authority itself', 140],
  ])('refuses a long body whose padding is not zero at %s', (_label, offset) => {
    const data = mintBytes(234);
    data[offset] = 1;
    expect(decodeMint(data, { length: 234, program: TOKEN_2022_PROGRAM })).toBeNull();
    expect(
      decodeMint(data.subarray(0, SLICE_LEN), { length: 234, program: TOKEN_2022_PROGRAM }),
    ).toBeNull();
  });

  it('refuses a long body whose padding is not zero - a token account has its state byte there', () => {
    const data = mintBytes(234);
    data[108] = 1;
    expect(decodeMint(data, { length: 234, program: TOKEN_2022_PROGRAM })).toBeNull();
    expect(
      decodeMint(data.subarray(0, SLICE_LEN), { length: 234, program: TOKEN_2022_PROGRAM }),
    ).toBeNull();
  });

  it('refuses a long body tagged as anything but a mint', () => {
    const data = mintBytes(234);
    data[165] = 2;
    expect(decodeMint(data, { length: 234, program: TOKEN_2022_PROGRAM })).toBeNull();
  });

  it.each([
    ['the mint authority tag', 0],
    ['the freeze authority tag', 46],
  ])('refuses a COption tag that is neither None nor Some: %s', (_label, offset) => {
    const data = mintBytes(MINT_LEN);
    new DataView(data.buffer).setUint32(offset, 2, true);
    expect(decodeMint(data, { length: MINT_LEN, program: TOKEN_PROGRAM })).toBeNull();
  });

  it('refuses an is_initialized byte that is not a bool', () => {
    const data = mintBytes(MINT_LEN);
    data[45] = 2;
    expect(decodeMint(data, { length: MINT_LEN, program: TOKEN_PROGRAM })).toBeNull();
  });
});
