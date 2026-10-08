import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
/**
 * Direct-mode payments with a protocol fee leg: composing the request, binding
 * the fee transfer to the order, and the judge's verdicts - which mirror the
 * merchant node's paid rule, so "the buyer says not paid" never meets "the
 * node credits it".
 */
import {
  type CompiledTransactionMessage,
  address,
  appendTransactionMessageInstructions,
  compileTransactionMessage,
  createNoopSigner,
  createTransactionMessage,
  getBase58Decoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Blockhash,
  type Rpc,
  type SolanaRpcApi,
} from '@solana/kit';
import { describe, expect, it } from 'vitest';
import {
  ELISYM_PROTOCOL_TAG,
  SYSTEM_PROGRAM_ADDRESS_STR,
  getProtocolProgramId,
} from '../src/constants';
import { NATIVE_SOL, USDC_SOLANA_DEVNET } from '../src/payment/assets';
import {
  type DirectInstruction,
  boundTreasuryLegs,
  composeSolanaPaymentRequest,
  directInstructionsFromCompiledMessage,
  judgeDirectSolanaPayment,
  readDirectSolanaTransaction,
  verifyDirectSolanaPayment,
} from '../src/payment/direct';
import { buildPaymentInstructions } from '../src/payment/solana';
import type { PaymentRequestData } from '../src/types';

const PAYER = address('9vSzVjVGUKqs6vEk1sKc3RPCRkAQfKHDzEkqM6ErqJkz');
const RECIPIENT = address('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU');
const TREASURY = address('GY7vnWMkKpftU4nQ16C2ATkj1JwrQpHhknkaBUn67VTy');
const OTHER_TREASURY = address('HXtBm8XZbxaTt41uqaKhwUAa6Z1aPyvJdsZVENiWsetg');
const REFERENCE = address('9X2A3QwTyptFanKJABbs62fSYnsBqUdXZrmeiJRHwGy2');
const OTHER_REFERENCE = address('4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T');
const BLOCKHASH = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi' as Blockhash;
const NOW = 1_790_000_000;
const BLOCK_TIME = NOW + 10;
const PRICE = 1_000_000n;
const FEE = 30_000n;
const SIGNATURE = getBase58Decoder().decode(new Uint8Array(64).fill(7));
const USDC_MINT = USDC_SOLANA_DEVNET.mint ?? '';

interface RequestShape {
  asset?: typeof USDC_SOLANA_DEVNET;
  amount?: bigint;
  fee?: { treasury: string; amount: bigint };
  reference?: string;
}

function requestFor(shape: RequestShape = {}): PaymentRequestData {
  return composeSolanaPaymentRequest({
    recipient: RECIPIENT,
    amount: shape.amount ?? PRICE,
    asset: shape.asset ?? USDC_SOLANA_DEVNET,
    network: 'devnet',
    reference: shape.reference ?? REFERENCE,
    createdAt: NOW,
    ...(shape.fee === undefined ? {} : { fee: shape.fee }),
  });
}

const FEE_REQUEST = requestFor({ fee: { treasury: TREASURY, amount: FEE } });

async function compiledFor(
  request: PaymentRequestData,
  bindFeeLeg = true,
): Promise<CompiledTransactionMessage> {
  const instructions = await buildPaymentInstructions(request, createNoopSigner(PAYER), {
    programId: getProtocolProgramId('devnet'),
    bindFeeLeg,
  });
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (draft) => setTransactionMessageFeePayer(PAYER, draft),
    (draft) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: BLOCKHASH, lastValidBlockHeight: 1000n },
        draft,
      ),
    (draft) =>
      appendTransactionMessageInstructions(
        instructions as Parameters<typeof appendTransactionMessageInstructions>[0],
        draft,
      ),
  );
  return compileTransactionMessage(message);
}

/** A token-balance row; `amount` is written verbatim so a test can make it unreadable. */
interface Row {
  owner: string;
  pre?: string;
  post?: string;
}

/**
 * The `getTransaction` (`encoding: 'json'`) view of a compiled message. Token
 * rows per owner (USDC); a row with no `post` is left off the post list.
 * `lamports` gives native SOL balances per account.
 */
function landed(
  compiled: CompiledTransactionMessage,
  options: {
    rows?: Row[];
    lamports?: Record<string, [bigint, bigint]>;
    meta?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  const base58 = getBase58Decoder();
  const keys = compiled.staticAccounts.map(String);
  const rows = options.rows ?? [];
  const tokenRow = (row: Row, amount: string) => ({
    accountIndex: 1,
    mint: USDC_MINT,
    owner: row.owner,
    uiTokenAmount: { amount },
  });
  return {
    slot: 42n,
    blockTime: BLOCK_TIME,
    transaction: {
      message: {
        accountKeys: keys,
        header: {
          numRequiredSignatures: compiled.header.numSignerAccounts,
          numReadonlySignedAccounts: compiled.header.numReadonlySignerAccounts,
          numReadonlyUnsignedAccounts: compiled.header.numReadonlyNonSignerAccounts,
        },
        instructions: compiled.instructions.map((instruction) => ({
          programIdIndex: instruction.programAddressIndex,
          accounts: instruction.accountIndices ?? [],
          data: base58.decode(instruction.data ?? new Uint8Array()),
        })),
      },
    },
    meta: {
      err: null,
      loadedAddresses: { writable: [], readonly: [] },
      preTokenBalances: rows
        .filter((row) => row.pre !== undefined)
        .map((row) => tokenRow(row, row.pre ?? '')),
      postTokenBalances: rows
        .filter((row) => row.post !== undefined)
        .map((row) => tokenRow(row, row.post ?? '')),
      preBalances: keys.map((key) => (options.lamports?.[key] ?? [10n, 10n])[0]),
      postBalances: keys.map((key) => (options.lamports?.[key] ?? [10n, 10n])[1]),
      ...options.meta,
    },
  };
}

/** Honest USDC balance rows: the payee got `payee`, the treasury `treasury`. */
function rowsFor(payee: bigint, treasury: bigint): Row[] {
  return [
    { owner: PAYER, pre: (PRICE * 10n).toString(), post: (PRICE * 9n).toString() },
    { owner: RECIPIENT, pre: '0', post: payee.toString() },
    { owner: TREASURY, pre: '0', post: treasury.toString() },
  ];
}

async function judge(
  request: PaymentRequestData,
  transaction: unknown,
): ReturnType<typeof judgeDirectSolanaPayment> {
  return judgeDirectSolanaPayment({ signature: SIGNATURE, transaction }, request);
}

/** A fee-bearing transaction as the payer builds it, for `paid` (total, fee to `treasury`). */
async function paidWith(fee: bigint, treasury: string = TREASURY, amount = PRICE) {
  return compiledFor(requestFor({ amount, fee: { treasury, amount: fee } }));
}

function rpcReturning(transaction: unknown): Rpc<SolanaRpcApi> & { calls: number } {
  const rpc = {
    calls: 0,
    getTransaction: () => ({
      send: async () => {
        rpc.calls += 1;
        return transaction;
      },
    }),
  };
  return rpc as unknown as Rpc<SolanaRpcApi> & { calls: number };
}

describe('composeSolanaPaymentRequest with a fee leg', () => {
  it('writes the fee fields with the amount staying the total', () => {
    expect(FEE_REQUEST).toMatchObject({
      recipient: RECIPIENT,
      amount: Number(PRICE),
      fee_address: TREASURY,
      fee_amount: Number(FEE),
      reference: REFERENCE,
    });
  });

  it('is byte-identical to a fee-less request with no fee or a fee of 0', () => {
    const plain = JSON.stringify(requestFor());
    expect(JSON.stringify(requestFor({ fee: { treasury: TREASURY, amount: 0n } }))).toBe(plain);
    // At 0 the treasury is not even read: a payout that IS the treasury composes.
    expect(JSON.stringify(requestFor({ fee: { treasury: RECIPIENT, amount: 0n } }))).toBe(plain);
    expect(plain).not.toContain('fee_');
  });

  it('takes a fee one subunit below the total and refuses the total or more', () => {
    expect(requestFor({ fee: { treasury: TREASURY, amount: PRICE - 1n } }).fee_amount).toBe(
      Number(PRICE - 1n),
    );
    for (const amount of [PRICE, PRICE + 1n]) {
      expect(() => requestFor({ fee: { treasury: TREASURY, amount } })).toThrow(/too small/);
    }
  });

  it.each([
    ['the payee', RECIPIENT, /payee itself/],
    ['the reference', REFERENCE, /cannot be the reference/],
    ['the protocol tag', ELISYM_PROTOCOL_TAG, /cannot be the reference/],
    ['the mint', USDC_MINT, /cannot be the reference/],
    ['the token program', TOKEN_PROGRAM_ADDRESS, /cannot be the reference/],
    ['the system program', SYSTEM_PROGRAM_ADDRESS_STR, /cannot be the reference/],
    ['not an address', '1'.repeat(40), /not a Solana address/],
  ])('refuses a treasury that is %s', (_label, treasury, message) => {
    expect(() => requestFor({ fee: { treasury, amount: FEE } })).toThrow(message);
  });

  it('refuses a negative or non-bigint fee', () => {
    expect(() => requestFor({ fee: { treasury: TREASURY, amount: -1n } })).toThrow(/non-negative/);
    expect(() =>
      requestFor({ fee: { treasury: TREASURY, amount: 5 as unknown as bigint } }),
    ).toThrow(/non-negative/);
  });
});

describe('buildPaymentInstructions bindFeeLeg', () => {
  function feeTransferOf(instructions: DirectInstruction[], program: string): DirectInstruction {
    const transfers = instructions.filter(
      (instruction) => instruction.program === program && instruction.data[0] !== 1,
    );
    const fee = transfers[transfers.length - 1];
    if (fee === undefined) {
      throw new Error('no fee transfer');
    }
    return fee;
  }

  it.each([
    ['USDC', USDC_SOLANA_DEVNET, TOKEN_PROGRAM_ADDRESS, 4],
    ['SOL', NATIVE_SOL, SYSTEM_PROGRAM_ADDRESS_STR, 2],
  ])(
    'leaves the %s fee transfer unmarked by default (agent jobs)',
    async (_l, asset, program, own) => {
      const request = requestFor({ asset, fee: { treasury: TREASURY, amount: FEE } });
      const instructions = directInstructionsFromCompiledMessage(await compiledFor(request, false));
      expect(feeTransferOf(instructions, program).accounts).toHaveLength(own);
      const legs = await boundTreasuryLegs(instructions, {
        reference: REFERENCE,
        asset,
        treasuries: [TREASURY],
      });
      expect(legs.get(TREASURY)).toBe(0n);
    },
  );

  it.each([
    ['USDC', USDC_SOLANA_DEVNET, TOKEN_PROGRAM_ADDRESS, 4],
    ['SOL', NATIVE_SOL, SYSTEM_PROGRAM_ADDRESS_STR, 2],
  ])(
    'marks the %s fee transfer like the payee transfer when asked',
    async (_l, asset, program, own) => {
      const request = requestFor({ asset, fee: { treasury: TREASURY, amount: FEE } });
      const instructions = directInstructionsFromCompiledMessage(await compiledFor(request, true));
      const markers = feeTransferOf(instructions, program).accounts.slice(own);
      expect(markers).toEqual([
        { address: REFERENCE, writable: false, signer: false },
        { address: ELISYM_PROTOCOL_TAG, writable: false, signer: false },
      ]);
      const legs = await boundTreasuryLegs(instructions, {
        reference: REFERENCE,
        asset,
        treasuries: [TREASURY],
      });
      expect(legs.get(TREASURY)).toBe(FEE);
    },
  );
});

describe('boundTreasuryLegs', () => {
  it('maps each candidate to what it received bound, and 0 to the others', async () => {
    const instructions = directInstructionsFromCompiledMessage(await paidWith(FEE));
    const legs = await boundTreasuryLegs(instructions, {
      reference: REFERENCE,
      asset: USDC_SOLANA_DEVNET,
      treasuries: [TREASURY, OTHER_TREASURY, TREASURY],
    });
    expect([...legs.entries()]).toEqual([
      [TREASURY, FEE],
      [OTHER_TREASURY, 0n],
    ]);
  });

  it('ignores a leg under another reference, in another asset, or without markers', async () => {
    const instructions = directInstructionsFromCompiledMessage(await paidWith(FEE));
    const query = { reference: REFERENCE, asset: USDC_SOLANA_DEVNET, treasuries: [TREASURY] };
    expect(
      (await boundTreasuryLegs(instructions, { ...query, reference: OTHER_REFERENCE })).get(
        TREASURY,
      ),
    ).toBe(0n);
    expect(
      (await boundTreasuryLegs(instructions, { ...query, asset: NATIVE_SOL })).get(TREASURY),
    ).toBe(0n);
    const unmarked = directInstructionsFromCompiledMessage(
      await compiledFor(requestFor({ fee: { treasury: TREASURY, amount: FEE } }), false),
    );
    expect((await boundTreasuryLegs(unmarked, query)).get(TREASURY)).toBe(0n);
  });
});

describe('judgeDirectSolanaPayment', () => {
  const evidence = (payeeBound: bigint, fee?: bigint) => ({
    payeeBound,
    ...(fee === undefined ? {} : { fee }),
    blockTime: BLOCK_TIME,
  });

  it('verifies the split the request asks for, both legs bound and both balances risen', async () => {
    const view = landed(await paidWith(FEE), { rows: rowsFor(PRICE - FEE, FEE) });
    expect(await judge(FEE_REQUEST, view)).toEqual({
      verified: true,
      signature: SIGNATURE,
      amount: PRICE - FEE,
      slot: 42n,
      ...evidence(PRICE - FEE, FEE),
    });
  });

  it('verifies the full price with no fee leg as the node does (rule 1)', async () => {
    const view = landed(await compiledFor(requestFor()), { rows: rowsFor(PRICE, 0n) });
    expect(await judge(FEE_REQUEST, view)).toMatchObject({
      verified: true,
      ...evidence(PRICE, 0n),
    });
  });

  it('gives the full price its OWN balance verdict, never the split path', async () => {
    // The payee bound the whole price, its balance rose only `price - fee`:
    // that is rule 1's balance_mismatch, even though `price - fee` would
    // satisfy the split's payee check.
    const view = landed(await compiledFor(requestFor()), { rows: rowsFor(PRICE - FEE, FEE) });
    expect(await judge(FEE_REQUEST, view)).toEqual({
      verified: false,
      reason: 'balance_mismatch',
      ...evidence(PRICE, 0n),
    });
  });

  it('answers unreadable for full-price payee rows it cannot read, with a fee asked', async () => {
    const rows = rowsFor(PRICE, 0n).map((row) =>
      row.owner === RECIPIENT ? { ...row, post: 'x' } : row,
    );
    const view = landed(await compiledFor(requestFor()), { rows });
    expect(await judge(FEE_REQUEST, view)).toMatchObject({
      verified: false,
      reason: 'unreadable',
      payeeBound: PRICE,
    });
  });

  it('holds `price - fee` with an unbound treasury leg: split_unresolved', async () => {
    const compiled = await compiledFor(FEE_REQUEST, false);
    const view = landed(compiled, { rows: rowsFor(PRICE - FEE, FEE) });
    expect(await judge(FEE_REQUEST, view)).toEqual({
      verified: false,
      reason: 'split_unresolved',
      ...evidence(PRICE - FEE, 0n),
    });
  });

  it('holds a payee between the floor and `price - fee`: split_unresolved', async () => {
    // The treasury got more than asked, the payee less: still what the node
    // may credit as a split.
    const view = landed(await paidWith(FEE * 2n), { rows: rowsFor(PRICE - FEE * 2n, FEE * 2n) });
    expect(await judge(FEE_REQUEST, view)).toMatchObject({
      verified: false,
      reason: 'split_unresolved',
      payeeBound: PRICE - FEE * 2n,
    });
  });

  it('holds a payee one subunit short of `price - fee` beside a full fee: split_unresolved', async () => {
    // Both balances rose exactly as bound, so only the payee lower bound of
    // the split rule tells this apart from a verified split.
    const view = landed(await paidWith(FEE, TREASURY, PRICE - 1n), {
      rows: rowsFor(PRICE - FEE - 1n, FEE),
    });
    expect(await judge(FEE_REQUEST, view)).toEqual({
      verified: false,
      reason: 'split_unresolved',
      ...evidence(PRICE - FEE - 1n, FEE),
    });
  });

  it('holds a treasury bound one subunit short of the fee; verifies it at exactly the fee', async () => {
    const short = landed(await paidWith(FEE - 1n), { rows: rowsFor(PRICE - FEE + 1n, FEE - 1n) });
    expect(await judge(FEE_REQUEST, short)).toMatchObject({
      reason: 'split_unresolved',
      fee: FEE - 1n,
    });
    const exact = landed(await paidWith(FEE), { rows: rowsFor(PRICE - FEE, FEE) });
    expect(await judge(FEE_REQUEST, exact)).toMatchObject({ verified: true });
  });

  it('counts a fee leg to another treasury as no fee leg', async () => {
    const rows = [
      ...rowsFor(PRICE - FEE, 0n),
      { owner: OTHER_TREASURY, pre: '0', post: FEE.toString() },
    ];
    const view = landed(await paidWith(FEE, OTHER_TREASURY), { rows });
    expect(await judge(FEE_REQUEST, view)).toEqual({
      verified: false,
      reason: 'split_unresolved',
      ...evidence(PRICE - FEE, 0n),
    });
  });

  it('counts a fee leg in another asset as no fee leg', async () => {
    // The payee in USDC, the treasury in SOL, both under the reference.
    const usdc = directInstructionsFromCompiledMessage(
      await compiledFor(requestFor({ amount: PRICE - FEE })),
    );
    const sol = directInstructionsFromCompiledMessage(
      await compiledFor(
        requestFor({
          asset: NATIVE_SOL,
          amount: FEE + 1n,
          fee: { treasury: TREASURY, amount: FEE },
        }),
      ),
    );
    const legs = await boundTreasuryLegs([...usdc, ...sol], {
      reference: REFERENCE,
      asset: USDC_SOLANA_DEVNET,
      treasuries: [TREASURY],
    });
    expect(legs.get(TREASURY)).toBe(0n);
    const view = landed(await compiledFor(requestFor({ amount: PRICE - FEE })), {
      rows: rowsFor(PRICE - FEE, 0n),
    });
    expect(await judge(FEE_REQUEST, view)).toMatchObject({
      reason: 'split_unresolved',
      fee: 0n,
    });
  });

  it('refuses below the floor as underpaid, carrying what was bound', async () => {
    // A 20% fee leaves the payee 80%: under the node's 90% floor.
    const fee = PRICE / 5n;
    const view = landed(await paidWith(fee), { rows: rowsFor(PRICE - fee, fee) });
    expect(await judge(FEE_REQUEST, view)).toEqual({
      verified: false,
      reason: 'underpaid',
      ...evidence(PRICE - fee, fee),
    });
  });

  it('puts the floor exactly at the price less a fee at the 10% cap', async () => {
    // FLOOR(1_000_000) = 900_000. A fee-LESS stored request too: the node's
    // rule 2 ignores what the buyer asked for.
    const feeless = requestFor();
    const atFloor = landed(await paidWith(100_000n), { rows: rowsFor(900_000n, 100_000n) });
    expect(await judge(feeless, atFloor)).toEqual({
      verified: false,
      reason: 'split_unresolved',
      ...evidence(900_000n),
    });
    const belowFloor = landed(await paidWith(100_001n), { rows: rowsFor(899_999n, 100_001n) });
    expect(await judge(feeless, belowFloor)).toMatchObject({ reason: 'underpaid' });
  });

  it('answers not_bound FIRST: at a price of 1 the floor is 0', async () => {
    const request = requestFor({ amount: 1n });
    const elsewhere = landed(
      await compiledFor(requestFor({ amount: 1n, reference: OTHER_REFERENCE })),
      {
        rows: rowsFor(1n, 0n),
      },
    );
    expect(await judge(request, elsewhere)).toEqual({
      verified: false,
      reason: 'not_bound',
      ...evidence(0n),
    });
  });

  it('refuses a real treasury shortfall as balance_mismatch, final', async () => {
    const view = landed(await paidWith(FEE), { rows: rowsFor(PRICE - FEE, FEE - 1n) });
    expect(await judge(FEE_REQUEST, view)).toEqual({
      verified: false,
      reason: 'balance_mismatch',
      ...evidence(PRICE - FEE, FEE),
    });
  });

  it('refuses a treasury that received less than every transfer into it adds up to', async () => {
    // The bound fee plus an unbound transfer into the treasury, and a balance
    // that rose by the fee only: the same money claimed twice.
    const compiled = await paidWith(FEE);
    const unboundIndex = compiled.instructions.length - 2;
    const unbound = compiled.instructions[unboundIndex];
    if (unbound === undefined) {
      throw new Error('no fee transfer');
    }
    const doubled = {
      ...compiled,
      instructions: [
        ...compiled.instructions,
        { ...unbound, accountIndices: (unbound.accountIndices ?? []).slice(0, 4) },
      ],
    } as CompiledTransactionMessage;
    const view = landed(doubled, { rows: rowsFor(PRICE - FEE, FEE) });
    expect(await judge(FEE_REQUEST, view)).toMatchObject({ reason: 'balance_mismatch' });
    const enough = landed(doubled, { rows: rowsFor(PRICE - FEE, FEE * 2n) });
    expect(await judge(FEE_REQUEST, enough)).toMatchObject({ verified: true });
  });

  it('refuses a payee shortfall on the split path as balance_mismatch', async () => {
    const view = landed(await paidWith(FEE), { rows: rowsFor(PRICE - FEE - 1n, FEE) });
    expect(await judge(FEE_REQUEST, view)).toMatchObject({ reason: 'balance_mismatch' });
  });

  it('answers unreadable for treasury rows it cannot read', async () => {
    const compiled = await paidWith(FEE);
    const unreadable = rowsFor(PRICE - FEE, FEE).map((row) =>
      row.owner === TREASURY ? { ...row, post: 'x' } : row,
    );
    expect(await judge(FEE_REQUEST, landed(compiled, { rows: unreadable }))).toEqual({
      verified: false,
      reason: 'unreadable',
      ...evidence(PRICE - FEE, FEE),
    });
    // No post row for the treasury at all is a page that is incomplete, not a zero.
    const missing = rowsFor(PRICE - FEE, FEE).map((row) =>
      row.owner === TREASURY ? { owner: TREASURY, pre: '0' } : row,
    );
    expect(await judge(FEE_REQUEST, landed(compiled, { rows: missing }))).toMatchObject({
      reason: 'unreadable',
    });
  });

  it('verifies a native SOL split by both lamport balances', async () => {
    const solFee = 30_000n;
    const request = requestFor({ asset: NATIVE_SOL, fee: { treasury: TREASURY, amount: solFee } });
    const compiled = await compiledFor(request);
    const honest = {
      [RECIPIENT]: [10n, 10n + PRICE - solFee] as [bigint, bigint],
      [TREASURY]: [5n, 5n + solFee] as [bigint, bigint],
    };
    expect(await judge(request, landed(compiled, { lamports: honest }))).toMatchObject({
      verified: true,
      ...evidence(PRICE - solFee, solFee),
    });
    const short = { ...honest, [TREASURY]: [5n, 4n + solFee] as [bigint, bigint] };
    expect(await judge(request, landed(compiled, { lamports: short }))).toMatchObject({
      reason: 'balance_mismatch',
    });
  });

  it.each([
    ['a treasury that is the payee', { fee_address: RECIPIENT, fee_amount: Number(FEE) }],
    ['a fee of the whole amount', { fee_address: TREASURY, fee_amount: Number(PRICE) }],
    ['a fee above the amount', { fee_address: TREASURY, fee_amount: Number(PRICE) + 1 }],
    ['a fee address alone', { fee_address: TREASURY }],
    ['a fee amount alone', { fee_amount: Number(FEE) }],
  ])('answers bad_request for %s', async (_label, fields) => {
    const view = landed(await paidWith(FEE), { rows: rowsFor(PRICE - FEE, FEE) });
    expect(await judge({ ...requestFor(), ...fields }, view)).toEqual({
      verified: false,
      reason: 'bad_request',
    });
  });

  it('carries no evidence on a verdict reached before the instructions were read', async () => {
    const compiled = await paidWith(FEE);
    const failed = landed(compiled, { meta: { err: { InstructionError: [0, 'x'] } } });
    expect(await judge(FEE_REQUEST, failed)).toEqual({ verified: false, reason: 'failed' });
  });
});

describe('readDirectSolanaTransaction + judge', () => {
  it('reads once, and verify is exactly read then judge', async () => {
    const view = landed(await paidWith(FEE), { rows: rowsFor(PRICE - FEE, FEE) });
    const rpc = rpcReturning(view);
    const read = await readDirectSolanaTransaction(rpc, SIGNATURE);
    expect(rpc.calls).toBe(1);
    expect(read).toEqual({ found: true, signature: SIGNATURE, transaction: view });
    if (!read.found) {
      throw new Error('not found');
    }
    // One read serves several judgements, with no further chain call.
    const asked = await judgeDirectSolanaPayment(read, FEE_REQUEST);
    const feeless = await judgeDirectSolanaPayment(read, requestFor());
    expect(rpc.calls).toBe(1);
    expect(feeless).toMatchObject({ reason: 'split_unresolved' });
    expect(await verifyDirectSolanaPayment(rpcReturning(view), FEE_REQUEST, SIGNATURE)).toEqual(
      asked,
    );
  });

  it('answers bad_signature without a read, not_found and rpc_error from the node', async () => {
    const rpc = rpcReturning(null);
    expect(await readDirectSolanaTransaction(rpc, 'nope')).toEqual({
      found: false,
      reason: 'bad_signature',
    });
    expect(rpc.calls).toBe(0);
    expect(await readDirectSolanaTransaction(rpc, SIGNATURE)).toEqual({
      found: false,
      reason: 'not_found',
    });
    const failing = {
      getTransaction: () => ({
        send: async () => {
          throw new Error('node down');
        },
      }),
    } as unknown as Rpc<SolanaRpcApi>;
    expect(await readDirectSolanaTransaction(failing, SIGNATURE)).toEqual({
      found: false,
      reason: 'rpc_error',
    });
  });

  it('never reads the chain for a bad request', async () => {
    const rpc = rpcReturning(null);
    expect(
      await verifyDirectSolanaPayment(
        rpc,
        { ...requestFor(), fee_address: RECIPIENT, fee_amount: 1 },
        SIGNATURE,
      ),
    ).toEqual({ verified: false, reason: 'bad_request' });
    expect(rpc.calls).toBe(0);
  });
});
