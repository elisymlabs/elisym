import { describe, expect, it } from 'vitest';
import { saveVerdict } from '../../src/cloud/lib/save-wait';
import { emptyForm, railsOf, withRailsOn } from '../../src/cloud/lib/settings';

describe('a save as the status judges it', () => {
  it('is judged only from a read asked for after it', () => {
    const base = { sentSeq: 3, kept: false, pending: false };
    expect(saveVerdict({ ...base, sentSeq: undefined, statusSeq: 9 })).toBe('none');
    // An older read, even one that shows nothing pending: still waiting.
    expect(saveVerdict({ ...base, statusSeq: 2 })).toBe('waiting');
    expect(saveVerdict({ ...base, statusSeq: 2, kept: true })).toBe('waiting');
    expect(saveVerdict({ ...base, statusSeq: 3 })).toBe('refused');
    expect(saveVerdict({ ...base, statusSeq: 3, pending: true })).toBe('waiting');
    expect(saveVerdict({ ...base, statusSeq: 4, kept: true, pending: true })).toBe('applied');
  });
});

describe('rails turned on for payouts', () => {
  it('keeps every rail on with its own RPC and credit mode, and turns none off', () => {
    const form = emptyForm();
    form.solana = { on: true, rpcUrl: 'https://own.example' };
    form.evm.base = { on: true, rpcUrl: 'https://base.example', credit: 'safe' };
    const next = withRailsOn(form, ['base', 'tempo', 'arbitrum', 'dogecoin']);
    expect(next.solana).toEqual({ on: true, rpcUrl: 'https://own.example' });
    expect(next.evm.base).toEqual({ on: true, rpcUrl: 'https://base.example', credit: 'safe' });
    expect(next.tempo).toEqual({ on: true, rpcUrl: '' });
    expect(next.evm.arbitrum).toEqual({ on: true, rpcUrl: '', credit: '' });
    expect([...railsOf(next)].sort()).toEqual(['arbitrum', 'base', 'solana', 'tempo']);
    // The form it started from is untouched.
    expect(form.tempo.on).toBe(false);
  });
});
