import { describe, expect, it } from 'vitest';
import {
  readAddressWord,
  readHexData,
  readQuantity,
  readUint256,
  readWords,
} from '@elisym/pay-core';

describe('rpc readers answer null, never a default', () => {
  it('reads hex data of whole bytes only', () => {
    expect(readHexData('0xABcd')).toBe('0xabcd');
    expect(readHexData('0x')).toBe('0x');
    expect(readHexData('0xabc')).toBeNull();
    expect(readHexData('abcd')).toBeNull();
    expect(readHexData('0xzz')).toBeNull();
    expect(readHexData(['0xab'])).toBeNull();
    expect(readHexData(undefined)).toBeNull();
  });

  it('reads a quantity', () => {
    expect(readQuantity('0xa5bf')).toBe(42431n);
    expect(readQuantity('0x0')).toBe(0n);
    expect(readQuantity('0x')).toBeNull();
    expect(readQuantity('a5bf')).toBeNull();
    expect(readQuantity(42431)).toBeNull();
    expect(readQuantity(`0x${'f'.repeat(65)}`)).toBeNull();
    expect(readQuantity(['0x1'])).toBeNull();
  });

  it('splits EXACTLY the words asked for', () => {
    const two = `0x${'00'.repeat(31)}01${'00'.repeat(31)}02`;
    expect(readWords(two, 2)).toEqual([`${'00'.repeat(31)}01`, `${'00'.repeat(31)}02`]);
    expect(readWords(two, 1)).toBeNull();
    expect(readWords(two, 3)).toBeNull();
    expect(readWords('0x', 0)).toEqual([]);
    expect(readWords('0x', 1)).toBeNull();
    expect(readWords(null, 1)).toBeNull();
  });

  it('reads a word as a number or as an address with clean padding', () => {
    expect(readUint256(`${'0'.repeat(62)}ff`)).toBe(255n);
    expect(readUint256('ff')).toBeNull();
    expect(readUint256(undefined)).toBeNull();
    const address = '716ebf6bef1c3f27ea5c315ecfc60527d97041a2';
    expect(readAddressWord(`${'0'.repeat(24)}${address}`)).toBe(`0x${address}`);
    expect(readAddressWord(`${'0'.repeat(23)}1${address}`)).toBeNull();
    expect(readAddressWord(address)).toBeNull();
    expect(readAddressWord(undefined)).toBeNull();
  });
});
