/**
 * The provider's own check, run before a call leaves the agent.
 *
 * The client re-checks everything and trusts none of it; what these tests pin
 * down is that a builder which drifts outside the capability's published
 * promise fails the AGENT's job, so the operator sees a broken skill instead of
 * a customer being told to refuse the call.
 */

import { getTransferSolInstruction } from '@solana-program/system';
import { getTransferInstruction } from '@solana-program/token';
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64Decoder,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getTransactionDecoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
} from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { MAX_CALL_BASE64_CHARS, MAX_INSTRUCTIONS_PER_CALL } from '../src/onchain/constants';
import {
  clientBudgetOverhead,
  lookedUpAccountCount,
  validateProviderCall,
} from '../src/onchain/provider';
import type { SkillOnchainResolved } from '../src/onchain/types';

const SIGNER = address('HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH');
const OTHER_WALLET = address('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin');
const SIGNER_ATA = address('EFUuCAn6RDEzVLgzFBGrTxvYRp3Gcf2ZgdGKfosb5h7S');
const DESTINATION_ATA = address('4ARYGgibfQDcERcBj8E8pjcoE5SmeHXsAHe2HvYKvY78');
const USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const SYSTEM_PROGRAM = address('11111111111111111111111111111111');
const RECENT_BLOCKHASHES_SYSVAR = address('SysvarRecentB1ockHashes11111111111111111111');
const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N';
const LOOKUP_TABLE = address('9ivvJXV8Vg5eSMEvNjHnRfLQ2Zpg2sZbKNwXJVGCHNyG');
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';

const descriptor: SkillOnchainResolved = {
  kind: 'withdraw',
  programs: [TOKEN_PROGRAM],
  requires: [],
  params: [],
  token: 'usdc',
  mint: USDC_MINT,
  decimals: 6,
  symbol: 'USDC',
  max_per_call_subunits: '500000000',
  grants_authority: false,
  max_authority_subunits: '0',
};

function transfer(): Instruction {
  return getTransferInstruction({
    source: SIGNER_ATA,
    destination: DESTINATION_ATA,
    authority: SIGNER,
    amount: 1_000_000n,
  }) as Instruction;
}

function wireOf(
  instructions: Instruction[],
  options: { feePayer?: Address; legacy?: boolean } = {},
): string {
  const message = pipe(
    createTransactionMessage({ version: options.legacy ? 'legacy' : 0 }),
    (msg) => setTransactionMessageFeePayer(options.feePayer ?? SIGNER, msg),
    (msg) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: BLOCKHASH as never, lastValidBlockHeight: 1_000n },
        msg,
      ),
    (msg) => appendTransactionMessageInstructions(instructions, msg),
  );
  return getBase64EncodedWireTransaction(compileTransaction(message));
}

/** Patch an instruction to name an account, or a program, that is not there. */
function withStrayIndex(wire: string, patch: (instruction: never) => unknown): string {
  const transaction = getTransactionDecoder().decode(
    new Uint8Array(getBase64Encoder().encode(wire)),
  );
  const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  const instructions = compiled.instructions.map((instruction, index) =>
    index === 0 ? patch(instruction as never) : instruction,
  );
  const messageBytes = getCompiledTransactionMessageEncoder().encode({
    ...compiled,
    instructions,
  } as Parameters<ReturnType<typeof getCompiledTransactionMessageEncoder>['encode']>[0]);
  return getBase64Decoder().decode(
    getTransactionEncoder().encode({ ...transaction, messageBytes } as Parameters<
      ReturnType<typeof getTransactionEncoder>['encode']
    >[0]),
  );
}

function withStrayAccountIndex(wire: string): string {
  return withStrayIndex(wire, (instruction) => ({ ...instruction, accountIndices: [200] }));
}

function withStrayProgramIndex(wire: string): string {
  return withStrayIndex(wire, (instruction) => ({ ...instruction, programAddressIndex: 200 }));
}

function envelope(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    elisym_call: 'v1',
    network: 'devnet',
    transaction: wireOf([transfer()]),
    signer: SIGNER,
    // Real clock: the provider-side check enforces the same TTL the clients do.
    expires_at: Math.floor(Date.now() / 1000) + 300,
    ...overrides,
  });
}

function validate(output: unknown, network: 'devnet' | 'mainnet' = 'devnet') {
  return validateProviderCall({ output, descriptor, network });
}

describe('validateProviderCall', () => {
  it('passes a call that matches the capability promise', () => {
    const parsed = validate(envelope());
    expect(parsed.signer).toBe(SIGNER);
    expect(parsed.network).toBe('devnet');
  });

  it('accepts the envelope as an object as well as JSON text', () => {
    expect(validate(JSON.parse(envelope())).signer).toBe(SIGNER);
  });

  it('fails the job when the builder wrote prose instead of a call', () => {
    expect(() => validate('here is your withdrawal, sign it')).toThrow(/did not return a call/);
  });

  it('fails the job when the call names the other network', () => {
    expect(() => validate(envelope({ network: 'mainnet' }))).toThrow(/from a devnet agent/);
  });

  it('fails the job when the builder signed the transaction itself', async () => {
    const keypair = await generateKeyPairSigner();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (msg) => setTransactionMessageFeePayerSigner(keypair, msg),
      (msg) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: BLOCKHASH as never, lastValidBlockHeight: 1_000n },
          msg,
        ),
      (msg) =>
        appendTransactionMessageInstructions(
          [
            getTransferInstruction({
              source: SIGNER_ATA,
              destination: DESTINATION_ATA,
              authority: keypair,
              amount: 1n,
            }) as Instruction,
          ],
          msg,
        ),
    );
    const signed = await signTransactionMessageWithSigners(message);
    expect(() =>
      validate(
        envelope({
          transaction: getBase64EncodedWireTransaction(signed),
          signer: keypair.address,
        }),
      ),
    ).toThrow(/returned a signed transaction/);
  });

  it('fails the job when the builder drifts outside its own program list', () => {
    const instruction = getTransferSolInstruction({
      source: SIGNER as never,
      destination: OTHER_WALLET,
      amount: 1n,
    }) as Instruction;
    expect(() => validate(envelope({ transaction: wireOf([instruction]) }))).toThrow(
      new RegExp(`touching ${SYSTEM_PROGRAM}`),
    );
  });

  it('fails the job when the fee payer is not the signer the envelope names', () => {
    expect(() =>
      validate(envelope({ transaction: wireOf([transfer()], { feePayer: OTHER_WALLET }) })),
    ).toThrow(/fee payer/);
  });

  it('fails the job on bytes that are not a transaction', () => {
    expect(() => validate(envelope({ transaction: 'QUJDRA==' }))).toThrow(
      /not a Solana transaction/,
    );
  });

  it('fails the job when the call is already expired', () => {
    expect(() => validate(envelope({ expires_at: Math.floor(Date.now() / 1000) - 1 }))).toThrow(
      /already expired/,
    );
  });

  it('fails the job when the call claims a longer life than any client accepts', () => {
    expect(() =>
      validate(envelope({ expires_at: Math.floor(Date.now() / 1000) + 86_400 })),
    ).toThrow(/valid for longer/);
  });

  it('fails the job on more instructions than a client will check', () => {
    const many = new Array(MAX_INSTRUCTIONS_PER_CALL + 1).fill(transfer());
    expect(() => validate(envelope({ transaction: wireOf(many) }))).toThrow(/instructions/);
  });

  it('never sees a transaction past the wire limit - the envelope cap is derived from it', () => {
    // The base64 cap in the schema IS the 1232-byte wire limit, so an
    // oversized transaction is refused as a malformed envelope, earlier.
    const oversized = 'A'.repeat(MAX_CALL_BASE64_CHARS + 4);
    expect(() => validate(envelope({ transaction: oversized }))).toThrow(/did not return a call/);
  });
});

describe('validateProviderCall - shapes every client refuses after payment', () => {
  // Each of these is a call the CLIENT refuses. The provider gate exists so the
  // operator fails their own job instead of the customer paying first, and none
  // of them was checked here: the gate reads no instruction data, no account
  // roles and no lifetime.

  it('refuses an undeclared approve, which the card promised it would not do', () => {
    // `grants_authority` is false on this descriptor, so the client refuses
    // with `authority-grant-not-declared` - after the customer has paid.
    const approve = {
      programAddress: TOKEN_PROGRAM,
      accounts: [
        { address: SIGNER_ATA, role: 1 },
        { address: OTHER_WALLET, role: 0 },
        { address: SIGNER, role: 3 },
      ],
      data: new Uint8Array([4, 0, 0, 0, 0, 0, 0, 0, 1]),
    } as unknown as Instruction;
    expect(() => validate(envelope({ transaction: wireOf([approve]) }))).toThrow(
      /authority-grant-not-declared/,
    );
  });

  it('refuses a SetAuthority, which no card can declare', () => {
    const setAuthority = {
      programAddress: TOKEN_PROGRAM,
      accounts: [
        { address: SIGNER_ATA, role: 1 },
        { address: SIGNER, role: 3 },
      ],
      data: new Uint8Array([6, 2, 1]),
    } as unknown as Instruction;
    expect(() => validate(envelope({ transaction: wireOf([setAuthority]) }))).toThrow(
      /account-authority-changed/,
    );
  });

  it('refuses a call needing a second signature', () => {
    // The routine way in is System `CreateAccount`, which makes the new account
    // a signer. Kit leaves an unsigned message's signatures null, so the
    // `already-signed` check cannot see this - the compiled header can.
    const twoSigners = {
      programAddress: TOKEN_PROGRAM,
      accounts: [
        { address: SIGNER, role: 3 },
        { address: OTHER_WALLET, role: 3 },
      ],
      data: new Uint8Array([1]),
    } as unknown as Instruction;
    expect(() => validate(envelope({ transaction: wireOf([twoSigners]) }))).toThrow(
      /requiring 2 signatures/,
    );
  });

  it('refuses a durable-nonce lifetime, which a signature would outlive', () => {
    // Not a field: a durable nonce IS a leading System `AdvanceNonceAccount`,
    // which is how kit decides it too. A card listing the System program sails
    // past the program allowlist.
    // KIT'S EXACT SHAPE, which is what decides the client's answer: four data
    // bytes, three accounts, the recent-blockhashes sysvar second, the
    // authority signing. An earlier fixture here carried only two accounts -
    // a shape the CLIENT accepts, so it pinned a rule looser than the client's
    // and never exercised the case this test is named for.
    const advanceNonce = {
      programAddress: SYSTEM_PROGRAM,
      accounts: [
        { address: DESTINATION_ATA, role: 1 },
        { address: RECENT_BLOCKHASHES_SYSVAR, role: 0 },
        { address: SIGNER, role: 3 },
      ],
      data: new Uint8Array([4, 0, 0, 0]),
    } as unknown as Instruction;
    const wide = { ...descriptor, programs: [...descriptor.programs, SYSTEM_PROGRAM] };
    expect(() =>
      validateProviderCall({
        output: envelope({ transaction: wireOf([advanceNonce, transfer()]) }),
        descriptor: wide,
        network: 'devnet',
      }),
    ).toThrow(/durable-nonce/);
  });

  it('does NOT refuse a leading System 4 that is not a nonce advance', () => {
    // The other half of matching the client: kit requires exactly three
    // accounts and the sysvar, so a System instruction that merely leads with
    // discriminator 4 is an ordinary call the client signs. Refusing it here
    // would fail the operator's own job for a shape no client rejects, which is
    // the one thing this gate must never do.
    const notANonce = {
      programAddress: SYSTEM_PROGRAM,
      accounts: [{ address: SIGNER, role: 3 }],
      data: new Uint8Array([4, 0, 0, 0]),
    } as unknown as Instruction;
    const wide = { ...descriptor, programs: [...descriptor.programs, SYSTEM_PROGRAM] };
    expect(() =>
      validateProviderCall({
        output: envelope({ transaction: wireOf([notANonce, transfer()]) }),
        descriptor: wide,
        network: 'devnet',
      }),
    ).not.toThrow();
  });

  it('refuses indices that resolve to nothing, which the client calls undecodable', () => {
    // Two shapes the client refuses as `undecodable-transaction` and this gate
    // shipped: a stray account index, and a program index pointing past the
    // static list (a program id can never come from a lookup table). No real
    // builder emits them, but catching what the client catches is the gate's
    // stated purpose.
    const wire = wireOf([transfer()]);
    expect(() => validate(envelope({ transaction: withStrayAccountIndex(wire) }))).toThrow(
      /resolves to nothing/,
    );
    expect(() => validate(envelope({ transaction: withStrayProgramIndex(wire) }))).toThrow(
      /program index/,
    );
  });

  it('refuses a transaction message version it cannot read', () => {
    // v1 has no `instructions` array at all - its compute budget rides a
    // message-level `config`, so a provider-chosen priority fee is invisible to
    // every instruction-shaped rule. The client refuses the version by name;
    // without this guard the loop below would throw a bare `TypeError` off
    // `compiled.instructions.filter`.
    const built = pipe(
      createTransactionMessage({ version: 1 as never }),
      (msg) => setTransactionMessageFeePayer(SIGNER, msg),
      (msg) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: BLOCKHASH as never, lastValidBlockHeight: 1_000n },
          msg,
        ),
      (msg) => appendTransactionMessageInstructions([transfer()], msg),
    ) as unknown as Record<string, unknown>;
    const withConfig = { ...built, config: { priorityFeeLamports: 1_000_000_000n } };
    const wire = getBase64EncodedWireTransaction(compileTransaction(withConfig as never));
    expect(() => validate(envelope({ transaction: wire }))).toThrow(/message version/);
  });

  it('refuses a call that expires before the customer could ever sign it', () => {
    // Between here and the wallet sit a Nostr round trip, a payment and a
    // two-pass simulation. Two seconds of validity is "expired" after payment.
    expect(() => validate(envelope({ expires_at: Math.floor(Date.now() / 1000) + 2 }))).toThrow(
      /must stay valid at least/,
    );
  });

  it('refuses account metas on a budget instruction the client keeps', () => {
    // A preserved budget instruction travels into the signed transaction with
    // its metas, skipping the signer rules - so the client refuses it. A
    // PRICING one is stripped first, and refusing those would reject real
    // routed traffic.
    const heapWithMetas = {
      programAddress: COMPUTE_BUDGET,
      accounts: [{ address: SIGNER, role: 3 }],
      data: new Uint8Array([1, 0, 0, 4, 0]),
    } as unknown as Instruction;
    expect(() => validate(envelope({ transaction: wireOf([heapWithMetas, transfer()]) }))).toThrow(
      /never takes any/,
    );
  });

  it('still accepts metas on a PRICING budget instruction, which is stripped', () => {
    // Measured over 2,369 mainnet transactions: 43 attach metas, all of them to
    // a pricing discriminator, Jupiter routes among them.
    const priceWithMetas = {
      programAddress: COMPUTE_BUDGET,
      accounts: [{ address: SIGNER, role: 3 }],
      data: new Uint8Array([3, 0, 0, 0, 0, 0, 0, 0, 0]),
    } as unknown as Instruction;
    expect(() =>
      validate(envelope({ transaction: wireOf([priceWithMetas, transfer()]) })),
    ).not.toThrow();
  });
});

describe('validateProviderCall - the client adds bytes of its own', () => {
  it('fails the agent’s own job for a call that only fits before the client’s budget', () => {
    // The customer would otherwise pay, and only then meet `oversized-transaction`.
    // Discriminator 200: not one of the SPL shapes the static gate refuses, so
    // the size check is what this case actually reaches.
    const filler = (): Instruction =>
      ({
        programAddress: TOKEN_PROGRAM,
        accounts: [],
        data: new Uint8Array(40).fill(200),
      }) as unknown as Instruction;
    const fat = Array.from({ length: 24 }, filler);
    expect(() => validate(envelope({ transaction: wireOf(fat) }))).toThrow(/must stay within/);
  });

  it('gives back the bytes of metas on a budget instruction it will strip', () => {
    // Real builders attach account metas to a pricing instruction - 43 of the
    // 43 mainnet budget-meta transactions sampled do, Jupiter routes among them
    // - and the client strips the whole instruction, metas included. Not
    // reclaiming their index bytes made this gate over-strict, failing the
    // OPERATOR's own job for a size problem the client would never have.
    const priced = (accountIndices: number[]) => ({
      version: 0 as const,
      staticAccounts: [SIGNER, SIGNER_ATA, COMPUTE_BUDGET],
      instructions: [
        {
          programAddressIndex: 2,
          data: new Uint8Array([3, 0x40, 0x4b, 0x4c, 0, 0, 0, 0, 0]),
          accountIndices,
        },
      ],
    });
    // Every meta on a stripped instruction is one more byte handed back.
    expect(clientBudgetOverhead(priced([])) - clientBudgetOverhead(priced([1, 1, 1]))).toBe(3);
  });

  it('counts one lookup slot once, however often the call names it', () => {
    // A repeated (table, index) resolves to the same address, so it is one
    // account lock; counting it twice would fail the operator's job for a call
    // that fits. Kit's compressor never emits a duplicate, so this shape only
    // arrives from another builder - which is exactly who this gate is for.
    const withRepeats = {
      version: 0 as const,
      staticAccounts: [SIGNER],
      instructions: [{ programAddressIndex: 0 }],
      addressTableLookups: [
        { lookupTableAddress: LOOKUP_TABLE, readonlyIndexes: [1, 1, 2], writableIndexes: [3, 3] },
      ],
    };
    // Three distinct slots: readonly 1 and 2, writable 3.
    expect(lookedUpAccountCount(withRepeats)).toBe(3);
    // The same index on both sides is two different locks, and stays two.
    expect(
      lookedUpAccountCount({
        ...withRepeats,
        addressTableLookups: [
          { lookupTableAddress: LOOKUP_TABLE, readonlyIndexes: [5], writableIndexes: [5] },
        ],
      }),
    ).toBe(2);
  });

  it('fails the agent’s own job for a call past Solana’s account limit', async () => {
    // The client's budget instructions claim one of the 64 account slots when
    // the call does not already name the ComputeBudget program, so the real
    // budget is 63. Without this the operator's job succeeds and only the
    // paying customer meets the failure - which is what this gate exists to
    // prevent. Looked-up accounts count: they cannot be named offline, but
    // their indices can be, and each is one slot.
    const extras = await Promise.all(Array.from({ length: 62 }, () => generateKeyPairSigner()));
    const instruction = {
      programAddress: TOKEN_PROGRAM,
      accounts: extras.map((extra) => ({ address: extra.address, role: 1 })),
      data: new Uint8Array([9]),
    } as unknown as Instruction;
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (msg) => setTransactionMessageFeePayer(SIGNER, msg),
      (msg) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: BLOCKHASH as never, lastValidBlockHeight: 1_000n },
          msg,
        ),
      (msg) => appendTransactionMessageInstructions([instruction], msg),
    );
    const compressed = compressTransactionMessageUsingAddressLookupTables(message, {
      [LOOKUP_TABLE]: extras.map((extra) => extra.address),
    });
    const wire = getBase64EncodedWireTransaction(compileTransaction(compressed));
    expect(() => validate(envelope({ transaction: wire }))).toThrow(/within 63 accounts/);
  });

  it('fails the agent’s own job for a call that would do nothing', () => {
    // A builder that silently emitted nothing is the operator's problem, not a
    // call the customer pays for and signs for no effect. A budget-only call is
    // the same thing wearing an instruction: the client strips the pricing ones
    // and appends its own, so nothing of the provider's survives.
    expect(() => validate(envelope({ transaction: wireOf([]) }))).toThrow(
      /no instruction that acts/,
    );
    const budgetOnly = {
      programAddress: address('ComputeBudget111111111111111111111111111111'),
      accounts: [],
      data: new Uint8Array([2, 0, 0, 4, 0]),
    } as unknown as Instruction;
    expect(() => validate(envelope({ transaction: wireOf([budgetOnly]) }))).toThrow(
      /no instruction that acts/,
    );
  });

  it('names the budget SKILLS.md publishes, and two bytes less for a legacy message', () => {
    // The number an operator sizes against. A v0 message carrying no budget
    // instruction pays 20 for the client's pair plus 32 for the program's
    // account slot; a legacy one pays two more, because the client rebuilds it
    // as v0 (version prefix plus an empty address-table-lookups array).
    const filler = (): Instruction =>
      ({
        programAddress: TOKEN_PROGRAM,
        accounts: [],
        data: new Uint8Array(40).fill(200),
      }) as unknown as Instruction;
    const fat = Array.from({ length: 24 }, filler);
    expect(() => validate(envelope({ transaction: wireOf(fat) }))).toThrow(
      /must stay within 1180 bytes/,
    );
    expect(() => validate(envelope({ transaction: wireOf(fat, { legacy: true }) }))).toThrow(
      /must stay within 1178 bytes/,
    );
  });
});
