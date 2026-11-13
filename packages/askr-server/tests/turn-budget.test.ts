import { MAX_MODEL_CALLS_PER_TURN, MAX_TOOL_ROUNDS } from '@elisym/askr-agent';
import { describe, expect, it } from 'vitest';
import { checkTurnBudget, effortFrom, positiveInteger } from '../src/config';

describe('a turn reservation must pay for the most output a turn can make', () => {
  it('counts every model call of a turn', () => {
    expect(MAX_MODEL_CALLS_PER_TURN).toBe(MAX_TOOL_ROUNDS + 2);
  });

  it('passes at exactly the reservation and refuses one token more, naming the numbers', () => {
    // 8 calls x 3125 tokens at 10 USD per million = 0.25 USD.
    const budget = { calls: 8, outputPricePerMillion: '10', reserveUsd: '0.25' };
    expect(() => checkTurnBudget({ ...budget, maxTokens: 3_125 })).not.toThrow();
    expect(() => checkTurnBudget({ ...budget, maxTokens: 3_126 })).toThrow(
      'A turn can spend up to 0.25008 USD on output (8 calls x 3126 max tokens at 10 USD per million), more than ASKR_TURN_RESERVE_USD 0.25. Lower ASKR_MAX_TOKENS (with a lower ASKR_EFFORT so thinking fits) or raise ASKR_TURN_RESERVE_USD.',
    );
  });

  it('the default 2048 tokens fits the default reservation on a Sonnet-priced model, not an Opus-priced one', () => {
    const defaults = { maxTokens: 2_048, calls: MAX_MODEL_CALLS_PER_TURN, reserveUsd: '0.25' };
    expect(() => checkTurnBudget({ ...defaults, outputPricePerMillion: '10' })).not.toThrow();
    expect(() => checkTurnBudget({ ...defaults, outputPricePerMillion: '20' })).toThrow(
      /more than ASKR_TURN_RESERVE_USD 0.25/,
    );
  });

  it('reads ASKR_MAX_TOKENS as a whole number above zero', () => {
    expect(positiveInteger('ASKR_MAX_TOKENS', '2048')).toBe(2_048);
    for (const bad of ['0', '-1', '1.5', '2e3', '', 'abc', '01']) {
      expect(() => positiveInteger('ASKR_MAX_TOKENS', bad), bad).toThrow(
        'ASKR_MAX_TOKENS must be a whole number above zero',
      );
    }
  });

  it('ASKR_EFFORT is low by default and must be a known level', () => {
    expect(effortFrom(undefined)).toBe('low');
    expect(effortFrom('high')).toBe('high');
    expect(() => effortFrom('extreme')).toThrow(
      'ASKR_EFFORT must be one of low, medium, high, xhigh, max, got extreme',
    );
  });
});
