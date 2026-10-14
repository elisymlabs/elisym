/**
 * The public payment markers: the exact bytes of each, and that building one
 * into a Solana payment changes nothing a verifier reads.
 */
import { createHash } from 'node:crypto';
import { MEMO_PROGRAM_ADDRESS } from '@solana-program/memo';
import { address, createNoopSigner } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { getProtocolProgramId } from '../src/constants';
import { NATIVE_SOL, USDC_SOLANA_DEVNET } from '../src/payment/assets';
import type { DirectInstruction } from '../src/payment/direct';
import {
  boundTransferAmount,
  boundTreasuryLegs,
  composeSolanaPaymentRequest,
} from '../src/payment/direct';
import {
  classifyElisymMemo,
  ELISYM_COMMERCE_MEMO,
  ELISYM_JOB_MEMO_PREFIX,
  isTempoCommerceMemo,
  markTempoCommerceMemo,
  TEMPO_COMMERCE_MEMO_MAGIC,
} from '../src/payment/markers';
import { buildPaymentInstructions } from '../src/payment/solana';

const PAYER = address('9vSzVjVGUKqs6vEk1sKc3RPCRkAQfKHDzEkqM6ErqJkz');
const RECIPIENT = address('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU');
const TREASURY = address('GY7vnWMkKpftU4nQ16C2ATkj1JwrQpHhknkaBUn67VTy');
const REFERENCE = address('9X2A3QwTyptFanKJABbs62fSYnsBqUdXZrmeiJRHwGy2');
const LEGACY = '0x00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const MARKED = '0xfab22e7e00112233445566778899aabbccddeeff00112233445566778899aabb';

describe('Tempo commerce memo', () => {
  it('derives the magic from its documented preimage', () => {
    const digest = createHash('sha256').update('elisym-memo-marker:commerce:v1').digest('hex');
    expect(TEMPO_COMMERCE_MEMO_MAGIC).toBe(`0x${digest.slice(0, 8)}`);
  });

  it('keeps the first 28 bytes of the legacy memo after the magic', () => {
    expect(markTempoCommerceMemo(LEGACY)).toBe(MARKED);
    expect(markTempoCommerceMemo(LEGACY)).toHaveLength(66);
    expect(isTempoCommerceMemo(markTempoCommerceMemo(LEGACY))).toBe(true);
  });

  it.each([
    ['uppercase hex', LEGACY.toUpperCase().replace('0X', '0x')],
    ['no 0x', LEGACY.slice(2)],
    ['31 bytes', LEGACY.slice(0, -2)],
    ['33 bytes', `${LEGACY}00`],
    ['not hex', `0x${'zz'.repeat(32)}`],
    ['empty', ''],
  ])('refuses %s', (_label, input) => {
    expect(() => markTempoCommerceMemo(input)).toThrow(/64 lowercase hex/);
  });

  it.each([
    [MARKED, true],
    [LEGACY, false],
    [`0xfab22e7f${'00'.repeat(28)}`, false],
    [`0xfab22e7e${'00'.repeat(27)}`, false],
    [`0xfab22e7e${'00'.repeat(29)}`, false],
    [`0xFAB22E7E${'00'.repeat(28)}`, false],
    [`0xfab22e7e${'AB'.repeat(28)}`, false],
    [`fab22e7e${'00'.repeat(29)}`, false],
    [`xx0xfab22e7e${'00'.repeat(28)}`, false],
  ])('isTempoCommerceMemo(%s) is %s', (memo, expected) => {
    expect(isTempoCommerceMemo(memo)).toBe(expected);
  });
});

describe('classifyElisymMemo', () => {
  it.each([
    ['elisym:commerce', 'commerce'],
    [`${ELISYM_JOB_MEMO_PREFIX}abc123`, 'job'],
    ['elisym:v1:', 'job'],
    ['elisym:commerce ', 'other'],
    [' elisym:commerce', 'other'],
    ['elisym:commerce:v2', 'other'],
    ['Elisym:commerce', 'other'],
    ['elisym:v2:abc', 'other'],
    ['xelisym:v1:abc', 'other'],
    ['', 'other'],
  ])('%j is %s', (text, kind) => {
    expect(classifyElisymMemo(text)).toBe(kind);
  });
});

interface BuildOptions {
  commerceMemo?: boolean;
  jobEventId?: string;
}

function feeRequest(asset: typeof USDC_SOLANA_DEVNET) {
  return composeSolanaPaymentRequest({
    recipient: RECIPIENT,
    amount: 1_000_000n,
    asset,
    network: 'devnet',
    reference: REFERENCE,
    createdAt: 1_790_000_000,
    fee: { treasury: TREASURY, amount: 30_000n },
  });
}

/** The built instructions in the verifier's own reading shape. */
async function built(asset: typeof USDC_SOLANA_DEVNET, options: BuildOptions) {
  const instructions = (await buildPaymentInstructions(feeRequest(asset), createNoopSigner(PAYER), {
    programId: getProtocolProgramId('devnet'),
    bindFeeLeg: true,
    ...options,
  })) as {
    programAddress: string;
    accounts?: { address: string; role: number }[];
    data?: Uint8Array;
  }[];
  return instructions.map(
    (instruction): DirectInstruction => ({
      program: instruction.programAddress,
      accounts: (instruction.accounts ?? []).map((account) => ({
        address: account.address,
        // AccountRole: bit 0 is writable, bit 1 is signer.
        writable: (account.role & 1) === 1,
        signer: (account.role & 2) === 2,
      })),
      data: instruction.data ?? new Uint8Array(),
    }),
  );
}

function memosOf(instructions: readonly DirectInstruction[]): DirectInstruction[] {
  return instructions.filter((instruction) => instruction.program === MEMO_PROGRAM_ADDRESS);
}

describe('buildPaymentInstructions commerceMemo', () => {
  it.each([
    ['SOL', NATIVE_SOL],
    ['USDC', USDC_SOLANA_DEVNET],
  ])('prepends one account-less elisym:commerce memo on %s', async (_label, asset) => {
    const instructions = await built(asset, { commerceMemo: true });
    const memos = memosOf(instructions);
    expect(memos).toHaveLength(1);
    expect(instructions[0]).toBe(memos[0]);
    expect(memos[0]?.accounts).toEqual([]);
    expect(new TextDecoder().decode(memos[0]?.data)).toBe(ELISYM_COMMERCE_MEMO);
  });

  it.each([
    ['SOL', NATIVE_SOL],
    ['USDC', USDC_SOLANA_DEVNET],
  ])('adds no memo by default on %s', async (_label, asset) => {
    expect(memosOf(await built(asset, {}))).toEqual([]);
    expect(memosOf(await built(asset, { commerceMemo: false }))).toEqual([]);
  });

  it('refuses a commerce memo together with a job memo', async () => {
    await expect(
      built(USDC_SOLANA_DEVNET, { commerceMemo: true, jobEventId: 'ab' }),
    ).rejects.toThrow(/not both/);
  });

  it('still writes the job memo when only a job id is given', async () => {
    const memos = memosOf(await built(USDC_SOLANA_DEVNET, { jobEventId: 'ab' }));
    expect(memos).toHaveLength(1);
    expect(new TextDecoder().decode(memos[0]?.data)).toBe('elisym:v1:ab');
  });

  it.each([
    ['SOL', NATIVE_SOL],
    ['USDC', USDC_SOLANA_DEVNET],
  ])('leaves the bound totals on %s exactly as without it', async (_label, asset) => {
    const plain = await built(asset, {});
    const marked = await built(asset, { commerceMemo: true });
    expect(marked).toHaveLength(plain.length + 1);
    expect(marked.slice(1)).toEqual(plain);
    const payee = { reference: REFERENCE, recipient: RECIPIENT, asset };
    const treasury = { reference: REFERENCE, asset, treasuries: [TREASURY] };
    expect(await boundTransferAmount(marked, payee)).toBe(970_000n);
    expect((await boundTreasuryLegs(marked, treasury)).get(TREASURY)).toBe(30_000n);
  });
});
