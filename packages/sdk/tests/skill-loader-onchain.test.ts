/**
 * `mode: onchain` at load time: the block and the mode move together, the
 * operator's display amounts become subunits, and the network is never taken
 * from the file.
 */

import { describe, expect, it } from 'vitest';
import { USDC_SOLANA_DEVNET, USDC_SOLANA_MAINNET } from '../src/payment/assets';
import { validateSkillFrontmatter } from '../src/skills/loader';

const KAMINO = 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

const base = {
  name: 'kamino-withdraw',
  description: 'builds the call that withdraws a USDC position',
  capabilities: ['onchain-call'],
  price: 0.05,
  token: 'usdc',
  mode: 'onchain',
  script: './build-call.ts',
};

const onchainBlock = {
  kind: 'withdraw',
  programs: [KAMINO, TOKEN_PROGRAM],
  token: 'usdc',
  max_per_call: '500',
};

const devnet = { network: 'devnet' } as const;

describe('validateSkillFrontmatter mode onchain', () => {
  it('resolves the asset and both ceilings into subunits', () => {
    const parsed = validateSkillFrontmatter({ ...base, onchain: onchainBlock }, '', devnet);
    expect(parsed.mode).toBe('onchain');
    expect(parsed.script).toBe('./build-call.ts');
    expect(parsed.onchain).toEqual({
      kind: 'withdraw',
      programs: [KAMINO, TOKEN_PROGRAM],
      requires: [],
      params: [],
      token: 'usdc',
      mint: USDC_SOLANA_DEVNET.mint,
      decimals: 6,
      symbol: 'USDC',
      max_per_call_subunits: '500000000',
      grants_authority: false,
      max_authority_subunits: '0',
    });
  });

  it('resolves the mint from the agent network, not from the file', () => {
    const parsed = validateSkillFrontmatter({ ...base, onchain: onchainBlock }, '', {
      network: 'mainnet',
    });
    expect(parsed.onchain?.mint).toBe(USDC_SOLANA_MAINNET.mint);
    // No `network` on the resolved descriptor - the host stamps it at buildCard.
    expect((parsed.onchain as Record<string, unknown> | undefined)?.network).toBeUndefined();
  });

  it('accepts a zero spend ceiling for a call that moves nothing', () => {
    const parsed = validateSkillFrontmatter(
      { ...base, onchain: { ...onchainBlock, max_per_call: '0' } },
      '',
      devnet,
    );
    expect(parsed.onchain?.max_per_call_subunits).toBe('0');
  });

  it('resolves a fractional ceiling exactly, without floating point', () => {
    const parsed = validateSkillFrontmatter(
      { ...base, onchain: { ...onchainBlock, max_per_call: '0.000001' } },
      '',
      devnet,
    );
    expect(parsed.onchain?.max_per_call_subunits).toBe('1');
  });

  it('carries an approve-shaped capability through with its authority ceiling', () => {
    const parsed = validateSkillFrontmatter(
      {
        ...base,
        onchain: {
          ...onchainBlock,
          kind: 'approve',
          max_per_call: '0',
          grants_authority: true,
          max_authority: '50',
        },
      },
      '',
      devnet,
    );
    expect(parsed.onchain?.grants_authority).toBe(true);
    expect(parsed.onchain?.max_authority_subunits).toBe('50000000');
  });

  it('keeps declared params and requires as published hints', () => {
    const parsed = validateSkillFrontmatter(
      {
        ...base,
        onchain: {
          ...onchainBlock,
          requires: ['approve'],
          params: [{ name: 'amount', type: 'amount', required: true }],
        },
      },
      '',
      devnet,
    );
    expect(parsed.onchain?.requires).toEqual(['approve']);
    expect(parsed.onchain?.params[0]?.name).toBe('amount');
  });

  it('requires a script - the operator builds the call', () => {
    const { script: _script, ...withoutScript } = base;
    expect(() =>
      validateSkillFrontmatter({ ...withoutScript, onchain: onchainBlock }, '', devnet),
    ).toThrow(/requires "script"/);
  });

  it('requires the block', () => {
    expect(() => validateSkillFrontmatter(base, '', devnet)).toThrow(/requires an "onchain" block/);
  });

  it('rejects the block on any other mode - a promise nothing fulfills', () => {
    expect(() =>
      validateSkillFrontmatter(
        { ...base, mode: 'dynamic-script', onchain: onchainBlock },
        '',
        devnet,
      ),
    ).toThrow(/requires mode 'onchain'/);
  });

  it('rejects an empty program allowlist', () => {
    expect(() =>
      validateSkillFrontmatter({ ...base, onchain: { ...onchainBlock, programs: [] } }, '', devnet),
    ).toThrow(/onchain/);
  });

  it('rejects an authority ceiling without the flag, and the flag without a ceiling', () => {
    expect(() =>
      validateSkillFrontmatter(
        { ...base, onchain: { ...onchainBlock, max_authority: '10' } },
        '',
        devnet,
      ),
    ).toThrow(/max_authority/);
    expect(() =>
      validateSkillFrontmatter(
        { ...base, onchain: { ...onchainBlock, grants_authority: true } },
        '',
        devnet,
      ),
    ).toThrow(/max_authority/);
  });

  it('rejects an unknown asset instead of guessing a mint', () => {
    expect(() =>
      validateSkillFrontmatter(
        { ...base, onchain: { ...onchainBlock, token: 'doge' } },
        '',
        devnet,
      ),
    ).toThrow(/unknown asset/);
  });

  it('rejects a wrong-network mint copied from the other cluster', () => {
    expect(
      () =>
        validateSkillFrontmatter(
          { ...base, onchain: { ...onchainBlock, mint: USDC_SOLANA_MAINNET.mint } },
          '',
          devnet,
        ),
      // The message is the whole point: it names the likely cause, so an
      // operator reads "copied from the other network" rather than hunting a
      // mint. A bare `.toThrow()` would pass on any throw from anywhere.
    ).toThrow(/other network/);
  });

  // The next three reject on the OTHER field, before `resolveSkillOnchain` runs
  // at all, so their `onchain:` block is along for the ride rather than under
  // test. That is fine for what they claim - these fields are refused in
  // onchain mode - but do not read them as covering the block itself.
  it('rejects conversation context - a call is not a chat', () => {
    expect(() =>
      validateSkillFrontmatter({ ...base, onchain: onchainBlock, context: true }, '', devnet),
    ).toThrow(/"context" is only valid/);
  });

  it('rejects max_tokens, like every other non-llm mode', () => {
    expect(() =>
      validateSkillFrontmatter({ ...base, onchain: onchainBlock, max_tokens: 100 }, '', devnet),
    ).toThrow(/max_tokens/);
  });

  it('rejects the file-exchange hints - a call is inline text', () => {
    expect(() =>
      validateSkillFrontmatter(
        { ...base, onchain: onchainBlock, output_mime: 'image/png' },
        '',
        devnet,
      ),
    ).toThrow(/output_mime/);
  });

  it('lets the builder declare an LLM dependency, like any script mode', () => {
    const parsed = validateSkillFrontmatter(
      { ...base, onchain: onchainBlock, provider: 'anthropic', model: 'claude-opus-5' },
      '',
      devnet,
    );
    expect(parsed.llmOverride).toEqual({ provider: 'anthropic', model: 'claude-opus-5' });
  });
});

describe('validateSkillFrontmatter mode onchain - ceiling integrity', () => {
  it('rejects an unknown parameter type in the operator file', () => {
    expect(() =>
      validateSkillFrontmatter(
        {
          ...base,
          onchain: { ...onchainBlock, params: [{ name: 'slot', type: 'sql', required: true }] },
        },
        '',
        devnet,
      ),
    ).toThrow(/unknown "onchain.params" type/);
  });

  it('refuses the devnet LSM fallback for a ceiling - a price may degrade, a bound may not', () => {
    // `token: lsm` falls back to SOL on devnet for PRICES. Applied to a
    // ceiling that would silently turn "1000 LSM" into a 1000 SOL bound.
    expect(() =>
      validateSkillFrontmatter(
        { ...base, onchain: { ...onchainBlock, token: 'lsm', max_per_call: '1000' } },
        '',
        devnet,
      ),
    ).toThrow(/does not exist on devnet/);
  });
});
