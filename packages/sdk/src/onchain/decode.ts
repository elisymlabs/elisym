/**
 * Step one of the verifier: turn the provider's base64 transaction into one
 * canonical object the rest of the checks read.
 *
 * Address lookup tables are RESOLVED here, not banned. A routed swap only fits
 * in a transaction because its account list is compressed through tables, so
 * refusing them would exclude the main "any smart contract" case; what matters
 * is that the full account list is known before anything is asserted. A table
 * the RPC will not give us is a refusal, never a partial list.
 *
 * The resolved table map is handed back with the message so the verifier can
 * re-compress when it recompiles under its own fee payer and lifetime. Note
 * what that does and does not buy: an account the provider already looked up
 * survives on its own, because decompiling leaves each instruction account as a
 * lookup meta and `compileTransaction` rebuilds `addressTableLookups` from
 * those without any map. What re-compression adds is the accounts the provider
 * left STATIC that also happen to sit in one of its tables - worth having on a
 * routed swap near the 1232-byte limit, but not load-bearing.
 */

import {
  decompileTransactionMessage,
  fetchAddressesForLookupTables,
  getBase64Encoder,
  isSolanaError,
  SOLANA_ERROR__ACCOUNTS__EXPECTED_ALL_ACCOUNTS_TO_BE_DECODED,
  SOLANA_ERROR__ACCOUNTS__ONE_OR_MORE_ACCOUNTS_NOT_FOUND,
  SOLANA_ERROR__TRANSACTION__FAILED_TO_DECOMPILE_ADDRESS_LOOKUP_TABLE_CONTENTS_MISSING,
  SOLANA_ERROR__TRANSACTION__FAILED_TO_DECOMPILE_ADDRESS_LOOKUP_TABLE_INDEX_OUT_OF_RANGE,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Address,
  type AddressesByLookupTableAddress,
  type GetMultipleAccountsApi,
  type Rpc,
} from '@solana/kit';
import { describeError, refuse } from './errors';

type CompiledMessage = ReturnType<
  ReturnType<typeof getCompiledTransactionMessageDecoder>['decode']
>;

/**
 * The shape every later step reads an instruction through. Kit's decompiled
 * message types are a union (lookup-table accounts widen them), which makes
 * plain `.map`/`.filter` uncallable at the call site; narrowing once here keeps
 * one cast in the codebase instead of one per step.
 */
export interface CallInstructionAccount {
  address: string;
  role: number;
}

export interface CallInstruction {
  programAddress: string;
  accounts?: readonly CallInstructionAccount[];
  data?: ArrayLike<number>;
}

export interface DecodedCall {
  /** Signers whose signature is already attached (empty for a proper unsigned call). */
  signedBy: string[];
  /** Addresses looked up through tables, empty when the call uses none. */
  lookupTables: AddressesByLookupTableAddress;
  /** Fee payer, lifetime and instructions with every account resolved. */
  message: ReturnType<typeof decompileTransactionMessage>;
}

/**
 * Decode, resolve lookup tables, decompile. Throws `OnchainRefusalError` -
 * never a raw decoder error - so the caller's refusal reasons stay a closed set.
 */
export async function decodeCallTransaction(
  base64Transaction: string,
  rpc: Rpc<GetMultipleAccountsApi>,
): Promise<DecodedCall> {
  let signedBy: string[];
  let compiled: CompiledMessage;
  try {
    const bytes = new Uint8Array(getBase64Encoder().encode(base64Transaction));
    const transaction = getTransactionDecoder().decode(bytes);
    signedBy = Object.entries(transaction.signatures)
      .filter(([, signature]) => signature !== null)
      .map(([signerAddress]) => signerAddress);
    compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  } catch (error) {
    refuse(
      'undecodable-transaction',
      `the capability returned bytes that are not a Solana transaction (${describe(error)})`,
    );
  }

  const tableAddresses = lookupTableAddressesOf(compiled);
  let lookupTables: AddressesByLookupTableAddress = {};
  if (tableAddresses.length > 0) {
    try {
      lookupTables = await fetchAddressesForLookupTables(tableAddresses, rpc);
    } catch (error) {
      // Matched on the error CODE, never on its message.
      //
      // A rate limit or a dropped connection is transient, and this reason's
      // headline - "part of this call's account list could not be read" - reads
      // permanent and blames the provider, so the two must be told apart. Two
      // earlier attempts did it by string: first the words "address table",
      // which kit never says, then the table's own address, which kit prints
      // when `process.env.NODE_ENV !== 'production'`. Every shipped build sets
      // it, and `@solana/errors` then drops its message catalog entirely - the
      // browser bundle has none of it - so the address survives only inside
      // `context`, the match failed, and a permanent provider fault reached the
      // customer as "the chain could not be reached". Tests run outside a
      // production build, so the suite could not see it: the code is what is
      // present in every build.
      //
      // These two codes are exactly what `fetchAddressesForLookupTables`
      // asserts, in this order: decoded (an address that is not a table
      // account) then exists (a table that is gone). It is called with the
      // table addresses and nothing else, so either code IS about them and no
      // cross-check against the address is needed.
      //
      // An address that is not a table but that the node CAN parse as something
      // else passes both assertions with an undefined address list and fails at
      // `decompileTransactionMessage` below, whose own catch owns the same
      // reason - so it never reaches here.
      if (
        isSolanaError(error, SOLANA_ERROR__ACCOUNTS__ONE_OR_MORE_ACCOUNTS_NOT_FOUND) ||
        isSolanaError(error, SOLANA_ERROR__ACCOUNTS__EXPECTED_ALL_ACCOUNTS_TO_BE_DECODED)
      ) {
        refuse(
          'lookup-table-unavailable',
          `an address lookup table this call depends on could not be read, so its full account list is unknown (${describeTables(error, tableAddresses)})`,
        );
      }
      throw error;
    }
  }

  let message: ReturnType<typeof decompileTransactionMessage>;
  try {
    message = decompileTransactionMessage(
      compiled as Parameters<typeof decompileTransactionMessage>[0],
      { addressesByLookupTableAddress: lookupTables },
    );
  } catch (error) {
    // Only the two failures that are ABOUT a table. Blaming the tables for any
    // decompile failure is the same mislabel this file already fixed for
    // `assertAccountsResolved`: a stray program index in a call that happens to
    // carry a healthy table reported "part of this call's account list could
    // not be read", sending the operator hunting a table that is fine, while
    // the identical call without a table said `undecodable-transaction`. A
    // missing fee payer and a program address that does not resolve are not
    // table problems, whatever else the call carries.
    if (
      isSolanaError(
        error,
        SOLANA_ERROR__TRANSACTION__FAILED_TO_DECOMPILE_ADDRESS_LOOKUP_TABLE_CONTENTS_MISSING,
      ) ||
      isSolanaError(
        error,
        SOLANA_ERROR__TRANSACTION__FAILED_TO_DECOMPILE_ADDRESS_LOOKUP_TABLE_INDEX_OUT_OF_RANGE,
      )
    ) {
      refuse(
        'lookup-table-unavailable',
        `an address lookup table this call depends on did not contain the accounts it indexes (${describe(error)})`,
      );
    }
    refuse('undecodable-transaction', `the call's message could not be read (${describe(error)})`);
  }
  // OUTSIDE the try on purpose: this raises a refusal of its own, and the catch
  // above would swallow it and re-raise it as `lookup-table-unavailable` for any
  // call carrying tables - which is most routed traffic, and the wrong reason.
  assertAccountsResolved(message);
  return { signedBy, lookupTables, message };
}

/**
 * Kit resolves an instruction's account indices against the message's account
 * list, and range-checks only the LOOKUP-TABLE half: a static index past the
 * end yields `undefined` instead of throwing. Left alone it surfaces far
 * downstream as a `TypeError` on `account.role`, which the verifier can only
 * report as "the chain could not be reached" - a transient, retryable-sounding
 * message for a permanently malformed call. Refusing it here is also what lets
 * every later step read `CallInstruction.accounts` as the fully resolved list
 * its type claims it is.
 */
function assertAccountsResolved(message: ReturnType<typeof decompileTransactionMessage>) {
  const instructions = message.instructions as unknown as readonly {
    accounts?: readonly (CallInstructionAccount | undefined)[];
  }[];
  for (const instruction of instructions) {
    for (const account of instruction.accounts ?? []) {
      if (account === undefined) {
        refuse(
          'undecodable-transaction',
          'the call indexes an account that is not in its own account list',
        );
      }
    }
  }
}

function lookupTableAddressesOf(compiled: CompiledMessage): Address[] {
  if (!('addressTableLookups' in compiled) || !Array.isArray(compiled.addressTableLookups)) {
    return [];
  }
  const addresses = compiled.addressTableLookups.map((lookup) => lookup.lookupTableAddress);
  return [...new Set(addresses)];
}

function describe(error: unknown): string {
  return describeError(error);
}

/**
 * Which tables failed, said without depending on the error's message. The
 * addresses live in `context` in every build; the message does not.
 */
function describeTables(error: unknown, tableAddresses: readonly Address[]): string {
  const context = (error as { context?: Record<string, unknown> } | null)?.context;
  const named = context?.addresses;
  const addresses = Array.isArray(named) && named.length > 0 ? named : tableAddresses;
  return `tables: ${addresses.join(', ')}`;
}

/** The call's instructions, read through the narrow view above. */
export function instructionsOf(decoded: DecodedCall): readonly CallInstruction[] {
  return decoded.message.instructions as unknown as readonly CallInstruction[];
}
