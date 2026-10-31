import { describe, expect, it } from 'vitest';
import { railChange } from '../../src/cloud/components/RailFields';

const OWN = 'https://rpc.merchant.example';

describe('a network changed in Settings', () => {
  it('turned off or on runs on our endpoint: an own one it had is dropped', () => {
    expect(railChange({ on: true, rpcUrl: OWN }, { on: false, rpcUrl: OWN })).toEqual({
      on: false,
      rpcUrl: '',
    });
    expect(railChange({ on: false, rpcUrl: OWN }, { on: true, rpcUrl: OWN })).toEqual({
      on: true,
      rpcUrl: '',
    });
  });

  it('any other change is taken as it comes: a credit keeps the endpoint, Use ours drops it', () => {
    const was = { on: true, rpcUrl: OWN, credit: '' as const };
    expect(railChange(was, { ...was, credit: 'fast' })).toEqual({ ...was, credit: 'fast' });
    expect(railChange(was, { ...was, rpcUrl: '' })).toEqual({ ...was, rpcUrl: '' });
  });
});
