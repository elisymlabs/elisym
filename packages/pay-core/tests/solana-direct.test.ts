/**
 * Direct-mode payments on Solana: the instruction-level binding, the paged
 * reference lookup, and verification of a landed transaction.
 */
import { MEMO_PROGRAM_ADDRESS } from '@solana-program/memo';
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import {
  type Address,
  type CompiledTransactionMessage,
  address,
  appendTransactionMessageInstructions,
  compileTransactionMessage,
  createNoopSigner,
  createTransactionMessage,
  getBase58Decoder,
  getBase58Encoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Blockhash,
  type Rpc,
  type SolanaRpcApi,
} from '@solana/kit';
import { describe, expect, it } from 'vitest';
import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS_STR,
  ELISYM_PROTOCOL_TAG,
  SYSTEM_PROGRAM_ADDRESS_STR,
  getProtocolProgramId,
} from '../src/constants';
import {
  LSM_SOLANA_MAINNET,
  NATIVE_SOL,
  TOKEN_2022_PROGRAM_ADDRESS_STR,
  USDCE_TEMPO_MAINNET,
  USDC_SOLANA_DEVNET,
} from '../src/payment/assets';
import {
  type DirectInstruction,
  boundTransferAmount,
  composeSolanaPaymentRequest,
  directInstructionsFromCompiledMessage,
  directInstructionsFromRpcTransaction,
  listReferenceSignatures,
  verifyDirectSolanaPayment,
} from '../src/payment/direct';
import { buildPaymentInstructions } from '../src/payment/solana';
import type { PaymentRequestData } from '../src/types';

const PAYER = address('9vSzVjVGUKqs6vEk1sKc3RPCRkAQfKHDzEkqM6ErqJkz');
const RECIPIENT = address('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU');
const REFERENCE = address('9X2A3QwTyptFanKJABbs62fSYnsBqUdXZrmeiJRHwGy2');
const OTHER_REFERENCE = address('4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T');
const BLOCKHASH = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi' as Blockhash;
const NOW = 1_790_000_000;
const PRICE = 49_000_000n;
const SIGNATURE = getBase58Decoder().decode(new Uint8Array(64).fill(7));
const PROGRAM_IDS: string[] = [
  TOKEN_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS_STR,
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS_STR,
  COMPUTE_BUDGET_PROGRAM_ADDRESS_STR,
  MEMO_PROGRAM_ADDRESS,
];

function requestFor(asset = USDC_SOLANA_DEVNET, amount = PRICE): PaymentRequestData {
  return composeSolanaPaymentRequest({
    recipient: RECIPIENT,
    amount,
    asset,
    network: 'devnet',
    reference: REFERENCE,
    createdAt: NOW,
  });
}

async function compiledFor(
  request: PaymentRequestData,
  network: 'devnet' | 'mainnet' = 'devnet',
  version: 0 | 'legacy' = 0,
): Promise<CompiledTransactionMessage> {
  const payer = createNoopSigner(PAYER);
  const instructions = await buildPaymentInstructions(request, payer, {
    programId: getProtocolProgramId(network),
  });
  const message = pipe(
    createTransactionMessage({ version }),
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

async function honestInstructions(request = requestFor()): Promise<DirectInstruction[]> {
  return directInstructionsFromCompiledMessage(await compiledFor(request));
}

const expectation = { reference: REFERENCE, recipient: RECIPIENT, asset: USDC_SOLANA_DEVNET };

async function recipientAta(): Promise<Address> {
  const [ata] = await findAssociatedTokenPda({
    owner: RECIPIENT,
    mint: address(USDC_SOLANA_DEVNET.mint ?? ''),
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  return ata;
}

function boundTransfer(
  destination: string,
  amount: bigint,
  markers: [string, string],
  roles: { referenceWritable?: boolean } = {},
): DirectInstruction {
  const data = new Uint8Array(10);
  data[0] = 12;
  new DataView(data.buffer).setBigUint64(1, amount, true);
  data[9] = USDC_SOLANA_DEVNET.decimals;
  const plain = { writable: false, signer: false };
  return {
    program: TOKEN_PROGRAM_ADDRESS,
    accounts: [
      { address: 'Source1111111111111111111111111111111111111', writable: true, signer: false },
      { address: USDC_SOLANA_DEVNET.mint ?? '', ...plain },
      { address: destination, writable: true, signer: false },
      { address: PAYER, writable: false, signer: true },
      { address: markers[0], writable: roles.referenceWritable ?? false, signer: false },
      { address: markers[1], ...plain },
    ],
    data,
  };
}

describe('boundTransferAmount', () => {
  it('counts the transfer buildPaymentInstructions makes, reference then protocol tag', async () => {
    expect(await boundTransferAmount(await honestInstructions(), expectation)).toBe(PRICE);
  });

  it('counts nothing for a coin of another chain, or a transfer-shaped instruction of another program', async () => {
    const instructions = await honestInstructions();
    expect(
      await boundTransferAmount(instructions, { ...expectation, asset: USDCE_TEMPO_MAINNET }),
    ).toBe(0n);
    const lookalike = boundTransfer(await recipientAta(), PRICE, [REFERENCE, ELISYM_PROTOCOL_TAG]);
    expect(await boundTransferAmount([lookalike], expectation)).toBe(PRICE);
    expect(
      await boundTransferAmount(
        [{ ...lookalike, program: 'Fake111111111111111111111111111111111111111' }],
        expectation,
      ),
    ).toBe(0n);
  });

  it('counts native SOL the same way', async () => {
    const request = requestFor(NATIVE_SOL, 5_000_000n);
    const instructions = await honestInstructions(request);
    expect(await boundTransferAmount(instructions, { ...expectation, asset: NATIVE_SOL })).toBe(
      5_000_000n,
    );
  });

  it('never credits one transfer to two orders: a second reference in the tag slot pays nothing', async () => {
    const ata = await recipientAta();
    const both = boundTransfer(ata, PRICE, [REFERENCE, OTHER_REFERENCE]);
    expect(await boundTransferAmount([both], expectation)).toBe(0n);
    expect(await boundTransferAmount([both], { ...expectation, reference: OTHER_REFERENCE })).toBe(
      0n,
    );
  });

  it('credits each order only its own instruction, not the whole balance change', async () => {
    // Full price bound to order A, 1 subunit bound to order B, one transaction.
    const ata = await recipientAta();
    const instructions = [
      boundTransfer(ata, PRICE, [REFERENCE, ELISYM_PROTOCOL_TAG]),
      boundTransfer(ata, 1n, [OTHER_REFERENCE, ELISYM_PROTOCOL_TAG]),
    ];
    expect(await boundTransferAmount(instructions, expectation)).toBe(PRICE);
    expect(
      await boundTransferAmount(instructions, { ...expectation, reference: OTHER_REFERENCE }),
    ).toBe(1n);
  });

  it('sums several bound instructions for one order', async () => {
    const ata = await recipientAta();
    const half = boundTransfer(ata, PRICE / 2n, [REFERENCE, ELISYM_PROTOCOL_TAG]);
    expect(await boundTransferAmount([half, half], expectation)).toBe(PRICE);
  });

  it('binds only exactly two markers, and only a System Transfer, not another 12-byte System call', async () => {
    const ata = await recipientAta();
    const threeMarkers = boundTransfer(ata, PRICE, [REFERENCE, ELISYM_PROTOCOL_TAG]);
    threeMarkers.accounts.push({ address: OTHER_REFERENCE, writable: false, signer: false });
    expect(await boundTransferAmount([threeMarkers], expectation)).toBe(0n);
    const systemCall = (discriminator: number): DirectInstruction => {
      const data = new Uint8Array(12);
      const view = new DataView(data.buffer);
      view.setUint32(0, discriminator, true);
      view.setBigUint64(4, PRICE, true);
      return {
        program: SYSTEM_PROGRAM_ADDRESS_STR,
        accounts: [
          { address: PAYER, writable: true, signer: true },
          { address: RECIPIENT, writable: true, signer: false },
          { address: REFERENCE, writable: false, signer: false },
          { address: ELISYM_PROTOCOL_TAG, writable: false, signer: false },
        ],
        data,
      };
    };
    const sol = { ...expectation, asset: NATIVE_SOL };
    expect(await boundTransferAmount([systemCall(2)], sol)).toBe(PRICE);
    // Allocate (8) has the same data length as Transfer.
    expect(await boundTransferAmount([systemCall(8)], sol)).toBe(0n);
    // Short data is refused, not read past its end.
    const shortSystem = systemCall(2);
    expect(
      await boundTransferAmount([{ ...shortSystem, data: shortSystem.data.slice(0, 4) }], sol),
    ).toBe(0n);
    const shortToken = boundTransfer(ata, PRICE, [REFERENCE, ELISYM_PROTOCOL_TAG]);
    expect(
      await boundTransferAmount(
        [{ ...shortToken, data: shortToken.data.slice(0, 5) }],
        expectation,
      ),
    ).toBe(0n);
  });

  it('refuses a writable reference, another destination, mint or decimals', async () => {
    const ata = await recipientAta();
    const markers: [string, string] = [REFERENCE, ELISYM_PROTOCOL_TAG];
    expect(
      await boundTransferAmount(
        [boundTransfer(ata, PRICE, markers, { referenceWritable: true })],
        expectation,
      ),
    ).toBe(0n);
    expect(await boundTransferAmount([boundTransfer(RECIPIENT, PRICE, markers)], expectation)).toBe(
      0n,
    );
    const signerReference = boundTransfer(ata, PRICE, markers);
    signerReference.accounts[4] = { address: REFERENCE, writable: false, signer: true };
    expect(await boundTransferAmount([signerReference], expectation)).toBe(0n);
    const wrongDecimals = boundTransfer(ata, PRICE, markers);
    wrongDecimals.data[9] = 9;
    expect(await boundTransferAmount([wrongDecimals], expectation)).toBe(0n);
    const wrongMint = boundTransfer(ata, PRICE, markers);
    expect(
      await boundTransferAmount(
        [
          {
            ...wrongMint,
            accounts: wrongMint.accounts.map((entry, index) =>
              index === 1 ? { ...entry, address: PAYER } : entry,
            ),
          },
        ],
        expectation,
      ),
    ).toBe(0n);
  });

  it('refuses a reference that is the payee, its token account, the tag, the mint or a program', async () => {
    const ata = await recipientAta();
    // Control: the same shape under a proper reference binds.
    expect(
      await boundTransferAmount(
        [boundTransfer(ata, PRICE, [REFERENCE, ELISYM_PROTOCOL_TAG])],
        expectation,
      ),
    ).toBe(PRICE);
    for (const reference of [
      RECIPIENT,
      ata,
      ELISYM_PROTOCOL_TAG,
      USDC_SOLANA_DEVNET.mint ?? '',
      ...PROGRAM_IDS,
    ]) {
      // Each candidate sits in the reference slot, read-only and unsigned, so only
      // the denylist can refuse it.
      const instruction = boundTransfer(ata, PRICE, [reference, ELISYM_PROTOCOL_TAG]);
      expect(await boundTransferAmount([instruction], { ...expectation, reference })).toBe(0n);
    }
  });
});

describe('the readers agree on roles', () => {
  it('reads a Token-2022 asset (LSM on mainnet) as the builder attaches it', async () => {
    const request = composeSolanaPaymentRequest({
      recipient: RECIPIENT,
      amount: 1_000_000n,
      asset: LSM_SOLANA_MAINNET,
      network: 'mainnet',
      reference: REFERENCE,
      createdAt: NOW,
    });
    const instructions = directInstructionsFromCompiledMessage(
      await compiledFor(request, 'mainnet'),
    );
    expect(
      await boundTransferAmount(instructions, { ...expectation, asset: LSM_SOLANA_MAINNET }),
    ).toBe(1_000_000n);
  });

  it('accepts the markers from a lookup table only as read-only addresses', async () => {
    const request = requestFor();
    const compiled = await compiledFor(request);
    const view = rpcView(compiled, { pre: '0', post: PRICE.toString() });
    const message = (view.transaction as { message: Record<string, unknown> }).message;
    const keys = message.accountKeys as string[];
    const moved = [REFERENCE as string, ELISYM_PROTOCOL_TAG as string];
    const kept = keys.filter((key) => !moved.includes(key));
    const remap = (index: number) => {
      const key = keys[index] ?? '';
      return moved.includes(key) ? kept.length + moved.indexOf(key) : kept.indexOf(key);
    };
    const header = message.header as Record<string, number>;
    const relocated = {
      ...view,
      transaction: {
        message: {
          ...message,
          accountKeys: kept,
          header: {
            ...header,
            numReadonlyUnsignedAccounts: (header.numReadonlyUnsignedAccounts ?? 0) - 2,
          },
          instructions: (
            message.instructions as { programIdIndex: number; accounts: number[]; data: string }[]
          ).map((instruction) => ({
            ...instruction,
            programIdIndex: remap(instruction.programIdIndex),
            accounts: instruction.accounts.map(remap),
          })),
        },
      },
    };
    const asReadonly = {
      ...relocated,
      meta: { ...(view.meta as object), loadedAddresses: { writable: [], readonly: moved } },
    };
    expect(
      await boundTransferAmount(directInstructionsFromRpcTransaction(asReadonly), expectation),
    ).toBe(PRICE);
    const asWritable = {
      ...relocated,
      meta: { ...(view.meta as object), loadedAddresses: { writable: moved, readonly: [] } },
    };
    expect(
      await boundTransferAmount(directInstructionsFromRpcTransaction(asWritable), expectation),
    ).toBe(0n);
  });
});

describe('directInstructionsFromCompiledMessage', () => {
  it('reads a legacy message the same way', async () => {
    const compiled = await compiledFor(requestFor(), 'devnet', 'legacy');
    expect(compiled.version).toBe('legacy');
    expect(
      await boundTransferAmount(directInstructionsFromCompiledMessage(compiled), expectation),
    ).toBe(PRICE);
  });

  it('refuses a header whose counts do not fit its keys', async () => {
    const compiled = await compiledFor(requestFor());
    const skewed = {
      ...compiled,
      header: { ...compiled.header, numReadonlyNonSignerAccounts: 99 },
    } as CompiledTransactionMessage;
    expect(() => directInstructionsFromCompiledMessage(skewed)).toThrow(/header/);
  });

  it('refuses a message with address lookup tables', async () => {
    const compiled = await compiledFor(requestFor());
    const withLookups = {
      ...compiled,
      addressTableLookups: [
        { lookupTableAddress: PAYER, readonlyIndexes: [0], writableIndexes: [] },
      ],
    } as CompiledTransactionMessage;
    expect(() => directInstructionsFromCompiledMessage(withLookups)).toThrow(/lookup tables/);
  });
});

/** The json-encoded view an RPC gives of a compiled message that landed. */
function rpcView(
  compiled: CompiledTransactionMessage,
  balances: { pre: string; post: string },
  meta: Record<string, unknown> = {},
): Record<string, unknown> {
  if (compiled.version !== 0 && compiled.version !== 'legacy') {
    throw new Error('unexpected version');
  }
  const base58 = getBase58Decoder();
  const staticAccounts = compiled.staticAccounts.map(String);
  return {
    slot: 42n,
    blockTime: NOW + 10,
    transaction: {
      message: {
        accountKeys: staticAccounts,
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
      // The payer's source account (same mint, another owner) is always on the page
      // too, and the payee may hold another coin that moves in the same transaction;
      // both fall here, so counting either would sink an honest payment.
      preTokenBalances: [
        {
          accountIndex: 2,
          mint: USDC_SOLANA_DEVNET.mint,
          owner: PAYER,
          uiTokenAmount: { amount: (PRICE * 100n).toString() },
        },
        {
          accountIndex: 3,
          mint: LSM_SOLANA_MAINNET.mint,
          owner: RECIPIENT,
          uiTokenAmount: { amount: (PRICE * 5n).toString() },
        },
        {
          accountIndex: 1,
          mint: USDC_SOLANA_DEVNET.mint,
          owner: RECIPIENT,
          uiTokenAmount: { amount: balances.pre },
        },
      ],
      postTokenBalances: [
        {
          accountIndex: 2,
          mint: USDC_SOLANA_DEVNET.mint,
          owner: PAYER,
          uiTokenAmount: { amount: (PRICE * 99n).toString() },
        },
        {
          accountIndex: 1,
          mint: USDC_SOLANA_DEVNET.mint,
          owner: RECIPIENT,
          uiTokenAmount: { amount: balances.post },
        },
        {
          accountIndex: 3,
          mint: LSM_SOLANA_MAINNET.mint,
          owner: RECIPIENT,
          uiTokenAmount: { amount: (PRICE * 3n).toString() },
        },
      ],
      ...meta,
    },
  };
}

function rpcReturning(transaction: unknown): Rpc<SolanaRpcApi> {
  return {
    getTransaction: () => ({ send: async () => transaction }),
  } as unknown as Rpc<SolanaRpcApi>;
}

describe('verifyDirectSolanaPayment', () => {
  it('verifies a landed transaction the payer built, and reads its instructions as the wallet did', async () => {
    const request = requestFor();
    const compiled = await compiledFor(request);
    const view = rpcView(compiled, { pre: '0', post: PRICE.toString() });
    expect(directInstructionsFromRpcTransaction(view)).toEqual(
      directInstructionsFromCompiledMessage(compiled),
    );
    const result = await verifyDirectSolanaPayment(rpcReturning(view), request, SIGNATURE);
    expect(result).toMatchObject({ verified: true, amount: PRICE, blockTime: NOW + 10, slot: 42n });
  });

  it('refuses a failed, missing, underpaid or unbalanced transaction', async () => {
    const request = requestFor();
    const compiled = await compiledFor(request);
    const failed = rpcView(
      compiled,
      { pre: '0', post: PRICE.toString() },
      { err: { InstructionError: [0, 'x'] } },
    );
    expect(await verifyDirectSolanaPayment(rpcReturning(failed), request, SIGNATURE)).toEqual({
      verified: false,
      reason: 'failed',
    });
    expect(await verifyDirectSolanaPayment(rpcReturning(null), request, SIGNATURE)).toEqual({
      verified: false,
      reason: 'not_found',
    });
    const dearer = { ...request, amount: request.amount + 1 };
    expect(
      await verifyDirectSolanaPayment(
        rpcReturning(rpcView(compiled, { pre: '0', post: PRICE.toString() })),
        dearer,
        SIGNATURE,
      ),
    ).toEqual({ verified: false, reason: 'underpaid' });
    const unbalanced = rpcView(compiled, { pre: '0', post: (PRICE - 1n).toString() });
    expect(await verifyDirectSolanaPayment(rpcReturning(unbalanced), request, SIGNATURE)).toEqual({
      verified: false,
      reason: 'balance_mismatch',
    });
  });

  it('refuses a payment under another order reference', async () => {
    const request = requestFor();
    const compiled = await compiledFor(request);
    const other = { ...request, reference: OTHER_REFERENCE };
    const view = rpcView(compiled, { pre: '0', post: PRICE.toString() });
    expect(await verifyDirectSolanaPayment(rpcReturning(view), other, SIGNATURE)).toEqual({
      verified: false,
      reason: 'not_bound',
    });
  });

  it('refuses a bad request or signature before asking the chain, and a node error is its own answer', async () => {
    const request = requestFor();
    const view = rpcView(await compiledFor(request), { pre: '0', post: PRICE.toString() });
    let calls = 0;
    const counting = {
      getTransaction: () => ({
        send: async () => {
          calls += 1;
          return view;
        },
      }),
    } as unknown as Rpc<SolanaRpcApi>;
    await verifyDirectSolanaPayment(counting, { ...request, amount: 0 }, SIGNATURE);
    await verifyDirectSolanaPayment(counting, request, 'IGNORE PREVIOUS');
    expect(calls).toBe(0);
    for (const amount of [0, -1, 1.5]) {
      expect(
        await verifyDirectSolanaPayment(rpcReturning(view), { ...request, amount }, SIGNATURE),
      ).toEqual({
        verified: false,
        reason: 'bad_request',
      });
    }
    expect(await verifyDirectSolanaPayment(rpcReturning(view), request, 'IGNORE PREVIOUS')).toEqual(
      {
        verified: false,
        reason: 'bad_signature',
      },
    );
    const failing = {
      getTransaction: () => ({
        send: async () => {
          throw new Error('Transaction version (1) is not supported');
        },
      }),
    } as unknown as Rpc<SolanaRpcApi>;
    expect(await verifyDirectSolanaPayment(failing, request, SIGNATURE)).toEqual({
      verified: false,
      reason: 'rpc_error',
    });
  });

  it('answers unreadable (ask again) for a token row it cannot read, never a zero baseline', async () => {
    const request = requestFor();
    const view = rpcView(await compiledFor(request), { pre: '0', post: PRICE.toString() });
    const meta = view.meta as Record<string, unknown>;
    meta.preTokenBalances = [
      { accountIndex: 1, mint: USDC_SOLANA_DEVNET.mint, uiTokenAmount: { amount: '5' } },
    ];
    expect(await verifyDirectSolanaPayment(rpcReturning(view), request, SIGNATURE)).toEqual({
      verified: false,
      reason: 'unreadable',
    });
    // A page with rows but none for the payee's account after the transfer: incomplete.
    meta.preTokenBalances = [];
    meta.postTokenBalances = [
      {
        accountIndex: 2,
        mint: USDC_SOLANA_DEVNET.mint,
        owner: PAYER,
        uiTokenAmount: { amount: '1' },
      },
    ];
    expect(await verifyDirectSolanaPayment(rpcReturning(view), request, SIGNATURE)).toEqual({
      verified: false,
      reason: 'unreadable',
    });
    // A node that records no token balances at all: ask again, not a final mismatch.
    meta.preTokenBalances = [];
    meta.postTokenBalances = [];
    expect(await verifyDirectSolanaPayment(rpcReturning(view), request, SIGNATURE)).toEqual({
      verified: false,
      reason: 'unreadable',
    });
  });

  it('verifies native SOL by the lamport balance', async () => {
    const request = requestFor(NATIVE_SOL, 5_000_000n);
    const compiled = await compiledFor(request);
    const view = rpcView(compiled, { pre: '0', post: '0' });
    const keys = (view.transaction as { message: { accountKeys: string[] } }).message.accountKeys;
    const index = keys.indexOf(RECIPIENT);
    const pre = keys.map(() => 10_000_000n);
    const post = keys.map((_key, keyIndex) => (keyIndex === index ? 15_000_000n : 10_000_000n));
    Object.assign(view.meta as object, { preBalances: pre, postBalances: post });
    expect(await verifyDirectSolanaPayment(rpcReturning(view), request, SIGNATURE)).toMatchObject({
      verified: true,
      amount: 5_000_000n,
    });
    const short = keys.map((_key, keyIndex) => (keyIndex === index ? 14_000_000n : 10_000_000n));
    Object.assign(view.meta as object, { postBalances: short });
    expect(await verifyDirectSolanaPayment(rpcReturning(view), request, SIGNATURE)).toEqual({
      verified: false,
      reason: 'balance_mismatch',
    });
  });

  it('never counts a self-transfer: one real transfer cannot back two orders', async () => {
    // A delegate on the payee's token account moves P from it to itself under
    // order A's reference, and pays P for real under order B's.
    const ata = await recipientAta();
    const real = boundTransfer(ata, PRICE, [OTHER_REFERENCE, ELISYM_PROTOCOL_TAG]);
    const self = boundTransfer(ata, PRICE, [REFERENCE, ELISYM_PROTOCOL_TAG]);
    const selfFromPayee = {
      ...self,
      accounts: self.accounts.map((entry, index) =>
        index === 0 ? { ...entry, address: ata } : entry,
      ),
    };
    expect(await boundTransferAmount([real, selfFromPayee], expectation)).toBe(0n);
    expect(
      await boundTransferAmount([real, selfFromPayee], {
        ...expectation,
        reference: OTHER_REFERENCE,
      }),
    ).toBe(PRICE);
  });

  it('refuses when the payee received less than all the transfers into it add up to', async () => {
    // P bound to order A, P bound to order B (two stores, two claim ledgers), and
    // a delegate pulling P back out of the payee's account: the balance rose by P.
    const request = requestFor();
    const view = rpcView(await compiledFor(request), { pre: '0', post: PRICE.toString() });
    const message = (
      view.transaction as {
        message: {
          accountKeys: string[];
          header: Record<string, number>;
          instructions: { programIdIndex: number; accounts: number[]; data: string }[];
        };
      }
    ).message;
    const transfer = message.instructions.find(
      (instruction) =>
        instruction.data.length > 0 && getBase58Encoder().encode(instruction.data)[0] === 12,
    );
    if (!transfer) {
      throw new Error('no transfer in the fixture');
    }
    // Read-only non-signer keys sit at the end of the static list, so appending one
    // keeps every other key's role.
    message.accountKeys.push(OTHER_REFERENCE);
    message.header = {
      ...message.header,
      numReadonlyUnsignedAccounts: (message.header.numReadonlyUnsignedAccounts ?? 0) + 1,
    };
    const referenceIndex = message.accountKeys.indexOf(REFERENCE);
    const otherIndex = message.accountKeys.length - 1;
    message.instructions.push({
      ...transfer,
      accounts: transfer.accounts.map((index) => (index === referenceIndex ? otherIndex : index)),
    });
    const other = { ...request, reference: OTHER_REFERENCE };
    // Each order alone is bound to exactly P...
    const instructions = directInstructionsFromRpcTransaction(view);
    expect(await boundTransferAmount(instructions, expectation)).toBe(PRICE);
    expect(
      await boundTransferAmount(instructions, { ...expectation, reference: OTHER_REFERENCE }),
    ).toBe(PRICE);
    // ...but 2P was transferred in and only P stayed: neither order is paid by this transaction.
    for (const order of [request, other]) {
      expect(await verifyDirectSolanaPayment(rpcReturning(view), order, SIGNATURE)).toEqual({
        verified: false,
        reason: 'balance_mismatch',
      });
    }
  });

  it('answers bad_request for a request no transfer can be bound to, or one with a fee leg', async () => {
    const request = requestFor();
    const view = rpcView(await compiledFor(request), { pre: '0', post: PRICE.toString() });
    for (const reference of [
      '1'.repeat(40),
      RECIPIENT,
      ELISYM_PROTOCOL_TAG,
      USDC_SOLANA_DEVNET.mint ?? '',
      await recipientAta(),
      ...PROGRAM_IDS,
    ]) {
      expect(
        await verifyDirectSolanaPayment(rpcReturning(view), { ...request, reference }, SIGNATURE),
      ).toEqual({ verified: false, reason: 'bad_request' });
    }
    expect(
      await verifyDirectSolanaPayment(
        rpcReturning(view),
        { ...request, fee_address: PAYER, fee_amount: 10 },
        SIGNATURE,
      ),
    ).toEqual({ verified: false, reason: 'bad_request' });
  });

  it('refuses a json header whose counts do not fit its keys', () => {
    const view = {
      transaction: {
        message: {
          accountKeys: [PAYER],
          header: {
            numRequiredSignatures: 5,
            numReadonlySignedAccounts: 0,
            numReadonlyUnsignedAccounts: 0,
          },
          instructions: [],
        },
      },
      meta: { loadedAddresses: { writable: [], readonly: [] } },
    };
    expect(() => directInstructionsFromRpcTransaction(view)).toThrow();
  });

  it('refuses a request whose coin is not of its own network', async () => {
    const request = requestFor();
    const view = rpcView(await compiledFor(request), { pre: '0', post: PRICE.toString() });
    expect(
      await verifyDirectSolanaPayment(
        rpcReturning(view),
        { ...request, network: 'mainnet' },
        SIGNATURE,
      ),
    ).toEqual({ verified: false, reason: 'bad_request' });
  });

  it('finds a SOL payee among the loaded addresses', async () => {
    const request = requestFor(NATIVE_SOL, 5_000_000n);
    const compiled = await compiledFor(request);
    const view = rpcView(compiled, { pre: '0', post: '0' });
    const message = (view.transaction as { message: Record<string, unknown> }).message;
    const keys = message.accountKeys as string[];
    const kept = keys.filter((key) => key !== RECIPIENT);
    const remap = (index: number) =>
      keys[index] === RECIPIENT ? kept.length : kept.indexOf(keys[index] ?? '');
    const header = message.header as Record<string, number>;
    message.accountKeys = kept;
    // The recipient was a writable non-signer static key; loaded writable keys are not counted in the header.
    message.header = { ...header };
    message.instructions = (
      message.instructions as { programIdIndex: number; accounts: number[]; data: string }[]
    ).map((instruction) => ({
      ...instruction,
      programIdIndex: remap(instruction.programIdIndex),
      accounts: instruction.accounts.map(remap),
    }));
    const balances = [...kept, RECIPIENT].map(() => 10_000_000n);
    const after = [...kept, RECIPIENT].map((_key, index) =>
      index === kept.length ? 15_000_000n : 10_000_000n,
    );
    Object.assign(view.meta as object, {
      loadedAddresses: { writable: [RECIPIENT], readonly: [] },
      preBalances: balances,
      postBalances: after,
    });
    expect(await verifyDirectSolanaPayment(rpcReturning(view), request, SIGNATURE)).toMatchObject({
      verified: true,
      amount: 5_000_000n,
    });
  });

  it('answers unreadable for a page with no err field, and bad_signature for one that can never land', async () => {
    const request = requestFor();
    const view = rpcView(await compiledFor(request), { pre: '0', post: PRICE.toString() });
    delete (view.meta as Record<string, unknown>).err;
    expect(await verifyDirectSolanaPayment(rpcReturning(view), request, SIGNATURE)).toEqual({
      verified: false,
      reason: 'unreadable',
    });
    const untyped = verifyDirectSolanaPayment as (...args: unknown[]) => Promise<unknown>;
    for (const signature of [null, 123, {}, 'IGNORE PREVIOUS']) {
      expect(await untyped(rpcReturning(view), request, signature)).toEqual({
        verified: false,
        reason: 'bad_signature',
      });
    }
  });

  it('answers unreadable for a page without a slot', async () => {
    const request = requestFor();
    const view = rpcView(await compiledFor(request), { pre: '0', post: PRICE.toString() });
    delete view.slot;
    expect(await verifyDirectSolanaPayment(rpcReturning(view), request, SIGNATURE)).toEqual({
      verified: false,
      reason: 'unreadable',
    });
  });

  it('refuses a transaction it cannot read rather than guessing', async () => {
    const request = requestFor();
    const garbled = { meta: { err: null }, transaction: { message: { accountKeys: 'nope' } } };
    expect(await verifyDirectSolanaPayment(rpcReturning(garbled), request, SIGNATURE)).toEqual({
      verified: false,
      reason: 'unreadable',
    });
  });
});

describe('listReferenceSignatures', () => {
  function pagedRpc(pages: { blockTime: number | null }[][]) {
    const calls: unknown[] = [];
    const rpc = {
      getSignaturesForAddress: (_address: unknown, config: unknown) => ({
        send: async () => {
          calls.push(config);
          const page = pages[calls.length - 1] ?? [];
          return page.map((row, index) => ({
            signature: `sig-${calls.length}-${index}`,
            err: null,
            blockTime: row.blockTime,
            slot: 1,
          }));
        },
      }),
    } as unknown as Rpc<SolanaRpcApi>;
    return { rpc, calls };
  }
  const full = (blockTime: number | null) => Array.from({ length: 1000 }, () => ({ blockTime }));

  it('pages with `before` until a signature is older than the floor', async () => {
    const { rpc, calls } = pagedRpc([full(NOW + 5), full(NOW - 5)]);
    const result = await listReferenceSignatures(rpc, REFERENCE, { notBefore: NOW });
    expect(result.complete).toBe(true);
    expect(result.signatures).toHaveLength(2000);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ before: 'sig-1-999', limit: 1000 });
  });

  it('does not stop on a null block time, and says when the page cap cut it short', async () => {
    const { rpc } = pagedRpc([full(null), full(null), full(null)]);
    const result = await listReferenceSignatures(rpc, REFERENCE, { notBefore: NOW, maxPages: 2 });
    expect(result.complete).toBe(false);
    expect(result.signatures).toHaveLength(2000);
  });

  it('refuses a floor in milliseconds and a page cap that is not a positive integer', async () => {
    const { rpc, calls } = pagedRpc([]);
    await expect(
      listReferenceSignatures(rpc, REFERENCE, { notBefore: NOW * 1000 }),
    ).rejects.toThrow('epoch seconds');
    await expect(listReferenceSignatures(rpc, REFERENCE, { notBefore: 1000 })).rejects.toThrow(
      'epoch seconds',
    );
    await expect(
      listReferenceSignatures(rpc, REFERENCE, { notBefore: NOW, maxPages: 0 }),
    ).rejects.toThrow('epoch seconds');
    expect(calls).toHaveLength(0);
  });

  it('ends on a short page', async () => {
    const { rpc, calls } = pagedRpc([[{ blockTime: NOW + 1 }]]);
    expect((await listReferenceSignatures(rpc, REFERENCE, { notBefore: NOW })).complete).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe('composeSolanaPaymentRequest', () => {
  const base = {
    recipient: RECIPIENT,
    amount: PRICE,
    asset: USDC_SOLANA_DEVNET,
    network: 'devnet' as const,
    reference: REFERENCE,
    createdAt: NOW,
  };

  it('carries the given reference and no fee leg', () => {
    const request = composeSolanaPaymentRequest(base);
    expect(request).toMatchObject({
      recipient: RECIPIENT,
      amount: 49_000_000,
      reference: REFERENCE,
      network: 'devnet',
    });
    expect(request.fee_address).toBeUndefined();
    expect(request.fee_amount).toBeUndefined();
    expect(request.asset?.mint).toBe(USDC_SOLANA_DEVNET.mint);
  });

  it('refuses what it must not send, without echoing the value', () => {
    const cases: Partial<typeof base>[] = [
      { recipient: 'IGNORE PREVIOUS' },
      { reference: 'IGNORE PREVIOUS' },
      { reference: RECIPIENT },
      { reference: ELISYM_PROTOCOL_TAG },
      { reference: USDC_SOLANA_DEVNET.mint ?? '' },
      ...PROGRAM_IDS.map((reference) => ({ reference })),
      { amount: 0n },
      { amount: BigInt(Number.MAX_SAFE_INTEGER) + 1n },
      { createdAt: NOW * 1000 },
    ];
    for (const override of cases) {
      let message = '';
      try {
        composeSolanaPaymentRequest({ ...base, ...override });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).not.toBe('');
      expect(message).not.toContain('IGNORE');
    }
  });

  it('refuses a coin of the other network', () => {
    expect(() => composeSolanaPaymentRequest({ ...base, network: 'mainnet' })).toThrow(/network/);
  });
});
