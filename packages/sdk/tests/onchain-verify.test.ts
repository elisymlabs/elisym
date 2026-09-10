/**
 * The verifier's refusal matrix. Every case here is a call a hostile or broken
 * capability could hand a wallet, and the test asserts the exact reason it is
 * refused - the browser and MCP render these words, so a reason changing
 * silently is a product change.
 *
 * No wallet, no network: transactions are built in-test with kit and the RPC is
 * a fake that returns exactly the pre/post state each case needs.
 */

import {
  getAllocateInstruction,
  getAssignInstruction,
  getAssignWithSeedInstruction,
  getTransferSolInstruction,
} from '@solana-program/system';
import {
  AuthorityType,
  getApproveCheckedInstruction,
  getApproveInstruction,
  getSetAuthorityInstruction,
  getTransferInstruction,
} from '@solana-program/token';
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createNoopSigner,
  createTransactionMessage,
  assertAccountsDecoded,
  assertAccountsExist,
  SOLANA_ERROR__JSON_RPC__INVALID_PARAMS,
  SolanaError,
  getBase64Decoder,
  getBase64EncodedWireTransaction,
  generateKeyPairSigner,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getTransactionDecoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  setTransactionMessageLifetimeUsingDurableNonce,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type Rpc,
  type SolanaRpcApi,
} from '@solana/kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  defaultCeilings,
  DEFAULT_INCIDENTAL_LAMPORTS,
  MAX_INCIDENTAL_LAMPORTS,
  parseOnchainDescriptor,
  verifyOnchainCall,
  type OnchainDescriptor,
  type OnchainRefusalReason,
} from '../src/onchain';
// By path, not through the barrel: the barrel is the module's outward face and
// deliberately exports no internal of the pipeline.
import { PRICE_INSTRUCTION_BYTES } from '../src/onchain/simulate';
import { clearPriorityFeeCache } from '../src/payment/priorityFee';

const SIGNER = address('HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH');
const OTHER_WALLET = address('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin');
const SIGNER_ATA = address('EFUuCAn6RDEzVLgzFBGrTxvYRp3Gcf2ZgdGKfosb5h7S');
const DESTINATION_ATA = address('4ARYGgibfQDcERcBj8E8pjcoE5SmeHXsAHe2HvYKvY78');
const USDC_MINT = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const OTHER_MINT = address('So11111111111111111111111111111111111111112');
const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const SYSTEM_PROGRAM = address('11111111111111111111111111111111');
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
const LENDING_PROGRAM = address('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');
const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N';
const NOW = 1_757_193_000;

const USDC = 1_000_000n; // one whole USDC in subunits
const SIGNER_LAMPORTS = 2_000_000_000n;

// --- fixtures -------------------------------------------------------------

function descriptor(overrides: Record<string, unknown> = {}): OnchainDescriptor {
  const parsed = parseOnchainDescriptor({
    network: 'devnet',
    kind: 'withdraw',
    programs: [TOKEN_PROGRAM, LENDING_PROGRAM],
    token: 'usdc',
    mint: USDC_MINT,
    decimals: 6,
    symbol: 'USDC',
    max_per_call_subunits: String(500n * USDC),
    grants_authority: false,
    max_authority_subunits: '0',
    ...overrides,
  });
  if (!parsed) {
    throw new Error('test descriptor is malformed');
  }
  return parsed;
}

interface TokenAccountFields {
  /** Token-2022 account-type byte at offset 165, when the account is longer. */
  accountType?: number;
  /** Token-2022 TLV entries, written in order past the account-type tag. */
  extensions?: { type: number; length: number }[];
  /** Set the `is_native` COption, i.e. make this a wrapped-SOL account. */
  isNative?: boolean;
  mint?: Address;
  owner?: Address;
  amount?: bigint;
  delegate?: Address;
  delegatedAmount?: bigint;
  state?: number;
  closeAuthority?: Address;
}

/** Encode the 165-byte SPL token account layout the verifier decodes. */
function tokenAccount(fields: TokenAccountFields = {}): string {
  // Token-2022 tags anything longer than the base layout at offset 165; the
  // post-state read is unsliced, so that is where the guard applies.
  const data = new Uint8Array(fields.accountType === undefined ? 165 : 200);
  const view = new DataView(data.buffer);
  data.set(base58Bytes(fields.mint ?? USDC_MINT), 0);
  data.set(base58Bytes(fields.owner ?? SIGNER), 32);
  view.setBigUint64(64, fields.amount ?? 0n, true);
  if (fields.delegate) {
    view.setUint32(72, 1, true);
    data.set(base58Bytes(fields.delegate), 76);
    view.setBigUint64(121, fields.delegatedAmount ?? 0n, true);
  }
  if (fields.isNative) {
    view.setUint32(109, 1, true);
  }
  data[108] = fields.state ?? 1;
  if (fields.closeAuthority) {
    view.setUint32(129, 1, true);
    data.set(base58Bytes(fields.closeAuthority), 133);
  }
  if (fields.accountType !== undefined) {
    data[165] = fields.accountType;
  }
  // Token-2022 TLV: u16 type, u16 length, payload. Starts past the base layout
  // and the one-byte account-type tag, and each entry is laid out AFTER the
  // previous one's payload - so a walk that does not advance by the length
  // lands on garbage rather than the next entry.
  let tlvOffset = 166;
  for (const extension of fields.extensions ?? []) {
    view.setUint16(tlvOffset, extension.type, true);
    view.setUint16(tlvOffset + 2, extension.length, true);
    tlvOffset += 4 + extension.length;
  }
  return getBase64Decoder().decode(data);
}

function base58Bytes(value: Address): Uint8Array {
  // Addresses are 32-byte base58; kit's address codec is the inverse of the
  // decoder the verifier uses, so encoding here keeps the round-trip honest.
  const bytes = new Uint8Array(32);
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let carry = 0n;
  for (const character of value) {
    const index = alphabet.indexOf(character);
    if (index < 0) {
      throw new Error(`not base58: ${value}`);
    }
    carry = carry * 58n + BigInt(index);
  }
  for (let position = 31; position >= 0; position -= 1) {
    bytes[position] = Number(carry & 0xffn);
    carry >>= 8n;
  }
  return bytes;
}

interface RawAccountFixture {
  lamports: bigint;
  owner: string;
  executable?: boolean;
  data: [string, string];
  /** True on-chain length. Real nodes always report it; the size bound reads it. */
  space?: number;
}

function systemAccount(lamports: bigint): RawAccountFixture {
  return { lamports, owner: SYSTEM_PROGRAM, data: ['', 'base64'], space: 0 };
}

function tokenAccountFixture(fields: TokenAccountFields, lamports = 2_039_280n): RawAccountFixture {
  const data = tokenAccount(fields);
  // An account longer than the base layout can only be Token-2022's, and its
  // reported `space` must be its real length - a classic-owned 200-byte account
  // cannot exist on chain, and claiming 165 for a 200-byte body would let the
  // fixture pass rules the chain would fail.
  const extended = fields.accountType !== undefined;
  return {
    lamports,
    owner: extended ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM,
    data: [data, 'base64'],
    space: extended ? 200 : 165,
  };
}

/**
 * An SPL Multisig (355 bytes) whose body has been ground so its first 165 bytes
 * decode as a token account owned by the signer. Every byte after offset 3 is
 * caller-chosen at `InitializeMultisig`, so this costs an attacker one account.
 */
function forgedMultisigFixture(lamports: bigint): RawAccountFixture {
  // WRAPPED SOL, and that is what makes this fixture bite. Lamports arriving in
  // an account of the signer's are credited only when it reads as native, so a
  // forgery claiming any other mint is refused by the native check whatever the
  // decoder does with its length - and a test built on one would pass with the
  // multisig rule deleted, proving nothing about it.
  const base = new Uint8Array(
    getBase64Encoder().encode(tokenAccount({ amount: 0n, mint: OTHER_MINT, isNative: true })),
  );
  const data = new Uint8Array(355);
  data.set(base, 0);
  // Byte 165 is inside a stored signer pubkey, so the attacker picks it too:
  // set to `Account` it defeats the Token-2022 type tag, leaving only the
  // length rule between this buffer and a credited inflow.
  data[165] = 2;
  return {
    lamports,
    owner: TOKEN_2022_PROGRAM,
    data: [getBase64Decoder().decode(data), 'base64'],
    space: 355,
  };
}

/** A plain account owned by some program - the shape a lending position has. */
function programOwnedAccount(owner: string, lamports = 10_000_000n): RawAccountFixture {
  return { lamports, owner, data: ['', 'base64'], space: 0 };
}

function programAccount(): RawAccountFixture {
  return {
    lamports: 1n,
    owner: 'NativeLoader1111111111111111111111111111111',
    executable: true,
    data: ['', 'base64'],
    space: 36,
  };
}

type AccountMap = Record<string, RawAccountFixture | null>;

interface FakeRpcOptions {
  pre: AccountMap;
  post?: AccountMap;
  err?: unknown;
  unitsConsumed?: bigint;
  innerInstructions?: unknown[];
  /** Omit the post-state entirely, as an RPC that will not return it does. */
  withoutAccounts?: boolean;
  /** Throw from getMultipleAccounts, i.e. an unreachable chain. */
  accountsThrow?: Error;
  /** What `simulateTransaction` throws, as an RPC error rather than an `err`. */
  simulateThrow?: Error;
  /** Answer the pre-state read with fewer accounts than were asked about. */
  truncatePreState?: boolean;
  /** Programs the simulation reports as reached inside a CPI. */
  innerProgramIds?: string[];
  /** Omit `innerInstructions`, as a node that does not implement it does. */
  withoutInnerInstructions?: boolean;
  /** Report no compute consumption, so the transaction cannot be sized. */
  withoutUnitsConsumed?: boolean;
  /** Answer the pre-state read without `space`, as a non-conforming node would. */
  withoutSpace?: boolean;
  /** Slot the simulation runs at, when it must differ from the pre-state read. */
  simulationSlot?: bigint;
  /** Inner instructions in the `json` encoding, which names programs by index. */
  innerProgramIndexes?: number[];
  /** Collects every wire transaction the fake was asked to simulate, in order. */
  record?: string[];
  /** Address lookup tables this fake can resolve, keyed by table address. */
  lookupTables?: LookupTables;
  /** Collects the config of every pre-state read, so its shape can be asserted. */
  recordReads?: PreStateRead[];
}

/** The half of a `getMultipleAccounts` config the pre-state read is judged on. */
interface PreStateRead {
  dataSlice?: { offset: number; length: number };
  encoding?: string;
}

type LookupTables = Record<string, Address[]>;

/**
 * The accounts a wire transaction actually carries.
 *
 * A real `simulateTransaction` caps `accounts.addresses` by COUNT, not by
 * membership: measured on devnet, a 9-account transaction answers
 * "Too many accounts provided; max 9" at 10 addresses and accepts 9 addresses
 * the transaction never references, returning `null` for each. Under address
 * lookup tables the cap counts the RESOLVED total (2 static + 12 looked up =
 * max 14), which is what makes `watchedAddresses` safe for a routed call.
 *
 * The fake is deliberately STRICTER - it enforces membership - because every
 * address the verifier watches is one the transaction carries, and a fixture
 * that drifts off that set is a fixture asserting something the verifier never
 * does. Strictness in this direction cannot hide a live failure: the fake's
 * rule implies the node's.
 */
/** Whether a wire transaction carries a ComputeBudget instruction of this kind. */
/** How many instructions a recorded wire actually carries. */
function instructionCountOf(wire: string): number {
  const decoded = getTransactionDecoder().decode(new Uint8Array(getBase64Encoder().encode(wire)));
  const compiled = getCompiledTransactionMessageDecoder().decode(
    decoded.messageBytes,
  ) as unknown as { instructions: unknown[] };
  return compiled.instructions.length;
}

/**
 * Debit the fee payer, the way a real node does.
 *
 * `simulateTransaction` loads the transaction accounts BEFORE execution, which
 * charges the fee to the payer, and the account it returns is the debited one.
 * Verified on live mainnet: two simulations of one transfer at one slot,
 * differing only by a 1.4M-CU limit at 5,000,000 microlamports/CU, came back with
 * post-states exactly 7,000,000 lamports apart.
 *
 * Modelling it here is what stops a fixture from asserting a fee-free
 * simulation no node performs - which is how the fee came to be counted twice
 * without a single test noticing.
 */
const PRECOMPILES = [
  'Ed25519SigVerify111111111111111111111111111',
  'KeccakSecp256k11111111111111111111111111111',
  'Secp256r1SigVerify1111111111111111111111111',
];

function chargeFee(entry: RawAccountFixture, address: string | undefined, wire: string) {
  if (address !== SIGNER) {
    return entry;
  }
  const decoded = getTransactionDecoder().decode(new Uint8Array(getBase64Encoder().encode(wire)));
  const compiled = getCompiledTransactionMessageDecoder().decode(
    decoded.messageBytes,
  ) as unknown as {
    staticAccounts: string[];
    instructions: { programAddressIndex: number; data?: Uint8Array }[];
  };
  let limit = 0n;
  let microLamports = 0n;
  for (const instruction of compiled.instructions) {
    if (compiled.staticAccounts[instruction.programAddressIndex] !== COMPUTE_BUDGET) {
      continue;
    }
    const data = instruction.data;
    if (data?.[0] === 2) {
      limit = BigInt(new DataView(data.buffer, data.byteOffset + 1, 4).getUint32(0, true));
    }
    if (data?.[0] === 3) {
      microLamports = new DataView(data.buffer, data.byteOffset + 1, 8).getBigUint64(0, true);
    }
  }
  // Signatures declared INSIDE a precompile instruction are charged too - the
  // runtime bills `5000 x num_total_signatures`, and its total counts them.
  let declared = 0n;
  for (const instruction of compiled.instructions) {
    if (PRECOMPILES.includes(compiled.staticAccounts[instruction.programAddressIndex] ?? '')) {
      declared += BigInt(instruction.data?.[0] ?? 0);
    }
  }
  const priority = (limit * microLamports + 999_999n) / 1_000_000n;
  return { ...entry, lamports: entry.lamports - (5_000n * (1n + declared) + priority) };
}

function hasBudgetDiscriminator(wire: string, discriminator: number): boolean {
  const decoded = getTransactionDecoder().decode(new Uint8Array(getBase64Encoder().encode(wire)));
  const compiled = getCompiledTransactionMessageDecoder().decode(
    decoded.messageBytes,
  ) as unknown as {
    staticAccounts: string[];
    instructions: { programAddressIndex: number; data?: Uint8Array }[];
  };
  return compiled.instructions.some(
    (instruction) =>
      compiled.staticAccounts[instruction.programAddressIndex] === COMPUTE_BUDGET &&
      instruction.data?.[0] === discriminator,
  );
}

/** The compute-unit limit a wire transaction sets, or 0 when it sets none. */
function computeUnitLimitOf(wire: string): number {
  const decoded = getTransactionDecoder().decode(new Uint8Array(getBase64Encoder().encode(wire)));
  const compiled = getCompiledTransactionMessageDecoder().decode(
    decoded.messageBytes,
  ) as unknown as {
    staticAccounts: string[];
    instructions: { programAddressIndex: number; data?: Uint8Array }[];
  };
  for (const instruction of compiled.instructions) {
    const program = compiled.staticAccounts[instruction.programAddressIndex];
    const data = instruction.data;
    // Discriminator 2 is `SetComputeUnitLimit`, followed by a u32 LE.
    if (program === COMPUTE_BUDGET && data !== undefined && data.length >= 5 && data[0] === 2) {
      return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(1, true);
    }
  }
  return 0;
}

function accountsOfWire(wire: string, tables: LookupTables = {}): Set<string> {
  const decoded = getTransactionDecoder().decode(new Uint8Array(getBase64Encoder().encode(wire)));
  const compiled = getCompiledTransactionMessageDecoder().decode(decoded.messageBytes);
  const carried = new Set((compiled as unknown as { staticAccounts: string[] }).staticAccounts);
  // A real node resolves address lookup tables BEFORE counting
  // `accounts.addresses`, so a looked-up key is carried just as a static one is.
  // Without this the fake would reject a correct verifier.
  const lookups =
    (compiled as unknown as { addressTableLookups?: { lookupTableAddress: string }[] })
      .addressTableLookups ?? [];
  for (const lookup of lookups) {
    for (const entry of tables[lookup.lookupTableAddress] ?? []) {
      carried.add(entry);
    }
  }
  return carried;
}

/** The inner-instruction groups the fake reports, in whichever encoding is asked for. */
function innerOf(options: FakeRpcOptions): unknown[] {
  if (options.innerProgramIndexes !== undefined) {
    return [
      {
        index: 0,
        instructions: options.innerProgramIndexes.map((programIdIndex) => ({ programIdIndex })),
      },
    ];
  }
  if (options.innerProgramIds !== undefined) {
    return [
      {
        index: 0,
        instructions: options.innerProgramIds.map((programId) => ({ programId })),
      },
    ];
  }
  return options.innerInstructions ?? [];
}

/** Cut a fixture down to a requested slice, the way `getMultipleAccounts` does. */
function sliceAccountData(entry: RawAccountFixture, length: number | undefined): RawAccountFixture {
  if (length === undefined) {
    return entry;
  }
  const bytes = new Uint8Array(getBase64Encoder().encode(entry.data[0]));
  if (bytes.length <= length) {
    return entry;
  }
  return { ...entry, data: [getBase64Decoder().decode(bytes.subarray(0, length)), 'base64'] };
}

/**
 * A node's own refusal as kit delivers it: the words in `context`, not in the
 * message. Every JSON-RPC error the verifier reasons about arrives this way.
 */
function serverError(serverMessage: string): Error {
  return new SolanaError(SOLANA_ERROR__JSON_RPC__INVALID_PARAMS, {
    __serverMessage: serverMessage,
  } as never);
}

/**
 * The error kit itself raises when a lookup table does not exist, produced by
 * kit's own assertion so it carries the real code and context. Hand-built
 * `Error`s hid a gate that could never fire outside a development build.
 */
/** Kit's other lookup-table assertion: the address holds a thing it cannot decode. */
function accountsNotDecoded(address: string): Error {
  try {
    assertAccountsDecoded([
      { address: address as Address, exists: true, data: new Uint8Array(3) },
    ] as never);
  } catch (error) {
    return error as Error;
  }
  throw new Error('assertAccountsDecoded did not throw');
}

function accountsNotFound(address: string): Error {
  try {
    assertAccountsExist([{ address: address as Address, exists: false }] as never);
  } catch (error) {
    return error as Error;
  }
  throw new Error('assertAccountsExist did not throw');
}

/** What `simulateTransaction` returns for an account that is gone or never was. */
const VACANT_ACCOUNT: RawAccountFixture = {
  lamports: 0n,
  owner: SYSTEM_PROGRAM,
  data: ['', 'base64'],
  space: 0,
};

function fakeRpc(options: FakeRpcOptions): Rpc<SolanaRpcApi> {
  const post = options.post ?? options.pre;
  const lookup = (map: AccountMap, addresses: readonly string[]) =>
    addresses.map((entry) => map[entry] ?? null);
  return {
    getLatestBlockhash: () => ({
      send: async () => ({
        value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1_000n },
      }),
    }),
    getMultipleAccounts: (addresses: readonly string[], config?: PreStateRead) => ({
      send: async () => {
        if (options.accountsThrow) {
          throw options.accountsThrow;
        }
        if (options.recordReads && config?.encoding !== 'jsonParsed') {
          options.recordReads.push(config ?? {});
        }
        // Lookup tables are fetched separately, with `jsonParsed` encoding -
        // kit reads the decoded `addresses` array, never the raw bytes.
        if (config?.encoding === 'jsonParsed') {
          return {
            context: { slot: 1_000n },
            value: addresses.map((entry) => {
              const table = (options.lookupTables ?? {})[entry];
              return table === undefined
                ? null
                : {
                    lamports: 1_000_000n,
                    owner: 'AddressLookupTab1e1111111111111111111111111',
                    executable: false,
                    space: BigInt(56 + table.length * 32),
                    data: {
                      program: 'address-lookup-table',
                      parsed: { type: 'lookupTable', info: { addresses: table } },
                    },
                  };
            }),
          };
        }
        const withSpace = lookup(options.pre, addresses).map((entry) => {
          if (!entry) {
            return entry;
          }
          // Real nodes honour `dataSlice` and still report the TRUE `space`.
          // Returning full data here would hide any rule that depends on the
          // difference between the sliced pre-state and the whole post-state.
          const sliced = sliceAccountData(entry, config?.dataSlice?.length);
          return options.withoutSpace ? { ...sliced, space: undefined } : sliced;
        });
        return {
          context: { slot: 1_000n },
          // A short answer is how an RPC hides an account from the diff.
          value: options.truncatePreState ? withSpace.slice(0, -1) : withSpace,
        };
      },
    }),
    simulateTransaction: (
      wire: string,
      config: {
        accounts?: { addresses: readonly string[] };
        minContextSlot?: bigint;
        sigVerify?: boolean;
        replaceRecentBlockhash?: boolean;
        innerInstructions?: boolean;
      },
    ) => ({
      send: async () => {
        if (options.simulateThrow) {
          throw options.simulateThrow;
        }
        options.record?.push(wire);
        // A real node honours these; asserting them here is what stops the
        // options silently going missing. The authoritative pass must not be
        // allowed to read a bank older than the pre-state it is diffed against.
        if (config.sigVerify !== false || config.replaceRecentBlockhash !== true) {
          throw new Error('simulateTransaction called without the client-controlled lifetime');
        }
        if (config.accounts !== undefined) {
          if (config.innerInstructions !== true) {
            throw new Error('the authoritative pass must ask for inner instructions');
          }
          if (config.minContextSlot === undefined) {
            throw new Error('the authoritative pass must pin a minimum context slot');
          }
        }
        // Agave's `decode_and_deserialize` refuses a simulate payload over the
        // packet limit before it ever runs. Modelling it is what stops a size
        // rule from passing here while failing against every real node.
        if (Buffer.from(wire, 'base64').length > 1232) {
          throw new Error('encoded solana_transaction::versioned::VersionedTransaction too large');
        }
        const carried = accountsOfWire(wire, options.lookupTables ?? {});
        const requested = config.accounts?.addresses ?? [];
        const stray = requested.find((entry) => !carried.has(entry));
        if (stray !== undefined) {
          throw new Error(`Too many accounts provided; max ${carried.size} (stray ${stray})`);
        }
        return {
          context: { slot: options.simulationSlot ?? 1_000n },
          value: {
            err: options.err ?? null,
            ...(options.withoutUnitsConsumed
              ? {}
              : { unitsConsumed: options.unitsConsumed ?? 5_000n }),
            ...(options.withoutInnerInstructions ? {} : { innerInstructions: innerOf(options) }),
            accounts:
              config.accounts === undefined
                ? null
                : options.withoutAccounts
                  ? null
                  : // A real node answers a CLOSED or absent account with a
                    // zeroed object here, not `null` - `simulateTransaction`
                    // bypasses the zero-lamport filter `getMultipleAccounts`
                    // applies. Modelling `null` would exercise a shape no node
                    // produces.
                    lookup(post, requested).map((entry, index) =>
                      chargeFee(entry ?? VACANT_ACCOUNT, requested[index], wire),
                    ),
          },
        };
      },
    }),
    getRecentPrioritizationFees: () => ({ send: async () => [] }),
  } as unknown as Rpc<SolanaRpcApi>;
}

// --- transaction builders -------------------------------------------------

function usdcTransfer(amount: bigint): Instruction {
  return getTransferInstruction({
    source: SIGNER_ATA,
    destination: DESTINATION_ATA,
    authority: SIGNER,
    amount,
  }) as Instruction;
}

/**
 * A hand-rolled `SetComputeUnitPrice` (discriminator 3 + u64 micro-lamports).
 * Built here rather than pulled from a client package: the point of the test is
 * that a provider-supplied budget instruction never survives into the signed
 * transaction, and that is byte-level behaviour.
 */
function setComputeUnitPrice(microLamports: bigint): Instruction {
  const data = new Uint8Array(9);
  data[0] = 3;
  new DataView(data.buffer).setBigUint64(1, microLamports, true);
  return {
    programAddress: address('ComputeBudget111111111111111111111111111111'),
    accounts: [],
    data,
  } as unknown as Instruction;
}

function usdcApprove(delegate: Address, amount: bigint): Instruction {
  return getApproveInstruction({
    source: SIGNER_ATA,
    delegate,
    owner: SIGNER,
    amount,
  }) as Instruction;
}

/**
 * A transaction message VERSION 1, which kit 6.8 builds and decodes in full.
 * Its compute budget is not an instruction: it rides a message-level `config`,
 * so every budget rule in `checks.ts` looks straight past a provider-chosen
 * priority fee.
 */
function v1WireWithPriorityFee(lamports: bigint): string {
  const built = pipe(
    createTransactionMessage({ version: 1 as never }),
    (message) => setTransactionMessageFeePayer(SIGNER, message),
    (message) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: BLOCKHASH as never, lastValidBlockHeight: 1_000n },
        message,
      ),
    (message) => appendTransactionMessageInstructions([usdcTransfer(120n * USDC)], message),
  ) as unknown as Record<string, unknown>;
  const withConfig = { ...built, config: { priorityFeeLamports: lamports } };
  return getBase64EncodedWireTransaction(compileTransaction(withConfig as never));
}

function wireOf(
  instructions: Instruction[],
  options: { feePayer?: Address; durableNonce?: boolean } = {},
): string {
  const withFeePayer = pipe(createTransactionMessage({ version: 0 }), (message) =>
    setTransactionMessageFeePayer(options.feePayer ?? SIGNER, message),
  );
  const withLifetime = options.durableNonce
    ? setTransactionMessageLifetimeUsingDurableNonce(
        {
          nonce: BLOCKHASH as never,
          nonceAccountAddress: DESTINATION_ATA,
          nonceAuthorityAddress: options.feePayer ?? SIGNER,
        },
        withFeePayer,
      )
    : setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: BLOCKHASH as never, lastValidBlockHeight: 1_000n },
        withFeePayer,
      );
  const message = appendTransactionMessageInstructions(instructions, withLifetime);
  return getBase64EncodedWireTransaction(compileTransaction(message));
}

/**
 * Point an instruction's first account at an index past the message's own
 * account list. Kit range-checks lookup-table indices but not static ones, so
 * this is the shape that decompiles to `accounts: [undefined]` - unbuildable
 * through the normal builders, which is why it is patched into the bytes.
 */
/** A stray PROGRAM index, which is not a lookup-table failure however it reads. */
function withStrayProgramIndex(wire: string): string {
  const transaction = getTransactionDecoder().decode(
    new Uint8Array(getBase64Encoder().encode(wire)),
  );
  const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  const instructions = compiled.instructions.map((instruction, index) =>
    index === 0 ? { ...instruction, programAddressIndex: 200 } : instruction,
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
  const transaction = getTransactionDecoder().decode(
    new Uint8Array(getBase64Encoder().encode(wire)),
  );
  const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  const instructions = compiled.instructions.map((instruction, index) =>
    index === 0 ? { ...instruction, accountIndices: [200] } : instruction,
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

/**
 * Carry the invoked program as one of its own instruction's WRITABLE metas.
 * Kit refuses to compile that shape, so it cannot be built through the normal
 * path - but web3.js, solana-py and the Rust SDK all emit it happily, which is
 * why the verifier meets it at all. Both halves are needed: the program must be
 * in the instruction's account list AND outside the read-only region, since
 * the rebuild derives its account list from the instructions alone.
 */
function withWritableProgram(wire: string): string {
  const transaction = getTransactionDecoder().decode(
    new Uint8Array(getBase64Encoder().encode(wire)),
  );
  const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  const header = { ...compiled.header, numReadonlyNonSignerAccounts: 0 };
  const instructions = compiled.instructions.map((instruction, index) =>
    index === 0
      ? {
          ...instruction,
          accountIndices: [...(instruction.accountIndices ?? []), instruction.programAddressIndex],
        }
      : instruction,
  );
  const messageBytes = getCompiledTransactionMessageEncoder().encode({
    ...compiled,
    header,
    instructions,
  } as Parameters<ReturnType<typeof getCompiledTransactionMessageEncoder>['encode']>[0]);
  return getBase64Decoder().decode(
    getTransactionEncoder().encode({ ...transaction, messageBytes } as Parameters<
      ReturnType<typeof getTransactionEncoder>['encode']
    >[0]),
  );
}

function envelopeOf(transaction: string, overrides: Record<string, unknown> = {}) {
  return {
    elisym_call: 'v1',
    network: 'devnet',
    transaction,
    signer: SIGNER,
    expires_at: NOW + 300,
    ...overrides,
  };
}

interface VerifyOptions {
  card?: OnchainDescriptor;
  signer?: Address;
  rpc?: Rpc<SolanaRpcApi>;
  envelope?: unknown;
  ceilings?: Parameters<typeof verifyOnchainCall>[0]['ceilings'];
  now?: number;
}

/** Pre/post state of a plain 120 USDC transfer that stays inside every bound. */
function transferState(postAmount: bigint): { pre: AccountMap; post: AccountMap } {
  return {
    pre: {
      [SIGNER]: systemAccount(SIGNER_LAMPORTS),
      [SIGNER_ATA]: tokenAccountFixture({ amount: 500n * USDC }),
      [DESTINATION_ATA]: tokenAccountFixture({ owner: OTHER_WALLET, amount: 0n }),
      [TOKEN_PROGRAM]: programAccount(),
    },
    post: {
      [SIGNER]: systemAccount(SIGNER_LAMPORTS),
      [SIGNER_ATA]: tokenAccountFixture({ amount: postAmount }),
      [DESTINATION_ATA]: tokenAccountFixture({
        owner: OTHER_WALLET,
        amount: 500n * USDC - postAmount,
      }),
      [TOKEN_PROGRAM]: programAccount(),
    },
  };
}

async function verify(options: VerifyOptions = {}) {
  const state = transferState(380n * USDC);
  return verifyOnchainCall({
    envelope: options.envelope ?? envelopeOf(wireOf([usdcTransfer(120n * USDC)])),
    card: options.card ?? descriptor(),
    signer: options.signer ?? SIGNER,
    network: 'devnet',
    rpc: options.rpc ?? fakeRpc(state),
    now: options.now ?? NOW,
    ...(options.ceilings ? { ceilings: options.ceilings } : {}),
  });
}

async function expectRefusal(reason: OnchainRefusalReason, options: VerifyOptions = {}) {
  const result = await verify(options);
  expect(result.ok, `expected a refusal (${reason})`).toBe(false);
  if (!result.ok) {
    expect(result.reason).toBe(reason);
  }
  return result;
}

beforeEach(() => {
  clearPriorityFeeCache();
});

// --- the call that should go through --------------------------------------

describe('verifyOnchainCall - a call inside every bound', () => {
  it('accepts it and reports what the client itself derived', async () => {
    const result = await verify();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.transaction.length).toBeGreaterThan(0);
    expect(result.facts.programs).toEqual([TOKEN_PROGRAM]);
    expect(result.facts.instructionCount).toBe(1);
    expect(result.facts.deltas).toEqual([{ mint: USDC_MINT, subunits: -120n * USDC }]);
    expect(result.facts.grants).toEqual([]);
    // Base signature fee plus the priority floor: small, and well inside the
    // incidental allowance the call is judged against.
    expect(result.facts.feeLamports).toBeGreaterThanOrEqual(5_000n);
    expect(result.facts.feeLamports).toBeLessThan(1_000_000n);
  });

  it('carries the provider explanation through untouched, for the UI to label', async () => {
    const result = await verify({
      envelope: envelopeOf(wireOf([usdcTransfer(120n * USDC)]), {
        explain: [{ kind: 'transfer', asset: 'usdc', amount: '120' }],
      }),
    });
    expect(result.ok && result.facts.explain?.[0]?.amount).toBe('120');
  });

  it('names each program once, and still counts every instruction', async () => {
    // The commonest shape there is - two SPL-token instructions in one call.
    // `programs` is what both clients render as "programs it calls", where a
    // repeated entry reads as a second program the call touches (and collides
    // React keys in the browser's list); `instructionCount` must stay the count.
    const result = await verify({
      envelope: envelopeOf(wireOf([usdcTransfer(60n * USDC), usdcTransfer(60n * USDC)])),
      rpc: fakeRpc(transferState(380n * USDC)),
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.facts.programs).toEqual([TOKEN_PROGRAM]);
    expect(result.ok && result.facts.instructionCount).toBe(2);
  });

  it('applies a client ceiling that is lower than the card, and ignores one that is higher', async () => {
    const tightened = await verify({ ceilings: { spendSubunits: 100n * USDC } });
    expect(tightened.ok).toBe(false);
    expect(tightened.ok === false && tightened.reason).toBe('spend-ceiling-exceeded');

    const widened = await verify({ ceilings: { spendSubunits: 10_000n * USDC } });
    expect(widened.ok && widened.ceilings.spendSubunits).toBe(500n * USDC);
  });

  it('hands back a transaction rebuilt under the client, not the provider bytes', async () => {
    const provided = wireOf([usdcTransfer(120n * USDC)]);
    const result = await verify({ envelope: envelopeOf(provided) });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.transaction).not.toBe(provided);

    const decoded = getTransactionDecoder().decode(
      new Uint8Array(getBase64Encoder().encode(result.transaction)),
    );
    const compiled = getCompiledTransactionMessageDecoder().decode(decoded.messageBytes);
    const accounts = (compiled as unknown as { staticAccounts: string[] }).staticAccounts;
    const programs = (
      compiled as unknown as { instructions: { programAddressIndex: number }[] }
    ).instructions.map((instruction) => accounts[instruction.programAddressIndex]);
    // The client's own budget instructions are there, and the fee payer is the
    // customer - both taken away from the provider on purpose.
    expect(programs).toContain('ComputeBudget111111111111111111111111111111');
    expect(accounts[0]).toBe(SIGNER);
    expect(Object.values(decoded.signatures).every((signature) => signature === null)).toBe(true);
  });

  it('strips the budget the provider tried to set for the customer', async () => {
    const priced = [setComputeUnitPrice(5_000_000n), usdcTransfer(120n * USDC)];
    const result = await verify({ envelope: envelopeOf(wireOf(priced)) });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // One budget-price instruction in the signed transaction, and it is ours:
    // the fee it implies is inside the incidental allowance, not 5 lamports/CU.
    expect(result.facts.feeLamports).toBeLessThan(1_000_000n);
    expect(result.facts.programs).toEqual([TOKEN_PROGRAM]);
  });

  it('defaults its ceilings from the card', () => {
    const ceilings = defaultCeilings(descriptor());
    expect(ceilings.spendSubunits).toBe(500n * USDC);
    expect(ceilings.authoritySubunits).toBe(0n);
    expect(ceilings.incidentalLamports).toBeGreaterThan(0n);
  });
});

// --- envelope ------------------------------------------------------------

describe('verifyOnchainCall - envelope', () => {
  it('refuses anything that is not a call envelope', async () => {
    await expectRefusal('malformed-envelope', { envelope: 'sure, here is your swap' });
  });

  it('refuses a call built for a different wallet', async () => {
    await expectRefusal('wrong-signer', {
      envelope: envelopeOf(wireOf([usdcTransfer(120n * USDC)]), { signer: OTHER_WALLET }),
    });
  });

  it('refuses a call built for the other network', async () => {
    await expectRefusal('wrong-network', {
      envelope: envelopeOf(wireOf([usdcTransfer(120n * USDC)]), { network: 'mainnet' }),
    });
  });

  it('refuses a card from the other network before it reads the call at all', async () => {
    const result = await verifyOnchainCall({
      envelope: envelopeOf(wireOf([usdcTransfer(120n * USDC)])),
      card: descriptor(),
      signer: SIGNER,
      network: 'mainnet',
      rpc: fakeRpc(transferState(380n * USDC)),
      now: NOW,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('wrong-network');
  });

  it('refuses an expired call', async () => {
    await expectRefusal('expired', {
      envelope: envelopeOf(wireOf([usdcTransfer(120n * USDC)]), { expires_at: NOW - 1 }),
    });
  });

  it('refuses a call that claims to stay valid for a week', async () => {
    await expectRefusal('expiry-too-far', {
      envelope: envelopeOf(wireOf([usdcTransfer(120n * USDC)]), { expires_at: NOW + 604_800 }),
    });
  });
});

// --- static shape --------------------------------------------------------

describe('verifyOnchainCall - static shape', () => {
  it('refuses a transaction that already carries a signature', async () => {
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
            getTransferSolInstruction({
              source: keypair,
              destination: OTHER_WALLET,
              amount: 1n,
            }) as Instruction,
          ],
          msg,
        ),
    );
    const signed = await signTransactionMessageWithSigners(message);
    await expectRefusal('already-signed', {
      envelope: envelopeOf(getBase64EncodedWireTransaction(signed), { signer: keypair.address }),
      signer: keypair.address,
      card: descriptor({ programs: [SYSTEM_PROGRAM] }),
    });
  });

  it('refuses a call whose fee comes from someone else', async () => {
    await expectRefusal('foreign-fee-payer', {
      envelope: envelopeOf(wireOf([usdcTransfer(120n * USDC)], { feePayer: OTHER_WALLET })),
    });
  });

  it('does not blow up on a System instruction too short to hold a discriminator', async () => {
    // `getUint32` on fewer than four bytes throws a `RangeError`, which escapes
    // `runStaticChecks` and surfaces as `rpc-unavailable` - transient wording
    // for a permanent shape, and the reason nothing about the call is shown.
    // The length guard is what keeps it a normal refusal; no fixture carried a
    // short System instruction, so nothing pinned it.
    // The System program is ON the card here on purpose: without that the loop
    // refuses `program-not-on-card` first and never reaches the authority
    // check, so the fixture would prove nothing about the guard it names.
    const stub = {
      programAddress: SYSTEM_PROGRAM,
      accounts: [{ address: SIGNER, role: 3 }],
      data: new Uint8Array([1, 0]),
    } as unknown as Instruction;
    const result = await verify({
      envelope: envelopeOf(wireOf([stub, usdcTransfer(120n * USDC)])),
      card: descriptor({ programs: [TOKEN_PROGRAM, LENDING_PROGRAM, SYSTEM_PROGRAM] }),
    });
    expect(result.ok).toBe(true);
  });

  it('refuses a transaction message version whose budget it cannot read', async () => {
    // v1 carries the compute budget in a message-level `config`, not in
    // ComputeBudget instructions - so `isProviderBudgetInstruction`,
    // `CLIENT_PRESERVED_BUDGET_DISCRIMINATORS` and both program filters look
    // straight past a provider-chosen priority fee. One SOL of it here.
    //
    // It cannot reach a wallet today only because the rebuild hard-codes
    // version 0 and drops the config; that is an accident, not a rule, and the
    // drop also loses a legitimate heap request. Refused by name instead.
    await expectRefusal('malformed-instruction', {
      envelope: envelopeOf(v1WireWithPriorityFee(1_000_000_000n)),
    });
  });

  it('refuses a durable nonce lifetime - a signature that never expires', async () => {
    await expectRefusal('durable-nonce-lifetime', {
      envelope: envelopeOf(wireOf([usdcTransfer(120n * USDC)], { durableNonce: true })),
    });
  });

  it('refuses a call that needs a second signature', async () => {
    const instruction = getTransferInstruction({
      source: SIGNER_ATA,
      destination: DESTINATION_ATA,
      authority: createNoopSigner(OTHER_WALLET),
      amount: 1n,
    }) as Instruction;
    await expectRefusal('extra-signer-required', {
      envelope: envelopeOf(wireOf([instruction])),
    });
  });

  it('refuses a program the capability never published', async () => {
    const instruction = getTransferSolInstruction({
      source: SIGNER as never,
      destination: OTHER_WALLET,
      amount: 1n,
    }) as Instruction;
    await expectRefusal('program-not-on-card', { envelope: envelopeOf(wireOf([instruction])) });
  });

  it('refuses an approve the capability never published', async () => {
    await expectRefusal('authority-grant-not-declared', {
      envelope: envelopeOf(wireOf([usdcApprove(OTHER_WALLET, 10n * USDC)])),
    });
  });

  it('refuses undecodable bytes', async () => {
    await expectRefusal('undecodable-transaction', {
      envelope: envelopeOf('QUJDRA=='),
    });
  });
});

// --- simulation ----------------------------------------------------------

describe('verifyOnchainCall - simulation', () => {
  it('refuses a call that fails against current chain state', async () => {
    // BIGINTS, which is what kit decodes every RPC integer to. A real `err` is
    // `{ InstructionError: [0n, { Custom: 1n }] }`, and plain `JSON.stringify`
    // throws on that - so the refusal string threw while being BUILT and the
    // whole thing escaped as "the chain could not be reached". Modelling the
    // shape with plain numbers meant `simulation-failed` passed here while
    // never once firing against a real node.
    const state = transferState(380n * USDC);
    const result = await expectRefusal('simulation-failed', {
      rpc: fakeRpc({ ...state, err: { InstructionError: [0n, { Custom: 1n }] } }),
    });
    // And the chain's own reason survives into what the customer is shown.
    expect(result.ok === false && result.detail).toContain('Custom');
  });

  it('refuses when the RPC will not return the post-state', async () => {
    const state = transferState(380n * USDC);
    await expectRefusal('post-state-unavailable', {
      rpc: fakeRpc({ ...state, withoutAccounts: true }),
    });
  });

  it('refuses when the chain cannot be reached at all', async () => {
    const state = transferState(380n * USDC);
    await expectRefusal('rpc-unavailable', {
      rpc: fakeRpc({ ...state, accountsThrow: new Error('connection refused') }),
    });
  });

  it('refuses a token account whose post-state cannot be decoded', async () => {
    const state = transferState(380n * USDC);
    const post: AccountMap = {
      ...state.post,
      [SIGNER_ATA]: { lamports: 2_039_280n, owner: TOKEN_PROGRAM, data: ['AAAA', 'base64'] },
    };
    await expectRefusal('post-state-unavailable', { rpc: fakeRpc({ pre: state.pre, post }) });
  });
});

// --- what the bound does NOT cover, said out loud -------------------------

describe('verifyOnchainCall - accounts the verifier cannot attribute', () => {
  const LENDING_STATE = address('5rWZFsmzGkVpS8N7hBhKrnBEEbLKWUYUCiTeXPQVCVCv');

  /**
   * The shape that matters most: a program holding the customer's position.
   * Nothing leaves the customer's own accounts, so the deltas are empty - and
   * a client that printed "no value moves" here would be lying.
   */
  function positionState() {
    const pre: AccountMap = {
      [SIGNER]: systemAccount(SIGNER_LAMPORTS),
      [LENDING_STATE]: programOwnedAccount(LENDING_PROGRAM),
      [DESTINATION_ATA]: tokenAccountFixture({ owner: OTHER_WALLET, amount: 0n }),
      [LENDING_PROGRAM]: programAccount(),
      [TOKEN_PROGRAM]: programAccount(),
    };
    const post: AccountMap = {
      ...pre,
      [DESTINATION_ATA]: tokenAccountFixture({ owner: OTHER_WALLET, amount: 500n * USDC }),
    };
    return { pre, post };
  }

  function lendingCall(): Instruction {
    return {
      programAddress: LENDING_PROGRAM,
      accounts: [
        { address: LENDING_STATE, role: 1 },
        { address: DESTINATION_ATA, role: 1 },
        { address: SIGNER, role: 3 },
      ],
      data: new Uint8Array([7, 0, 0, 0]),
    } as unknown as Instruction;
  }

  it('reports the writable accounts it could not attribute instead of calling the call empty', async () => {
    const result = await verify({
      envelope: envelopeOf(wireOf([lendingCall()])),
      rpc: fakeRpc(positionState()),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // Nothing leaves the wallet the verifier can see...
    expect(result.facts.deltas).toEqual([]);
    // ...but the account holding the position is named as beyond the ceiling's
    // reach: it is program-owned, so this diff cannot say what the signer's
    // claim on it is.
    expect(result.facts.unattributed).toContain(LENDING_STATE);
    // The stranger's ATA is NOT, and that is the point. It reads cleanly, it
    // only GAINED, and whatever it gained some delta already describes. Naming
    // it made the notice fire on every real call - a plain transfer's recipient
    // included - which made MCP's default refusal universal and taught its
    // caller to pass `accept_unattributed` without reading.
    expect(result.facts.unattributed).not.toContain(DESTINATION_ATA);
  });

  it('reports a vault handed a standing approval, though its balance never moved', async () => {
    // The shape almost every escrow, vault and lending reserve uses to hold SPL
    // funds for a user: a token account owned by a program. Exempting it on
    // `amount` alone silenced an `Approve(u64::MAX)` to a stranger over the
    // customer's deposit - reached by CPI, so the static gate never sees it,
    // and `grantFrom` only runs for accounts the signer owns. The verifier said
    // `grants: []` and `unattributed: []`, and MCP signs that unattended.
    const vault = (extra: Partial<TokenAccountFields>) =>
      tokenAccountFixture({ owner: OTHER_WALLET, amount: 100_000n * USDC, ...extra });
    const reportsVault = async (
      post: Partial<TokenAccountFields>,
      before: Partial<TokenAccountFields> = {},
    ) => {
      const state = positionState();
      const result = await verify({
        envelope: envelopeOf(wireOf([lendingCall()])),
        rpc: fakeRpc({
          pre: { ...state.pre, [DESTINATION_ATA]: vault(before) },
          post: { ...state.pre, [DESTINATION_ATA]: vault(post) },
        }),
      });
      return result.ok ? result.facts.unattributed : ['refused'];
    };
    // A delegate the call hands out over funds held for the customer. Asserted
    // as two SEPARATE facts: setting both at once made each clause redundant to
    // the other, so the suite could not say which half was load-bearing.
    expect(await reportsVault({ delegate: SIGNER_ATA, delegatedAmount: 2n ** 63n })).toContain(
      DESTINATION_ATA,
    );
    // A raised allowance for the delegate that was already there.
    const standing = { delegate: OTHER_WALLET, delegatedAmount: 1n };
    expect(
      await reportsVault({ delegate: OTHER_WALLET, delegatedAmount: 2n ** 63n }, standing),
    ).toContain(DESTINATION_ATA);
    // A different delegate at the same allowance.
    expect(await reportsVault({ delegate: SIGNER_ATA, delegatedAmount: 1n }, standing)).toContain(
      DESTINATION_ATA,
    );
    // A close authority a stranger now holds over it.
    expect(await reportsVault({ closeAuthority: SIGNER_ATA })).toContain(DESTINATION_ATA);
    // Frozen by the call: the balance is intact and unusable.
    expect(await reportsVault({ state: 2 })).toContain(DESTINATION_ATA);
  });

  it('reports a vault whose confidential half the call could move', async () => {
    // `amount` is only the PUBLIC half. A `ConfidentialTransfer` out of a vault
    // holding the customer's deposit moves nothing any of the compared fields
    // can see. The signer's own account is refused outright for exactly this;
    // a vault was silently exempt.
    const state = positionState();
    const held = { owner: OTHER_WALLET, amount: 100_000n * USDC, accountType: 2 };
    const result = await verify({
      envelope: envelopeOf(wireOf([lendingCall()])),
      rpc: fakeRpc({
        pre: { ...state.pre, [DESTINATION_ATA]: tokenAccountFixture(held) },
        post: {
          ...state.pre,
          [DESTINATION_ATA]: tokenAccountFixture({
            ...held,
            extensions: [{ type: 5, length: 0 }],
          }),
        },
      }),
    });
    expect(result.ok && result.facts.unattributed).toContain(DESTINATION_ATA);
  });

  it('stops the extension walk at the terminator instead of reading past it', async () => {
    // Token-2022 ends its TLV list with a type-0 entry; the bytes after it are
    // whatever the account was allocated with, and reading them as more entries
    // invents extensions the account does not carry. Here the padding would
    // read as a confidential balance, which turns a vault that plainly only
    // gained into an unattributed account - a warning that has to stay rare.
    const state = positionState();
    const held = { owner: OTHER_WALLET, amount: 100_000n * USDC, accountType: 2 };
    const result = await verify({
      envelope: envelopeOf(wireOf([lendingCall()])),
      rpc: fakeRpc({
        pre: { ...state.pre, [DESTINATION_ATA]: tokenAccountFixture(held) },
        post: {
          ...state.pre,
          [DESTINATION_ATA]: tokenAccountFixture({
            ...held,
            extensions: [
              { type: 0, length: 0 },
              { type: 5, length: 0 },
            ],
          }),
        },
      }),
    });
    expect(result.ok && result.facts.unattributed).not.toContain(DESTINATION_ATA);
  });

  it('reports a token-program account too short to hold the layout', async () => {
    // Anyone may `CreateAccount` at 164 bytes owned by a token program: the
    // program refuses to unpack it, but it sits on chain looking like an
    // account whose fields all read fine until `close_authority`, which runs
    // off the end. Decoding it would exempt it as a vault that merely gained.
    //
    // Owned by TOKEN-2022 on purpose. The classic program's exact-length rule
    // already refuses anything but 165 bytes, so a classic fixture would pass
    // with the length guard deleted and prove nothing about it; Token-2022 has
    // no such rule, because its accounts legitimately vary in length.
    const state = positionState();
    // Copied into a buffer of its own: base64-encoding a `subarray` of kit's
    // own buffer emits the byte past its end, so the fixture would arrive 165
    // bytes long and decode after all - a shape this test is not about.
    const stuntedBytes = new Uint8Array(164);
    stuntedBytes.set(
      getBase64Encoder()
        .encode(tokenAccount({ owner: OTHER_WALLET, amount: 100_000n * USDC }))
        .subarray(0, 164),
    );
    const stunted: RawAccountFixture = {
      lamports: 2_039_280n,
      owner: TOKEN_2022_PROGRAM,
      data: [getBase64Decoder().decode(stuntedBytes), 'base64'],
      space: 164,
    };
    const result = await verify({
      envelope: envelopeOf(wireOf([lendingCall()])),
      rpc: fakeRpc({
        pre: { ...state.pre, [DESTINATION_ATA]: stunted },
        post: { ...state.pre, [DESTINATION_ATA]: stunted },
      }),
    });
    expect(result.ok && result.facts.unattributed).toContain(DESTINATION_ATA);
  });

  it('reports an account that existed as something ELSE before the call', async () => {
    // The obligation record itself, zeroed and reassigned into the token
    // program in one call. `preToken === null` because it did not decode as a
    // token account - not because there was nothing there.
    const state = positionState();
    const result = await verify({
      envelope: envelopeOf(wireOf([lendingCall()])),
      rpc: fakeRpc({
        pre: {
          ...state.pre,
          [DESTINATION_ATA]: programOwnedAccount(LENDING_PROGRAM, 10_000_000n),
        },
        post: {
          ...state.pre,
          [DESTINATION_ATA]: tokenAccountFixture({ owner: OTHER_WALLET, amount: 0n }, 10_000_000n),
        },
      }),
    });
    expect(result.ok && result.facts.unattributed).toContain(DESTINATION_ATA);
  });

  it('reports a vault whose OWNER the call reassigned', async () => {
    // `SetAuthority(AccountOwner)` by CPI from an allowlisted program, signing
    // with its PDA. Permanent, total control - strictly more than the approval
    // this arm was tightened for - and every field the comparison looks at is
    // unchanged. The static gate sees no CPI, and the owner-change refusal only
    // runs for accounts that were ALREADY the signer's.
    const state = positionState();
    const held = { amount: 100_000n * USDC };
    const result = await verify({
      envelope: envelopeOf(wireOf([lendingCall()])),
      rpc: fakeRpc({
        pre: {
          ...state.pre,
          [DESTINATION_ATA]: tokenAccountFixture({ owner: OTHER_WALLET, ...held }),
        },
        post: {
          ...state.pre,
          [DESTINATION_ATA]: tokenAccountFixture({ owner: SIGNER_ATA, ...held }),
        },
      }),
    });
    expect(result.ok && result.facts.unattributed).toContain(DESTINATION_ATA);
  });

  it('reports a vault closed and re-created under a different mint', async () => {
    // `amount` compared across a mint change is two different assets. The
    // signer's own booking refuses to do that a few lines up; this arm was
    // doing it for everyone else's accounts.
    const state = positionState();
    const result = await verify({
      envelope: envelopeOf(wireOf([lendingCall()])),
      rpc: fakeRpc({
        pre: {
          ...state.pre,
          [DESTINATION_ATA]: tokenAccountFixture({
            owner: OTHER_WALLET,
            mint: USDC_MINT,
            amount: 100_000n * USDC,
          }),
        },
        post: {
          ...state.pre,
          [DESTINATION_ATA]: tokenAccountFixture({
            owner: OTHER_WALLET,
            mint: OTHER_MINT,
            amount: 200_000n * USDC,
          }),
        },
      }),
    });
    expect(result.ok && result.facts.unattributed).toContain(DESTINATION_ATA);
  });

  it('reports a vault whose rent walked out, though its balance never moved', async () => {
    const state = positionState();
    const result = await verify({
      envelope: envelopeOf(wireOf([lendingCall()])),
      rpc: fakeRpc({
        pre: {
          ...state.pre,
          [DESTINATION_ATA]: tokenAccountFixture(
            { owner: OTHER_WALLET, amount: 100_000n * USDC },
            5_000_000_000n,
          ),
        },
        post: {
          ...state.pre,
          [DESTINATION_ATA]: tokenAccountFixture(
            { owner: OTHER_WALLET, amount: 100_000n * USDC },
            2_039_280n,
          ),
        },
      }),
    });
    expect(result.ok && result.facts.unattributed).toContain(DESTINATION_ATA);
  });

  it('reports an account the call CREATES already carrying a delegate', async () => {
    // A pre-state that is not a token account leaves every `preToken` field
    // undefined, so a created account has to arrive clean to stay silent.
    const state = positionState();
    const result = await verify({
      envelope: envelopeOf(wireOf([lendingCall()])),
      rpc: fakeRpc({
        pre: { ...state.pre, [DESTINATION_ATA]: null },
        post: {
          ...state.pre,
          [DESTINATION_ATA]: tokenAccountFixture({
            owner: OTHER_WALLET,
            amount: 500n * USDC,
            delegate: SIGNER_ATA,
            delegatedAmount: 500n * USDC,
          }),
        },
      }),
    });
    expect(result.ok && result.facts.unattributed).toContain(DESTINATION_ATA);
  });

  it('refuses when the signer’s own account hides half its balance', async () => {
    // Token-2022's confidential-transfer extension makes `amount` only the
    // PUBLIC half. The owner can move the hidden half into it, which reads here
    // as an inflow from nowhere - enough to net a real outflow from another
    // account to zero and have the client report that nothing moves.
    const state = transferState(380n * USDC);
    await expectRefusal('post-state-unavailable', {
      rpc: fakeRpc({
        pre: state.pre,
        post: {
          ...state.post,
          [SIGNER_ATA]: tokenAccountFixture({
            amount: 380n * USDC,
            accountType: 2,
            // TransferFeeAmount (type 2) carries an 8-byte payload, so the
            // walk has to step over a real entry to reach the confidential
            // one. Type 5 is ConfidentialTransferAccount; its length is given
            // as 0 rather than its true 295 because the buffer here is 200
            // bytes and the walk returns on the type match without reading a
            // payload - a 295-byte claim inside a 200-byte account is a shape
            // no node produces.
            extensions: [
              { type: 2, length: 8 },
              { type: 5, length: 0 },
            ],
          }),
        },
      }),
    });
  });

  it('accepts the Token-2022 extension nearly every real account carries', async () => {
    // ImmutableOwner is on 1,248 of 1,407 sampled live Token-2022 accounts.
    // Refusing those would refuse most of Token-2022, after payment.
    const state = transferState(380n * USDC);
    const result = await verify({
      rpc: fakeRpc({
        pre: state.pre,
        post: {
          ...state.post,
          [SIGNER_ATA]: tokenAccountFixture({
            amount: 380n * USDC,
            accountType: 2,
            extensions: [{ type: 7, length: 0 }],
          }),
        },
      }),
    });
    expect(result.ok).toBe(true);
  });

  it('still reports a readable account that LOST value', async () => {
    // The other direction, and the one worth a warning: value left an account
    // this diff cannot vouch for. Nothing in `deltas` describes it, because the
    // account is nobody's that the verifier can establish.
    const state = positionState();
    const result = await verify({
      envelope: envelopeOf(wireOf([lendingCall()])),
      rpc: fakeRpc({
        pre: {
          ...state.pre,
          [DESTINATION_ATA]: tokenAccountFixture({ owner: OTHER_WALLET, amount: 500n * USDC }),
        },
        post: {
          ...state.pre,
          [DESTINATION_ATA]: tokenAccountFixture({ owner: OTHER_WALLET, amount: 0n }),
        },
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.facts.unattributed).toContain(DESTINATION_ATA);
  });

  it('does not report programs or read-only accounts as unattributed', async () => {
    const result = await verify();
    expect(result.ok && result.facts.unattributed).not.toContain(TOKEN_PROGRAM);
  });
});

describe('verifyOnchainCall - programs reached inside a CPI', () => {
  it('refuses a program the card never published, even when only a CPI reached it', async () => {
    const state = transferState(380n * USDC);
    await expectRefusal('program-not-on-card', {
      rpc: fakeRpc({ ...state, innerProgramIds: [OTHER_WALLET] }),
    });
  });

  it('allows the plumbing every SPL flow goes through without listing it', async () => {
    const state = transferState(380n * USDC);
    const result = await verify({
      rpc: fakeRpc({
        ...state,
        innerProgramIds: [SYSTEM_PROGRAM, 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'],
      }),
    });
    expect(result.ok).toBe(true);
  });
});

// --- the two ceilings ----------------------------------------------------

describe('verifyOnchainCall - spend ceiling', () => {
  it('refuses an outflow one subunit over the ceiling', async () => {
    const state = transferState(500n * USDC - (500n * USDC + 1n));
    const pre = { ...state.pre, [SIGNER_ATA]: tokenAccountFixture({ amount: 500n * USDC + 1n }) };
    const post = { ...state.post, [SIGNER_ATA]: tokenAccountFixture({ amount: 0n }) };
    await expectRefusal('spend-ceiling-exceeded', { rpc: fakeRpc({ pre, post }) });
  });

  it('refuses an outflow of an asset the capability never published', async () => {
    const pre: AccountMap = {
      [SIGNER]: systemAccount(SIGNER_LAMPORTS),
      [SIGNER_ATA]: tokenAccountFixture({ mint: OTHER_MINT, amount: 10n * USDC }),
      [DESTINATION_ATA]: tokenAccountFixture({ owner: OTHER_WALLET, amount: 0n }),
      [TOKEN_PROGRAM]: programAccount(),
    };
    const post: AccountMap = {
      ...pre,
      [SIGNER_ATA]: tokenAccountFixture({ mint: OTHER_MINT, amount: 0n }),
    };
    await expectRefusal('unexpected-asset-outflow', { rpc: fakeRpc({ pre, post }) });
  });

  it('refuses when fee plus rent exceeds the incidental allowance', async () => {
    const state = transferState(380n * USDC);
    const post: AccountMap = {
      ...state.post,
      [SIGNER]: systemAccount(SIGNER_LAMPORTS - 50_000_000n),
    };
    await expectRefusal('fee-ceiling-exceeded', { rpc: fakeRpc({ pre: state.pre, post }) });
  });

  it('counts SOL against the spend ceiling for a SOL-denominated capability', async () => {
    const card = descriptor({
      token: 'sol',
      mint: undefined,
      decimals: 9,
      symbol: 'SOL',
      programs: [SYSTEM_PROGRAM],
      max_per_call_subunits: '1000',
    });
    const instruction = getTransferSolInstruction({
      source: SIGNER as never,
      destination: OTHER_WALLET,
      amount: 5_000n,
    }) as Instruction;
    const pre: AccountMap = {
      [SIGNER]: systemAccount(SIGNER_LAMPORTS),
      [OTHER_WALLET]: systemAccount(0n),
      [SYSTEM_PROGRAM]: programAccount(),
    };
    const post: AccountMap = { ...pre, [SIGNER]: systemAccount(SIGNER_LAMPORTS - 5_000n) };
    await expectRefusal('spend-ceiling-exceeded', {
      card,
      envelope: envelopeOf(wireOf([instruction])),
      rpc: fakeRpc({ pre, post }),
    });
  });
});

describe('verifyOnchainCall - authority ceiling', () => {
  const approveCard = descriptor({
    kind: 'approve',
    grants_authority: true,
    max_authority_subunits: String(50n * USDC),
  });

  function approveState(delegatedAmount: bigint, delegate = OTHER_WALLET) {
    const pre: AccountMap = {
      [SIGNER]: systemAccount(SIGNER_LAMPORTS),
      [SIGNER_ATA]: tokenAccountFixture({ amount: 500n * USDC }),
      [OTHER_WALLET]: systemAccount(1n),
      [TOKEN_PROGRAM]: programAccount(),
    };
    const post: AccountMap = {
      ...pre,
      [SIGNER_ATA]: tokenAccountFixture({ amount: 500n * USDC, delegate, delegatedAmount }),
    };
    return { pre, post };
  }

  it('accepts a declared approval inside the authority ceiling', async () => {
    const result = await verify({
      card: approveCard,
      envelope: envelopeOf(wireOf([usdcApprove(OTHER_WALLET, 25n * USDC)])),
      rpc: fakeRpc(approveState(25n * USDC)),
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.facts.grants).toEqual([
      {
        account: SIGNER_ATA,
        delegate: OTHER_WALLET,
        mint: USDC_MINT,
        subunits: 25n * USDC,
      },
    ]);
  });

  it('refuses an approval above the authority ceiling', async () => {
    await expectRefusal('authority-ceiling-exceeded', {
      card: approveCard,
      envelope: envelopeOf(wireOf([usdcApprove(OTHER_WALLET, 500n * USDC)])),
      rpc: fakeRpc(approveState(500n * USDC)),
    });
  });

  it('refuses a delegate that appears through CPI with no value moving at all', async () => {
    // The call looks like an ordinary transfer of zero and moves nothing; the
    // approval only exists in the post-state. This is the case static decoding
    // cannot see and the whole reason the post-state assertion exists.
    await expectRefusal('authority-grant-not-declared', {
      envelope: envelopeOf(wireOf([usdcTransfer(0n)])),
      rpc: fakeRpc(approveState(500n * USDC)),
    });
  });
});

describe('verifyOnchainCall - authority changes are never signed', () => {
  it('refuses a token account whose owner changed', async () => {
    const state = transferState(380n * USDC);
    const post: AccountMap = {
      ...state.post,
      [SIGNER_ATA]: tokenAccountFixture({ owner: OTHER_WALLET, amount: 500n * USDC }),
    };
    await expectRefusal('account-authority-changed', { rpc: fakeRpc({ pre: state.pre, post }) });
  });

  it('refuses a close authority handed to someone else', async () => {
    const state = transferState(380n * USDC);
    const post: AccountMap = {
      ...state.post,
      [SIGNER_ATA]: tokenAccountFixture({ amount: 380n * USDC, closeAuthority: OTHER_WALLET }),
    };
    await expectRefusal('account-authority-changed', { rpc: fakeRpc({ pre: state.pre, post }) });
  });

  it('refuses a wallet account reassigned to another program', async () => {
    const state = transferState(380n * USDC);
    const post: AccountMap = {
      ...state.post,
      [SIGNER]: { lamports: SIGNER_LAMPORTS, owner: LENDING_PROGRAM, data: ['', 'base64'] },
    };
    await expectRefusal('account-authority-changed', { rpc: fakeRpc({ pre: state.pre, post }) });
  });

  it('counts the rent of a closed token account as SOL leaving, not as nothing', async () => {
    // CloseAccount to a stranger moves no token amount - the balance is zero
    // by the time it closes - but it walks off with the account's lamports.
    const state = transferState(500n * USDC);
    const post: AccountMap = { ...state.post, [SIGNER_ATA]: null };
    const pre: AccountMap = { ...state.pre, [SIGNER_ATA]: tokenAccountFixture({ amount: 0n }) };
    await expectRefusal('fee-ceiling-exceeded', {
      rpc: fakeRpc({ pre, post }),
      ceilings: { incidentalLamports: 1_000n },
    });
  });

  it('refuses when the pre-state read comes back short - an unread account is not an empty one', async () => {
    const state = transferState(380n * USDC);
    await expectRefusal('post-state-unavailable', {
      rpc: fakeRpc({ ...state, truncatePreState: true }),
    });
  });

  it('counts a closed token account as its full balance leaving', async () => {
    const state = transferState(380n * USDC);
    const post: AccountMap = { ...state.post, [SIGNER_ATA]: null };
    await expectRefusal('spend-ceiling-exceeded', {
      rpc: fakeRpc({ pre: state.pre, post }),
      ceilings: { spendSubunits: 10n * USDC },
    });
  });
});

// --- what the ceilings must not be talked out of --------------------------

describe('verifyOnchainCall - value the diff must not net away', () => {
  it('counts rent parked in an account the call CREATES for the signer as SOL leaving', async () => {
    // The account is correctly owned by the customer, so nothing is stolen and
    // nothing is unattributed - which is exactly why netting its lamports
    // against the wallet they came from would report "nothing moves" for half a
    // SOL walking out of a liquid balance. Rent scales with the space the call
    // chooses, so the bound has to see it.
    const rent = 500_000_000n;
    const pre: AccountMap = {
      [SIGNER]: systemAccount(SIGNER_LAMPORTS),
      [SIGNER_ATA]: tokenAccountFixture({ amount: 500n * USDC }),
      [DESTINATION_ATA]: null,
      [TOKEN_PROGRAM]: programAccount(),
    };
    const post: AccountMap = {
      [SIGNER]: systemAccount(SIGNER_LAMPORTS - rent),
      [SIGNER_ATA]: tokenAccountFixture({ amount: 380n * USDC }),
      [DESTINATION_ATA]: tokenAccountFixture({ owner: SIGNER, amount: 120n * USDC }, rent),
      [TOKEN_PROGRAM]: programAccount(),
    };
    await expectRefusal('fee-ceiling-exceeded', { rpc: fakeRpc({ pre, post }) });
  });

  it('still nets a token account that was ALREADY the signer’s, so closing one into the wallet is free', async () => {
    // The case the netting exists for: the account existed and was ours, its
    // rent lands back in our wallet, and nothing has left.
    const rent = 2_039_280n;
    const pre: AccountMap = {
      [SIGNER]: systemAccount(SIGNER_LAMPORTS),
      [SIGNER_ATA]: tokenAccountFixture({ amount: 0n }, rent),
      [DESTINATION_ATA]: tokenAccountFixture({ owner: OTHER_WALLET, amount: 0n }),
      [TOKEN_PROGRAM]: programAccount(),
    };
    const post: AccountMap = {
      [SIGNER]: systemAccount(SIGNER_LAMPORTS + rent),
      [SIGNER_ATA]: null,
      [DESTINATION_ATA]: tokenAccountFixture({ owner: OTHER_WALLET, amount: 0n }),
      [TOKEN_PROGRAM]: programAccount(),
    };
    const result = await verify({
      envelope: envelopeOf(wireOf([usdcTransfer(0n)])),
      rpc: fakeRpc({ pre, post }),
    });
    expect(result.ok).toBe(true);
  });

  it('refuses a call that leaves one of the signer’s token accounts frozen', async () => {
    const state = transferState(380n * USDC);
    const post: AccountMap = {
      ...state.post,
      [SIGNER_ATA]: tokenAccountFixture({ amount: 380n * USDC, state: 2 }),
    };
    await expectRefusal('account-authority-changed', { rpc: fakeRpc({ pre: state.pre, post }) });
  });
});

// --- an RPC that answers half the question is not an answer ---------------

describe('verifyOnchainCall - simulation fields the bound depends on', () => {
  it('refuses when the RPC does not report the programs reached inside a CPI', async () => {
    // Fail-open here would void the card's program allowlist entirely: every
    // inner program would read as "there were none".
    const state = transferState(380n * USDC);
    await expectRefusal('post-state-unavailable', {
      rpc: fakeRpc({ ...state, withoutInnerInstructions: true }),
    });
  });

  it('refuses when the RPC does not report the compute the call needs', async () => {
    const state = transferState(380n * USDC);
    await expectRefusal('post-state-unavailable', {
      rpc: fakeRpc({ ...state, withoutUnitsConsumed: true }),
    });
  });

  it('refuses when the signer’s token account cannot be decoded BEFORE the call', async () => {
    // An unreadable pre-state would read as a zero balance and turn an outflow
    // into an inflow - the one direction this diff must never fail in.
    const state = transferState(380n * USDC);
    const pre: AccountMap = {
      ...state.pre,
      // `space` MUST be set, or `readPreState`'s own missing-space guard fires
      // first - with the same reason - and this rule is never reached at all.
      [SIGNER_ATA]: {
        lamports: 2_039_280n,
        owner: TOKEN_PROGRAM,
        data: ['AAAA', 'base64'],
        space: 165,
      },
    };
    await expectRefusal('post-state-unavailable', { rpc: fakeRpc({ pre, post: state.post }) });
  });
});

// --- static shapes that never reach a simulation --------------------------

describe('verifyOnchainCall - static refusals with a reason a human can act on', () => {
  it('refuses more instructions than it will check', async () => {
    const noop = (): Instruction =>
      ({
        programAddress: TOKEN_PROGRAM,
        accounts: [],
        data: new Uint8Array([0]),
      }) as unknown as Instruction;
    const many = Array.from({ length: 33 }, noop);
    await expectRefusal('too-many-instructions', { envelope: envelopeOf(wireOf(many)) });
  });

  it('refuses an SPL SetAuthority outright, whatever the card declares', async () => {
    const setAuthority = getSetAuthorityInstruction({
      owned: SIGNER_ATA,
      owner: SIGNER,
      authorityType: AuthorityType.AccountOwner,
      newAuthority: OTHER_WALLET,
    }) as Instruction;
    await expectRefusal('account-authority-changed', {
      card: descriptor({ grants_authority: true, max_authority_subunits: String(10n * USDC) }),
      envelope: envelopeOf(wireOf([setAuthority])),
    });
  });

  it('refuses a System Assign that hands one of the signer’s accounts to another program', async () => {
    const assign = getAssignInstruction({
      account: createNoopSigner(SIGNER),
      programAddress: LENDING_PROGRAM,
    }) as Instruction;
    await expectRefusal('account-authority-changed', {
      card: descriptor({ programs: [TOKEN_PROGRAM, SYSTEM_PROGRAM] }),
      envelope: envelopeOf(wireOf([assign])),
    });
  });
});

// --- ceilings a caller supplies -------------------------------------------

describe('verifyOnchainCall - client ceiling overrides', () => {
  it('reads a negative override as nothing left, never as the published ceiling', async () => {
    // The refusal alone proves nothing - a `-1n` ceiling refuses exactly what
    // `0n` refuses. What the clamp changes is the number both clients then
    // RENDER as the limit that was applied.
    const refused = await expectRefusal('spend-ceiling-exceeded', {
      ceilings: { spendSubunits: -1n },
    });
    const clamped = await verify({
      ceilings: { spendSubunits: -1n },
      envelope: envelopeOf(wireOf([usdcTransfer(0n)])),
      rpc: fakeRpc(transferState(500n * USDC)),
    });
    expect(refused.ok).toBe(false);
    expect(clamped.ok && clamped.ceilings.spendSubunits).toBe(0n);
  });

  it('clamps an incidental allowance above the hard maximum', async () => {
    const result = await verify({ ceilings: { incidentalLamports: 10n ** 12n } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ceilings.incidentalLamports).toBe(MAX_INCIDENTAL_LAMPORTS);
    }
  });
});

// --- the transaction that is diffed is the transaction that is signed --------

describe('verifyOnchainCall - the authoritative simulation', () => {
  it('reads the account diff from a run of the EXACT bytes it hands back to sign', async () => {
    // A program can read its own remaining compute and branch on it, so a run
    // that lacks the budget instructions is a run of a different call. The
    // sizing pass may lack them; the pass whose post-state feeds the ceilings
    // may not.
    const record: string[] = [];
    const state = transferState(380n * USDC);
    const result = await verify({ rpc: fakeRpc({ ...state, record }) });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(record.length).toBe(2);
    expect(record[1]).toBe(result.transaction);
    // The sizing pass runs under the CEILING, so a heavy routed call is not
    // mistaken for a failing one; the signed transaction is then fitted to what
    // that run actually consumed.
    expect(computeUnitLimitOf(record[0] ?? '')).toBe(1_400_000);
    const fitted = computeUnitLimitOf(result.transaction);
    expect(fitted).toBeGreaterThan(0);
    expect(fitted).toBeLessThan(1_400_000);
  });

  it('refuses when the RPC names inner programs by index instead of by address', async () => {
    // The `json` encoding a node falls back to. Reading those entries as "no
    // inner programs" would empty the list the card's allowlist is checked
    // against - the allowlist would then permit anything.
    const state = transferState(380n * USDC);
    await expectRefusal('post-state-unavailable', {
      rpc: fakeRpc({ ...state, innerProgramIndexes: [7] }),
    });
  });

  it('refuses when the pre-state read does not say how large the accounts are', async () => {
    const state = transferState(380n * USDC);
    await expectRefusal('post-state-unavailable', {
      rpc: fakeRpc({ ...state, withoutSpace: true }),
    });
  });

  it('refuses when the chain moved between reading the accounts and simulating', async () => {
    // A balance that ARRIVES in the gap is absent from the pre-state and spent
    // in the post-state, and the outflow nets to zero.
    const state = transferState(380n * USDC);
    await expectRefusal('post-state-unavailable', {
      rpc: fakeRpc({ ...state, simulationSlot: 5_000n }),
    });
  });

  it('refuses a call whose accounts hold more bytes than it will read', async () => {
    // NOT `too-many-accounts`: this call holds three accounts, far inside
    // Solana's limit, and telling the customer otherwise would send an operator
    // hunting the wrong bound. What failed is that elisym will not read this
    // much state, so the effect cannot be established.
    const state = transferState(380n * USDC);
    const pre: AccountMap = {
      ...state.pre,
      [DESTINATION_ATA]: {
        ...tokenAccountFixture({ owner: OTHER_WALLET, amount: 0n }),
        space: 20_000_000,
      },
    };
    await expectRefusal('post-state-unavailable', { rpc: fakeRpc({ pre, post: state.post }) });
  });
});

// --- address lookup tables --------------------------------------------------

describe('verifyOnchainCall - address lookup tables', () => {
  const TABLE = address('9ivvJXV8Vg5eSMEvNjHnRfLQ2Zpg2sZbKNwXJVGCHNyG');

  function wireWithTable(): string {
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (draft) => setTransactionMessageFeePayer(SIGNER, draft),
      (draft) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: BLOCKHASH as never, lastValidBlockHeight: 1_000n },
          draft,
        ),
      (draft) => appendTransactionMessageInstructions([usdcTransfer(120n * USDC)], draft),
    );
    const compressed = compressTransactionMessageUsingAddressLookupTables(message, {
      [TABLE]: [DESTINATION_ATA],
    });
    return getBase64EncodedWireTransaction(compileTransaction(compressed));
  }

  it('names the table when the BANK will not load it, not the chain', async () => {
    // A table the decoder read fine but the bank refuses - a deactivated or
    // closed one, which a provider caching a stale table produces. Left to the
    // generic catch this read as "the chain could not be reached", transient
    // wording for something only the provider can fix.
    const state = transferState(380n * USDC);
    await expectRefusal('lookup-table-unavailable', {
      envelope: envelopeOf(wireWithTable()),
      rpc: fakeRpc({
        ...state,
        lookupTables: { [TABLE]: [DESTINATION_ATA] },
        // Shaped the way kit really delivers a node's refusal: a `SolanaError`
        // carrying the node's words in `context.__serverMessage`. A plain
        // `Error` whose MESSAGE holds them models only a development build - in
        // a shipped one the message is "Solana error #-32602; Decode this error
        // by running ..." and the words live in the context alone.
        simulateThrow: serverError(
          "invalid transaction: Transaction loads an address table account that doesn't exist",
        ),
      }),
    });
  });

  it('never shows a customer the decode-advice blob, in either build', async () => {
    // The half of the production fix that was missed: only JSON-RPC errors
    // carry `__serverMessage`, so every CODEC, decompile and compile failure
    // fell through to `error.message` - which in a shipped build is exactly the
    // "Solana error #NNNN; Decode this error by running `npx ...`" string this
    // was written to eliminate, quoted into a detail both clients render.
    for (const env of ['production', 'test'] as const) {
      const priorEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = env;
      try {
        const state = transferState(380n * USDC);
        const result = await verify({
          envelope: envelopeOf('AQID'),
          rpc: fakeRpc(state),
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.detail).not.toContain('Decode this error by running');
          // The code and the context still identify it precisely.
          expect(result.detail).toMatch(/Solana error #\d+/);
        }
      } finally {
        if (priorEnv === undefined) {
          delete process.env.NODE_ENV;
        } else {
          process.env.NODE_ENV = priorEnv;
        }
      }
    }
  });

  it('refuses when the table address holds something that is not a table', async () => {
    // The OTHER kit assertion, and the more common one: an address the node
    // returns but cannot `jsonParsed`-decode as a lookup table hits
    // `assertAccountsDecoded`, not `assertAccountsExist`. Only the missing-
    // account arm was pinned, on the very guard whose whole lesson was that
    // this class of gate dies silently in a shipped build.
    const state = transferState(380n * USDC);
    await expectRefusal('lookup-table-unavailable', {
      envelope: envelopeOf(wireWithTable()),
      rpc: fakeRpc({ ...state, accountsThrow: accountsNotDecoded(TABLE) }),
    });
  });

  it('still names the table in a PRODUCTION build, where kit prints no message', async () => {
    // The environment every customer runs and no test ran. `@solana/errors`
    // drops its whole message catalog when `process.env.NODE_ENV` is
    // 'production', so a shipped client sees "Solana error #3230004; Decode
    // this error by running ..." and the address and the node's words survive
    // only in `context`. Two rounds of fixes matched on the message and were
    // dead code in the browser bundle; the suite could not see it because
    // vitest is not a production build.
    //
    // NODE_ENV is set BEFORE the errors are built, which is when kit composes
    // the message.
    const priorEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const missing = accountsNotFound(TABLE);
      const refused = serverError(
        "invalid transaction: Transaction loads an address table account that doesn't exist",
      );
      expect(missing.message).not.toContain(TABLE);
      expect(refused.message).not.toContain('address table account');
      const state = transferState(380n * USDC);
      await expectRefusal('lookup-table-unavailable', {
        envelope: envelopeOf(wireWithTable()),
        rpc: fakeRpc({ ...state, accountsThrow: missing }),
      });
      await expectRefusal('lookup-table-unavailable', {
        envelope: envelopeOf(wireWithTable()),
        rpc: fakeRpc({
          ...state,
          lookupTables: { [TABLE]: [DESTINATION_ATA] },
          simulateThrow: refused,
        }),
      });
    } finally {
      if (priorEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = priorEnv;
      }
    }
  });

  it('refuses when a table the call depends on cannot be read - never a partial account list', async () => {
    // A table that will not resolve means the full account list is unknown, and
    // an unknown account is one the diff would silently not look at.
    const state = transferState(380n * USDC);
    await expectRefusal('lookup-table-unavailable', {
      envelope: envelopeOf(wireWithTable()),
      // A REAL kit error, raised by kit's own assertion rather than hand-built.
      // Three earlier fixtures here modelled strings nothing emits ("table
      // fetch refused", then "failed to get address lookup table accounts",
      // then kit's development-mode wording) and each let a gate pass that
      // could never fire in production: `@solana/errors` compiles its message
      // catalog out of every non-development build, so the message a shipped
      // client sees is "Solana error #3230004; Decode this error by running
      // ...". Only the code and the context survive, and only a real error
      // carries them.
      rpc: fakeRpc({
        ...state,
        accountsThrow: accountsNotFound(TABLE),
      }),
    });
  });

  it('does not blame the table for a rate limit', async () => {
    // "Part of this call's account list could not be read" is permanent and
    // provider-blaming. A 429 is neither, and a retry fixes it.
    const state = transferState(380n * USDC);
    await expectRefusal('rpc-unavailable', {
      envelope: envelopeOf(wireWithTable()),
      rpc: fakeRpc({ ...state, accountsThrow: new Error('HTTP error (429): Too Many Requests') }),
    });
  });
});

// --- Token-2022 accounts, which are longer than the base layout -------------

describe('verifyOnchainCall - Token-2022 post-state', () => {
  it('reads an extended account tagged as an Account', async () => {
    const state = transferState(380n * USDC);
    const post: AccountMap = {
      ...state.post,
      [SIGNER_ATA]: tokenAccountFixture({ amount: 380n * USDC, accountType: 2 }),
    };
    const result = await verify({ rpc: fakeRpc({ pre: state.pre, post }) });
    expect(result.ok).toBe(true);
  });

  it('refuses an extended account tagged as anything else - a mint is not an account', async () => {
    // Without the tag check the padded body of a Mint decodes as a garbage
    // "uninitialized account", which would read as a zero balance.
    const state = transferState(380n * USDC);
    const post: AccountMap = {
      ...state.post,
      [SIGNER_ATA]: tokenAccountFixture({ amount: 380n * USDC, accountType: 1 }),
    };
    await expectRefusal('post-state-unavailable', { rpc: fakeRpc({ pre: state.pre, post }) });
  });
});

describe('verifyOnchainCall - an approval on the wrong asset', () => {
  it('refuses a delegate left on a token the capability never published', async () => {
    // The card declares an approve ceiling in USDC; this call quietly leaves a
    // delegate over a DIFFERENT token the signer holds. No value moves, so only
    // the grant check can catch it.
    const approveCard = descriptor({
      grants_authority: true,
      max_authority_subunits: String(500n * USDC),
    });
    const pre: AccountMap = {
      [SIGNER]: systemAccount(SIGNER_LAMPORTS),
      [SIGNER_ATA]: tokenAccountFixture({ amount: 500n * USDC }),
      [DESTINATION_ATA]: tokenAccountFixture({ mint: OTHER_MINT, owner: SIGNER, amount: 42n }),
      [TOKEN_PROGRAM]: programAccount(),
    };
    const post: AccountMap = {
      ...pre,
      [SIGNER_ATA]: tokenAccountFixture({ amount: 500n * USDC }),
      [DESTINATION_ATA]: tokenAccountFixture({
        mint: OTHER_MINT,
        owner: SIGNER,
        amount: 42n,
        delegate: OTHER_WALLET,
        delegatedAmount: 42n,
      }),
    };
    await expectRefusal('authority-grant-not-declared', {
      card: approveCard,
      envelope: envelopeOf(wireOf([usdcTransfer(0n)])),
      rpc: fakeRpc({ pre, post }),
    });
  });
});

// --- an inflow only offsets an outflow if the signer can get it back ---------

describe('verifyOnchainCall - lamports parked where the signer cannot reach them', () => {
  const SOL_CARD = () =>
    descriptor({
      token: 'sol',
      mint: undefined,
      decimals: 9,
      symbol: 'SOL',
      max_per_call_subunits: '0',
      programs: [TOKEN_PROGRAM, SYSTEM_PROGRAM],
    });

  function solTransfer(lamports: bigint): Instruction {
    return getTransferSolInstruction({
      source: createNoopSigner(SIGNER),
      destination: DESTINATION_ATA,
      amount: lamports,
    }) as Instruction;
  }

  it('refuses a call that hides an outflow inside a forged SPL Multisig', async () => {
    // A multisig's body is caller-chosen, so its first 165 bytes can be ground
    // to read as a token account "owned by" the victim. A multisig can never be
    // closed, so the lamports are destroyed - and netting them would report
    // "nothing moves" for a card whose spend ceiling is zero.
    const moved = 5_000_000_000n;
    const pre: AccountMap = {
      [SIGNER]: systemAccount(SIGNER_LAMPORTS),
      [DESTINATION_ATA]: forgedMultisigFixture(0n),
      [SYSTEM_PROGRAM]: programAccount(),
    };
    const post: AccountMap = {
      [SIGNER]: systemAccount(SIGNER_LAMPORTS - moved),
      [DESTINATION_ATA]: forgedMultisigFixture(moved),
      [SYSTEM_PROGRAM]: programAccount(),
    };
    await expectRefusal('spend-ceiling-exceeded', {
      card: SOL_CARD(),
      envelope: envelopeOf(wireOf([solTransfer(moved)])),
      rpc: fakeRpc({ pre, post }),
    });
  });

  it('refuses a call that parks the wallet balance in an already-frozen account', async () => {
    // A provider can airdrop its own token and freeze the account, both
    // unilaterally. `assertNotNewlyFrozen` does not fire for a PRE-existing
    // freeze, so only the frozen arm of `inflowKept` catches this - and the
    // fixture must claim WRAPPED SOL for that to be the branch that bites. A
    // non-native one is stopped a line earlier by the `isNative` gate, which
    // left the rule this test names covered by nothing.
    const moved = 5_000_000_000n;
    const frozen = (lamports: bigint) =>
      tokenAccountFixture(
        { mint: OTHER_MINT, owner: SIGNER, amount: 1n, isNative: true, state: 2 },
        lamports,
      );
    const pre: AccountMap = {
      [SIGNER]: systemAccount(SIGNER_LAMPORTS),
      [DESTINATION_ATA]: frozen(2_039_280n),
      [SYSTEM_PROGRAM]: programAccount(),
    };
    const post: AccountMap = {
      [SIGNER]: systemAccount(SIGNER_LAMPORTS - moved),
      [DESTINATION_ATA]: frozen(2_039_280n + moved),
      [SYSTEM_PROGRAM]: programAccount(),
    };
    await expectRefusal('spend-ceiling-exceeded', {
      card: SOL_CARD(),
      envelope: envelopeOf(wireOf([solTransfer(moved)])),
      rpc: fakeRpc({ pre, post }),
    });
  });

  it('still nets an inflow into the signer’s own wrapped-SOL account', async () => {
    const moved = 1_000_000n;
    // Wrapped SOL: the native mint has no freeze authority, so lamports here
    // really are still the signer's.
    const ours = (lamports: bigint) =>
      tokenAccountFixture(
        { mint: OTHER_MINT, owner: SIGNER, amount: 1n, isNative: true },
        lamports,
      );
    const pre: AccountMap = {
      [SIGNER]: systemAccount(SIGNER_LAMPORTS),
      [DESTINATION_ATA]: ours(2_039_280n),
      [SYSTEM_PROGRAM]: programAccount(),
    };
    const post: AccountMap = {
      [SIGNER]: systemAccount(SIGNER_LAMPORTS - moved),
      [DESTINATION_ATA]: ours(2_039_280n + moved),
      [SYSTEM_PROGRAM]: programAccount(),
    };
    const result = await verify({
      card: SOL_CARD(),
      envelope: envelopeOf(wireOf([solTransfer(moved)])),
      rpc: fakeRpc({ pre, post }),
    });
    expect(result.ok).toBe(true);
  });

  it('does not report a WRAP as receiving a token on top of the lamports', async () => {
    // The mirror of the unwrap below, and the side nothing covered. A wSOL
    // balance IS the lamports the account holds, so booking the post side's
    // `amount` as a separate mint would report the same value twice - the
    // customer told they both spent 1 SOL and received 1 SOL of some mint.
    const wrapped = 1_000_000_000n;
    const rent = 2_039_280n;
    const result = await verify({
      card: { ...SOL_CARD(), max_per_call_subunits: '2000000000' },
      envelope: envelopeOf(wireOf([solTransfer(wrapped)])),
      rpc: fakeRpc({
        pre: {
          [SIGNER]: systemAccount(SIGNER_LAMPORTS),
          [DESTINATION_ATA]: null,
          [SYSTEM_PROGRAM]: programAccount(),
        },
        post: {
          [SIGNER]: systemAccount(SIGNER_LAMPORTS - rent - wrapped),
          [DESTINATION_ATA]: tokenAccountFixture(
            { mint: OTHER_MINT, owner: SIGNER, amount: wrapped, isNative: true },
            rent + wrapped,
          ),
          [SYSTEM_PROGRAM]: programAccount(),
        },
      }),
    });
    expect(result.ok).toBe(true);
    // Native only. Not one entry carrying a mint.
    expect(result.ok && result.facts.deltas.every((delta) => delta.mint === undefined)).toBe(true);
  });

  it('does not report the wallet a plain SOL transfer paid', async () => {
    // A capability whose whole job is "send N SOL to X" was otherwise refused
    // by default in MCP, after payment, naming the destination the customer
    // chose. The recipient is system-owned, carries no data and only gained.
    const moved = 1_000_000_000n;
    const result = await verify({
      card: { ...SOL_CARD(), max_per_call_subunits: '2000000000' },
      envelope: envelopeOf(wireOf([solTransfer(moved)])),
      rpc: fakeRpc({
        pre: {
          [SIGNER]: systemAccount(SIGNER_LAMPORTS),
          [DESTINATION_ATA]: systemAccount(890_880n),
          [SYSTEM_PROGRAM]: programAccount(),
        },
        post: {
          [SIGNER]: systemAccount(SIGNER_LAMPORTS - moved),
          [DESTINATION_ATA]: systemAccount(890_880n + moved),
          [SYSTEM_PROGRAM]: programAccount(),
        },
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.facts.unattributed).toEqual([]);
  });

  it('still reports a wallet the call DRAINED', async () => {
    // A program's system-owned SOL vault, emptied by `invoke_signed`. The
    // exemption is for a wallet that only gained; nothing else about a bare
    // wallet is readable, so a fall is the one thing it can report.
    const moved = 1_000_000_000n;
    const result = await verify({
      card: { ...SOL_CARD(), max_per_call_subunits: '2000000000' },
      envelope: envelopeOf(wireOf([solTransfer(moved)])),
      rpc: fakeRpc({
        pre: {
          [SIGNER]: systemAccount(SIGNER_LAMPORTS),
          [DESTINATION_ATA]: systemAccount(5_000_000_000n),
          [SYSTEM_PROGRAM]: programAccount(),
        },
        post: {
          [SIGNER]: systemAccount(SIGNER_LAMPORTS - moved),
          [DESTINATION_ATA]: systemAccount(1n),
          [SYSTEM_PROGRAM]: programAccount(),
        },
      }),
    });
    expect(result.ok && result.facts.unattributed).toContain(DESTINATION_ATA);
  });

  it('still reports a system account carrying DATA, which a nonce does', async () => {
    // A durable nonce account is system-owned too, and a call can seize its
    // authority. Only a BARE wallet is self-evident.
    const moved = 1_000_000_000n;
    // 80 bytes, which is what a `dataSlice{0,165}` on an 80-byte nonce account
    // actually returns - the old fixture said 4, a length no node produces.
    const withData: RawAccountFixture = {
      lamports: 890_880n + moved,
      owner: SYSTEM_PROGRAM,
      data: [getBase64Decoder().decode(new Uint8Array(80)), 'base64'],
      space: 80,
    };
    const result = await verify({
      card: { ...SOL_CARD(), max_per_call_subunits: '2000000000' },
      envelope: envelopeOf(wireOf([solTransfer(moved)])),
      rpc: fakeRpc({
        pre: {
          [SIGNER]: systemAccount(SIGNER_LAMPORTS),
          [DESTINATION_ATA]: { ...withData, lamports: 890_880n },
          [SYSTEM_PROGRAM]: programAccount(),
        },
        post: {
          [SIGNER]: systemAccount(SIGNER_LAMPORTS - moved),
          [DESTINATION_ATA]: withData,
          [SYSTEM_PROGRAM]: programAccount(),
        },
      }),
    });
    expect(result.ok && result.facts.unattributed).toContain(DESTINATION_ATA);
  });

  it('counts the signatures a precompile declares, which the runtime charges for', async () => {
    // An attestation-gated claim carries an Ed25519 instruction, and the
    // runtime bills every signature it declares. Missing them left the
    // difference in the native delta, where a SOL-priced card charges it to the
    // SPEND ceiling - so a `max_per_call: "0"` capability of this shape refused
    // every call it ever returned, after the customer had paid.
    const ED25519 = 'Ed25519SigVerify111111111111111111111111111';
    const attestation = {
      programAddress: address(ED25519),
      accounts: [],
      // First byte is the signature count the runtime charges for, and that is
      // all this pins. A real node would reject THIS payload - two signatures
      // declared with no offset structure behind them - so the shape here
      // stands in for a well-formed instruction rather than modelling one.
      // The arithmetic was checked against live mainnet separately: a valid
      // Ed25519 instruction declaring 1, 5 and 20 signatures is charged
      // 10,000 / 30,000 / 105,000 lamports, exactly `5000 x (1 + declared)`.
      data: new Uint8Array([2, 0, 0, 0]),
    } as unknown as Instruction;
    const card = {
      ...SOL_CARD(),
      max_per_call_subunits: '0',
      programs: [...SOL_CARD().programs, ED25519],
    };
    const result = await verify({
      card,
      envelope: envelopeOf(wireOf([attestation, usdcTransfer(0n)])),
      rpc: fakeRpc({
        pre: {
          [SIGNER]: systemAccount(SIGNER_LAMPORTS),
          [SIGNER_ATA]: tokenAccountFixture({ amount: 500n * USDC }),
          [DESTINATION_ATA]: tokenAccountFixture({ owner: SIGNER, amount: 0n }),
          [TOKEN_PROGRAM]: programAccount(),
          [ED25519]: programAccount(),
        } as AccountMap,
        post: {
          [SIGNER]: systemAccount(SIGNER_LAMPORTS),
          [SIGNER_ATA]: tokenAccountFixture({ amount: 500n * USDC }),
          [DESTINATION_ATA]: tokenAccountFixture({ owner: SIGNER, amount: 0n }),
          [TOKEN_PROGRAM]: programAccount(),
          [ED25519]: programAccount(),
        } as AccountMap,
      }),
    });
    expect(result.ok).toBe(true);
    // Three signatures charged: the customer's own plus the two declared.
    expect(result.ok && result.facts.feeLamports >= 15_000n).toBe(true);
    expect(result.ok && result.facts.deltas).toEqual([]);
  });

  it('lets a zero-ceiling SOL capability through, since the fee is not what it moves', async () => {
    // `max_per_call: "0"` is documented as legitimate - claiming rewards,
    // closing a position back into the same account - and means "this call
    // moves nothing of yours". The simulation still debits the fee payer, so
    // the observed lamport delta is negative by the fee alone. Counting that
    // against the SPEND ceiling refused every call such a capability could
    // ever return, after the customer had paid for it.
    const result = await verify({
      card: { ...SOL_CARD(), max_per_call_subunits: '0' },
      envelope: envelopeOf(wireOf([usdcTransfer(0n)])),
      rpc: fakeRpc({
        pre: {
          [SIGNER]: systemAccount(SIGNER_LAMPORTS),
          [SIGNER_ATA]: tokenAccountFixture({ amount: 500n * USDC }),
          [DESTINATION_ATA]: tokenAccountFixture({ owner: SIGNER, amount: 0n }),
          [TOKEN_PROGRAM]: programAccount(),
        } as AccountMap,
        post: {
          [SIGNER]: systemAccount(SIGNER_LAMPORTS),
          [SIGNER_ATA]: tokenAccountFixture({ amount: 500n * USDC }),
          [DESTINATION_ATA]: tokenAccountFixture({ owner: SIGNER, amount: 0n }),
          [TOKEN_PROGRAM]: programAccount(),
        } as AccountMap,
      }),
    });
    expect(result.ok).toBe(true);
    // The fee is reported, and it is NOT among the things the call moves.
    expect(result.ok && result.facts.feeLamports > 0n).toBe(true);
    expect(result.ok && result.facts.deltas).toEqual([]);
  });

  it('refuses a wallet drained into a wrapped-SOL account the call CREATES', async () => {
    // The asymmetry the lamport branch turns on. Lamports arriving in an
    // account that was ALREADY the signer's may offset the wallet they came
    // from; lamports arriving in one the call creates may not, or a capability
    // with a zero ceiling could move the whole balance into a fresh account of
    // its choosing and report that nothing happened.
    const moved = 1_000_000_000n;
    await expectRefusal('spend-ceiling-exceeded', {
      card: { ...SOL_CARD(), max_per_call_subunits: '0' },
      envelope: envelopeOf(wireOf([solTransfer(moved)])),
      rpc: fakeRpc({
        pre: {
          [SIGNER]: systemAccount(SIGNER_LAMPORTS),
          [DESTINATION_ATA]: null,
          [SYSTEM_PROGRAM]: programAccount(),
        },
        post: {
          [SIGNER]: systemAccount(SIGNER_LAMPORTS - moved),
          [DESTINATION_ATA]: tokenAccountFixture(
            { mint: OTHER_MINT, owner: SIGNER, amount: 1n, isNative: true },
            moved,
          ),
          [SYSTEM_PROGRAM]: programAccount(),
        },
      }),
    });
  });

  it('refuses when the signer’s own account comes back in an unknown state', async () => {
    // An unrecognised state byte is one of the two rules that stop a forged
    // buffer decoding as the signer's account. Reading it as `initialized`
    // would credit an inflow into something nobody can show is a token account.
    const moved = 1_000_000n;
    const ours = (lamports: bigint, state?: number) =>
      tokenAccountFixture(
        {
          mint: OTHER_MINT,
          owner: SIGNER,
          amount: 1n,
          isNative: true,
          ...(state ? { state } : {}),
        },
        lamports,
      );
    await expectRefusal('post-state-unavailable', {
      card: SOL_CARD(),
      envelope: envelopeOf(wireOf([solTransfer(moved)])),
      rpc: fakeRpc({
        pre: {
          [SIGNER]: systemAccount(SIGNER_LAMPORTS),
          [DESTINATION_ATA]: ours(2_039_280n),
          [SYSTEM_PROGRAM]: programAccount(),
        },
        post: {
          [SIGNER]: systemAccount(SIGNER_LAMPORTS - moved),
          [DESTINATION_ATA]: ours(2_039_280n + moved, 3),
          [SYSTEM_PROGRAM]: programAccount(),
        },
      }),
    });
  });

  it('nets nothing into a wrapped-SOL account a stranger may close', async () => {
    // The asymmetry a close authority turns on. It cannot reach a non-native
    // BALANCE, because the token program refuses to close over one - but a
    // native account may be closed while it still holds a balance, since that
    // is exactly what an unwrap is. So these lamports are the stranger's to
    // take, and none of them offsets the wallet they came from.
    const moved = 1_000_000n;
    const theirs = (lamports: bigint) =>
      tokenAccountFixture(
        {
          mint: OTHER_MINT,
          owner: SIGNER,
          amount: 1n,
          isNative: true,
          closeAuthority: OTHER_WALLET,
        },
        lamports,
      );
    const pre: AccountMap = {
      [SIGNER]: systemAccount(SIGNER_LAMPORTS),
      [DESTINATION_ATA]: theirs(2_039_280n),
      [SYSTEM_PROGRAM]: programAccount(),
    };
    const post: AccountMap = {
      [SIGNER]: systemAccount(SIGNER_LAMPORTS - moved),
      [DESTINATION_ATA]: theirs(2_039_280n + moved),
      [SYSTEM_PROGRAM]: programAccount(),
    };
    await expectRefusal('spend-ceiling-exceeded', {
      card: SOL_CARD(),
      envelope: envelopeOf(wireOf([solTransfer(moved)])),
      rpc: fakeRpc({ pre, post }),
    });
  });
});

describe('verifyOnchainCall - what the client adds between the two passes', () => {
  it('adds exactly the bytes the size check predicts before the probe is sent', async () => {
    // The size refusal is raised from a PREDICTION - probe + 12 - so that an
    // over-limit call gets a size reason instead of an RPC error. That number
    // is arithmetic about kit's encoding, not a measurement, and nothing else
    // in the suite would notice it drifting.
    const record: string[] = [];
    const state = transferState(380n * USDC);
    const result = await verify({ rpc: fakeRpc({ ...state, record }) });
    expect(result.ok).toBe(true);
    const probeBytes = new Uint8Array(getBase64Encoder().encode(record[0] ?? '')).length;
    const finalBytes = new Uint8Array(getBase64Encoder().encode(record[1] ?? '')).length;
    // Both halves: that kit's encoding really adds this much, and that the
    // constant the prediction is built from says the same thing.
    expect(finalBytes - probeBytes).toBe(12);
    expect(PRICE_INSTRUCTION_BYTES).toBe(finalBytes - probeBytes);
  });

  it('strips a ComputeBudget instruction carrying no data at all', async () => {
    // Undecodable to the runtime, so it fails the whole transaction on send -
    // after the customer has signed. It is not one of the two that ask for
    // room, so the safe reading of an empty payload is "strip it".
    const record: string[] = [];
    const state = transferState(380n * USDC);
    const result = await verify({
      envelope: envelopeOf(
        wireOf([
          {
            programAddress: address(COMPUTE_BUDGET),
            accounts: [],
            data: new Uint8Array([]),
          } as unknown as Instruction,
          usdcTransfer(120n * USDC),
        ]),
      ),
      rpc: fakeRpc({ ...state, record }),
    });
    expect(result.ok).toBe(true);
    // The transfer plus the client's own limit and price - the empty one gone.
    expect(instructionCountOf(record[1] ?? '')).toBe(3);
  });
});

describe('the incidental allowance and what it has to cover', () => {
  it('leaves room for a real position open at the worst fee the client can bid', () => {
    // Both figures are measured, not assumed. Rent: a Drift first deposit
    // creates User (4376 B) and UserStats (240 B), which mainnet's rent rate
    // makes 30,854,376 lamports. Fee: the client's own bid is capped by
    // construction at MAX_COMPUTE_UNIT_LIMIT x PRIORITY_FEE_CEILING plus the
    // signature. A customer meeting this sum has already paid for the job, and
    // neither shipped client exposes the allowance to lift - so tightening it
    // below their total turns a normal DeFi call into a dead end.
    const DRIFT_FIRST_DEPOSIT_RENT = 30_854_376n;
    // The client's own bid, plus the signatures a precompile can declare. The
    // largest well-formed precompile instruction that still fits a 1232-byte
    // transaction carrying the client's two budget instructions declares 65,
    // measured at 330,200 lamports of runtime fee.
    const MAX_CLIENT_FEE = 7_005_000n + 65n * 5_000n;
    expect(DEFAULT_INCIDENTAL_LAMPORTS).toBeGreaterThanOrEqual(
      DRIFT_FIRST_DEPOSIT_RENT + MAX_CLIENT_FEE,
    );
    expect(DEFAULT_INCIDENTAL_LAMPORTS).toBeLessThanOrEqual(MAX_INCIDENTAL_LAMPORTS);
  });
});

describe('verifyOnchainCall - what reaches the unattributed list', () => {
  it('does not report a read-only account the call cannot write to', async () => {
    // Over-reporting here is not cosmetic: MCP refuses a call with anything
    // unattributed by default, so naming an account the transaction can only
    // READ would refuse a legitimate call after the customer had paid.
    const READ_ONLY = address('7cVfgArCheMR6Cs4t6vz5rfnqd56vZq4ndaBrY5xkxXy');
    const state = transferState(380n * USDC);
    const result = await verify({
      envelope: envelopeOf(
        wireOf([
          {
            programAddress: TOKEN_PROGRAM,
            // role 0 is READONLY: named by the call, never written by it.
            accounts: [{ address: READ_ONLY, role: 0 }],
            data: new Uint8Array([9]),
          } as unknown as Instruction,
          usdcTransfer(120n * USDC),
        ]),
      ),
      rpc: fakeRpc({
        pre: { ...state.pre, [READ_ONLY]: programOwnedAccount(LENDING_PROGRAM, 5_000_000n) },
        post: { ...state.post, [READ_ONLY]: programOwnedAccount(LENDING_PROGRAM, 9_000_000n) },
      }),
    });
    expect(result.ok).toBe(true);
    // Only the READ-ONLY account is asserted on. The transfer's destination is
    // a stranger's, but it only GAINED, so `isSelfEvident` silences it and
    // `unattributed` is empty here - an earlier comment claimed it was reported,
    // which was never true of this fixture. The claim under test is narrower and
    // still load-bearing: dropping the `writable.has(address)` gate makes this
    // read-only account appear.
    expect(result.ok && result.facts.unattributed).not.toContain(READ_ONLY);
  });
});

describe('verifyOnchainCall - the fee against the incidental allowance', () => {
  it('trips the allowance on the fee alone, with no rent in play', async () => {
    // The only thing in that bucket for a SOL-priced card, and the reason the
    // bucket exists for a token-priced one. Every other test that reaches this
    // refusal moves rent as well, so the fee's own path was covered by nothing.
    const state = transferState(380n * USDC);
    await expectRefusal('fee-ceiling-exceeded', {
      ceilings: { incidentalLamports: 1n },
      rpc: fakeRpc(state),
    });
  });
});

describe('verifyOnchainCall - a rebuild Solana would not accept', () => {
  it('accepts a program carried as a writable meta, which the runtime demotes', async () => {
    // Solana accepts this every block: `LoadedMessage::is_writable` calls
    // `demote_program_id` and downgrades the account. Kit's compiler refuses to
    // BUILD it, so the rebuild threw and the customer was told - after paying -
    // that Solana would not take a shape it takes routinely. Measured at 24 of 3,273
    // successful mainnet transactions, and for a capability wrapping FLASHX it
    // is every call (142 of 142 sampled).
    const state = transferState(380n * USDC);
    const result = await verify({
      envelope: envelopeOf(withWritableProgram(wireOf([usdcTransfer(120n * USDC)]))),
      rpc: fakeRpc(state),
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.facts.deltas).toEqual([{ mint: USDC_MINT, subunits: -120n * USDC }]);
  });
});

describe('verifyOnchainCall - a post-state read the diff cannot trust', () => {
  it('refuses a simulation answered at an older slot than the pre-state', async () => {
    // `minContextSlot` is supposed to make this impossible, so reaching it
    // means a node that ignores it. A post-state from an OLDER bank turns a
    // withdrawal that happened between the two reads into an apparent inflow,
    // which is the one direction this diff must never fail in.
    const state = transferState(380n * USDC);
    await expectRefusal('post-state-unavailable', {
      rpc: fakeRpc({ ...state, simulationSlot: 999n }),
    });
  });
});

describe('verifyOnchainCall - a call that does nothing at all', () => {
  it('refuses an empty instruction list rather than calling it a delivered call', async () => {
    // Everything honest the verifier says about this helps sell it: no value
    // moves, no program is named, nothing is unattributed. Both clients would
    // present it as delivered, and an MCP agent signs with no human in the
    // loop. The customer pays the job price plus the fee for nothing.
    await expectRefusal('malformed-instruction', { envelope: envelopeOf(wireOf([])) });
  });

  it('refuses a call carrying nothing but a compute budget', async () => {
    // One instruction, so a bare length check passes - but the client strips
    // the pricing ones and appends its own, leaving a transaction that acts on
    // nothing. The customer pays the job price and the fee for that.
    await expectRefusal('malformed-instruction', {
      envelope: envelopeOf(
        wireOf([
          {
            programAddress: address(COMPUTE_BUDGET),
            accounts: [],
            data: new Uint8Array([2, 0, 0, 4, 0]),
          } as unknown as Instruction,
        ]),
      ),
    });
  });
});

describe('verifyOnchainCall - a message that decodes but does not resolve', () => {
  it('refuses an instruction indexing an account the message does not carry', async () => {
    // Kit resolves this to `accounts: [undefined]` rather than throwing, and
    // the first read of `account.role` downstream is a bare `TypeError` - which
    // the verifier could only report as "the chain could not be reached", a
    // transient message for a permanently broken call.
    await expectRefusal('undecodable-transaction', {
      envelope: envelopeOf(withStrayAccountIndex(wireOf([usdcTransfer(120n * USDC)]))),
    });
  });
});

describe('verifyOnchainCall - transactions that could never land', () => {
  it('refuses a call that only fits before the client adds its own budget', async () => {
    // The client strips the provider's ComputeBudget instructions and appends
    // its own, which costs 52 bytes (20 for the pair, 32 for the program's
    // account slot). A call sized against the raw transport limit is refused
    // here rather than after the customer has signed it - and before the
    // sizing probe is sent, since a node rejects an oversized simulate payload
    // with an error the verifier could only report as `rpc-unavailable`.
    // Discriminator 200: not one of the SPL shapes the static gate refuses, so
    // the size check is what this case actually reaches.
    const filler = (): Instruction =>
      ({
        programAddress: TOKEN_PROGRAM,
        accounts: [],
        data: new Uint8Array(40).fill(200),
      }) as unknown as Instruction;
    // 1200 bytes: inside Solana's 1232 limit and inside the envelope's base64
    // cap, but past it once the client's 52 bytes of budget are added.
    const fat = Array.from({ length: 24 }, filler);
    await expectRefusal('oversized-transaction', { envelope: envelopeOf(wireOf(fat)) });
  });
});

describe('verifyOnchainCall - an inflow the mint’s issuer can freeze later', () => {
  it('refuses lamports parked in the signer’s account for someone else’s mint', async () => {
    // A provider can airdrop one token of its own mint to make an account the
    // signer's, have the paid call park the wallet's balance there as excess
    // lamports, and freeze it AFTER this call lands. "Not frozen at simulation
    // time" is not "the signer can get it back".
    const moved = 1_900_000_000n;
    const theirMint = (lamports: bigint) =>
      tokenAccountFixture({ mint: USDC_MINT, owner: SIGNER, amount: 1n }, lamports);
    const pre: AccountMap = {
      [SIGNER]: systemAccount(SIGNER_LAMPORTS),
      [DESTINATION_ATA]: theirMint(2_039_280n),
      [SYSTEM_PROGRAM]: programAccount(),
    };
    const post: AccountMap = {
      [SIGNER]: systemAccount(SIGNER_LAMPORTS - moved),
      [DESTINATION_ATA]: theirMint(2_039_280n + moved),
      [SYSTEM_PROGRAM]: programAccount(),
    };
    await expectRefusal('spend-ceiling-exceeded', {
      card: descriptor({
        token: 'sol',
        mint: undefined,
        decimals: 9,
        symbol: 'SOL',
        max_per_call_subunits: '0',
        programs: [TOKEN_PROGRAM, SYSTEM_PROGRAM],
      }),
      envelope: envelopeOf(
        wireOf([
          getTransferSolInstruction({
            source: createNoopSigner(SIGNER),
            destination: DESTINATION_ATA,
            amount: moved,
          }) as Instruction,
        ]),
      ),
      rpc: fakeRpc({ pre, post }),
    });
  });

  it('lets the signer close their own wrapped-SOL account back into their wallet', async () => {
    // Unwrapping moves no asset the card never published: a wSOL balance IS
    // lamports, so reporting it as a separate mint outflow would refuse an
    // honest unwrap.
    const wrapped = 1_000_000_000n;
    const rent = 2_039_280n;
    const pre: AccountMap = {
      [SIGNER]: systemAccount(SIGNER_LAMPORTS),
      [SIGNER_ATA]: tokenAccountFixture(
        { mint: OTHER_MINT, owner: SIGNER, amount: wrapped, isNative: true },
        rent + wrapped,
      ),
      [TOKEN_PROGRAM]: programAccount(),
    };
    const post: AccountMap = {
      [SIGNER]: systemAccount(SIGNER_LAMPORTS + rent + wrapped),
      [SIGNER_ATA]: null,
      [TOKEN_PROGRAM]: programAccount(),
    };
    const result = await verify({
      envelope: envelopeOf(wireOf([usdcTransfer(0n)])),
      rpc: fakeRpc({ pre, post }),
    });
    expect(result.ok).toBe(true);
  });
});

describe('verifyOnchainCall - buffers the classic token program could not hold', () => {
  it('refuses a classic-owned account that is not exactly 165 bytes', async () => {
    // `spl_token::state::Account::LEN` is 165 exactly. Anything else owned by
    // that program is a mint or a multisig wearing an account's first bytes.
    const state = transferState(380n * USDC);
    const post: AccountMap = {
      ...state.post,
      [SIGNER_ATA]: {
        ...tokenAccountFixture({ amount: 380n * USDC }),
        owner: TOKEN_PROGRAM,
        space: 200,
      },
    };
    await expectRefusal('post-state-unavailable', { rpc: fakeRpc({ pre: state.pre, post }) });
  });
});

describe('verifyOnchainCall - the other half of each static authority rule', () => {
  it('refuses an ApproveChecked the capability never declared', async () => {
    const approveChecked = getApproveCheckedInstruction({
      source: SIGNER_ATA,
      mint: USDC_MINT,
      delegate: OTHER_WALLET,
      owner: SIGNER,
      amount: 5n * USDC,
      decimals: 6,
    }) as Instruction;
    await expectRefusal('authority-grant-not-declared', {
      envelope: envelopeOf(wireOf([approveChecked])),
    });
  });

  it('refuses a System AssignWithSeed just as it refuses a plain Assign', async () => {
    const assign = getAssignWithSeedInstruction({
      account: DESTINATION_ATA,
      baseAccount: createNoopSigner(SIGNER),
      base: SIGNER,
      seed: 'seed',
      programAddress: LENDING_PROGRAM,
    }) as Instruction;
    await expectRefusal('account-authority-changed', {
      card: descriptor({ programs: [TOKEN_PROGRAM, SYSTEM_PROGRAM] }),
      envelope: envelopeOf(wireOf([assign])),
    });
  });
});

// --- what a standing authority on the DESTINATION actually endangers --------

describe('verifyOnchainCall - a destination that already carries an allowance', () => {
  const MOVED = 400n * USDC;
  const TIGHT = { spendSubunits: 100n * USDC };

  function ownAccounts(destination: TokenAccountFields) {
    return {
      pre: {
        [SIGNER]: systemAccount(SIGNER_LAMPORTS),
        [SIGNER_ATA]: tokenAccountFixture({ amount: 500n * USDC }),
        [DESTINATION_ATA]: tokenAccountFixture({ owner: SIGNER, amount: 0n, ...destination }),
        [TOKEN_PROGRAM]: programAccount(),
      } as AccountMap,
      post: {
        [SIGNER]: systemAccount(SIGNER_LAMPORTS),
        [SIGNER_ATA]: tokenAccountFixture({ amount: 500n * USDC - MOVED }),
        [DESTINATION_ATA]: tokenAccountFixture({ owner: SIGNER, amount: MOVED, ...destination }),
        [TOKEN_PROGRAM]: programAccount(),
      } as AccountMap,
    };
  }

  async function move(destination: TokenAccountFields) {
    return verify({
      ceilings: TIGHT,
      envelope: envelopeOf(wireOf([usdcTransfer(MOVED)])),
      rpc: fakeRpc(ownAccounts(destination)),
    });
  }

  it('charges a standing delegate at what it may take, not at the whole transfer', async () => {
    // Moving 400 USDC between two accounts the signer owns is not a 400 USDC
    // outflow because the destination carries a 10 USDC allowance - and any
    // prior `approve`, elisym's own delegated execution included, leaves that
    // state behind. Voiding the whole inflow refused this after payment.
    const result = await move({ delegate: OTHER_WALLET, delegatedAmount: 10n * USDC });
    expect(result.ok).toBe(true);
    expect(result.ok && result.facts.deltas).toEqual([{ mint: USDC_MINT, subunits: -10n * USDC }]);
  });

  it('still refuses when the allowance covers everything the call moves', async () => {
    // The bound the measurement must not weaken: an allowance at or above what
    // arrives leaves the signer nothing, so none of it is credited.
    const result = await move({ delegate: OTHER_WALLET, delegatedAmount: 500n * USDC });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('spend-ceiling-exceeded');
  });

  it('ignores a close authority that cannot reach a non-native balance', async () => {
    // `CloseAccount` refuses an account that still holds a non-native balance,
    // so a foreign close authority can take the rent and never these tokens.
    const result = await move({ closeAuthority: OTHER_WALLET });
    expect(result.ok).toBe(true);
    expect(result.ok && result.facts.deltas).toEqual([]);
  });

  it('charges nothing when the allowance could already reach that far', async () => {
    // The destination already holds more than the allowance, so the delegate
    // could take its 10 USDC before this call and can take exactly 10 after
    // it. The call adds no reach, and `grantFrom` reports no grant for the
    // same pre-existing state - so booking an outflow here contradicted it.
    const held = 100n * USDC;
    const carries = { delegate: OTHER_WALLET, delegatedAmount: 10n * USDC };
    const result = await verify({
      ceilings: TIGHT,
      envelope: envelopeOf(wireOf([usdcTransfer(MOVED)])),
      rpc: fakeRpc({
        pre: {
          [SIGNER]: systemAccount(SIGNER_LAMPORTS),
          [SIGNER_ATA]: tokenAccountFixture({ amount: 500n * USDC }),
          [DESTINATION_ATA]: tokenAccountFixture({ owner: SIGNER, amount: held, ...carries }),
          [TOKEN_PROGRAM]: programAccount(),
        } as AccountMap,
        post: {
          [SIGNER]: systemAccount(SIGNER_LAMPORTS),
          [SIGNER_ATA]: tokenAccountFixture({ amount: 500n * USDC - MOVED }),
          [DESTINATION_ATA]: tokenAccountFixture({
            owner: SIGNER,
            amount: held + MOVED,
            ...carries,
          }),
          [TOKEN_PROGRAM]: programAccount(),
        } as AccountMap,
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.facts.deltas).toEqual([]);
  });

  it('reports an allowance the call WIDENS, however much was standing before', async () => {
    // The clause the credit above leans on. `inflowKept` discounts only the
    // reach the call ADDS, which is sound precisely because `grantFrom` charges
    // the full new allowance to the authority ceiling whenever the delegate is
    // new or widened. Drop the widening test there and this call is credited
    // for value a 500 USDC allowance can take, with no grant reported at all.
    const held = 100n * USDC;
    const before = { delegate: OTHER_WALLET, delegatedAmount: 10n * USDC };
    const after = { delegate: OTHER_WALLET, delegatedAmount: 500n * USDC };
    await expectRefusal('authority-grant-not-declared', {
      envelope: envelopeOf(wireOf([usdcTransfer(MOVED)])),
      rpc: fakeRpc({
        pre: {
          [SIGNER]: systemAccount(SIGNER_LAMPORTS),
          [SIGNER_ATA]: tokenAccountFixture({ amount: 500n * USDC }),
          [DESTINATION_ATA]: tokenAccountFixture({ owner: SIGNER, amount: held, ...before }),
          [TOKEN_PROGRAM]: programAccount(),
        } as AccountMap,
        post: {
          [SIGNER]: systemAccount(SIGNER_LAMPORTS),
          [SIGNER_ATA]: tokenAccountFixture({ amount: 500n * USDC - MOVED }),
          [DESTINATION_ATA]: tokenAccountFixture({
            owner: SIGNER,
            amount: held + MOVED,
            ...after,
          }),
          [TOKEN_PROGRAM]: programAccount(),
        } as AccountMap,
      }),
    });
  });

  it('does not call the signer approving THEMSELVES an undeclared grant', async () => {
    // `inflowKept` already reads a self-delegate as no exposure - they could
    // move their own balance anyway. `grantFrom` reporting it as a grant made
    // the two disagree, and a card without `grants_authority` refused a call
    // that hands nobody anything.
    const result = await verify({
      envelope: envelopeOf(wireOf([usdcTransfer(0n)])),
      rpc: fakeRpc({
        pre: {
          [SIGNER]: systemAccount(SIGNER_LAMPORTS),
          [SIGNER_ATA]: tokenAccountFixture({ amount: 500n * USDC }),
          [DESTINATION_ATA]: tokenAccountFixture({ owner: SIGNER, amount: 0n }),
          [TOKEN_PROGRAM]: programAccount(),
        } as AccountMap,
        post: {
          [SIGNER]: systemAccount(SIGNER_LAMPORTS),
          [SIGNER_ATA]: tokenAccountFixture({
            amount: 500n * USDC,
            delegate: SIGNER,
            delegatedAmount: 500n * USDC,
          }),
          [DESTINATION_ATA]: tokenAccountFixture({ owner: SIGNER, amount: 0n }),
          [TOKEN_PROGRAM]: programAccount(),
        } as AccountMap,
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.facts.grants).toEqual([]);
  });

  it('leaves the signer’s own allowance alone', async () => {
    const result = await move({ delegate: SIGNER, delegatedAmount: 500n * USDC });
    expect(result.ok).toBe(true);
    expect(result.ok && result.facts.deltas).toEqual([]);
  });
});

// --- value handed to the signer is not value the signer kept ----------------

describe('verifyOnchainCall - an account the call hands over', () => {
  const HANDED_OVER = address('7cVfgArCheMR6Cs4t6vz5rfnqd56vZq4ndaBrY5xkxXy');

  function state(options: { delegate?: Address; existedBefore: boolean }) {
    const theirs = (amount: bigint, delegate?: Address) =>
      tokenAccountFixture({
        owner: SIGNER,
        amount,
        ...(delegate ? { delegate, delegatedAmount: 10n ** 18n } : {}),
      });
    return {
      pre: {
        [SIGNER]: systemAccount(SIGNER_LAMPORTS),
        [SIGNER_ATA]: tokenAccountFixture({ amount: 500n * USDC }),
        // Before the call it is NOT the signer's - it belongs to the provider.
        [HANDED_OVER]: options.existedBefore
          ? tokenAccountFixture({ owner: OTHER_WALLET, amount: 500n * USDC })
          : null,
        [TOKEN_PROGRAM]: programAccount(),
      } as AccountMap,
      post: {
        [SIGNER]: systemAccount(SIGNER_LAMPORTS),
        [SIGNER_ATA]: tokenAccountFixture({ amount: 0n }),
        [HANDED_OVER]: theirs(500n * USDC, options.delegate),
        [TOKEN_PROGRAM]: programAccount(),
      } as AccountMap,
    };
  }

  function drain(): string {
    // One instruction naming the accounts; the transfer and the hand-over both
    // happen inside the program, where no static decoder can see them.
    return wireOf([
      {
        programAddress: LENDING_PROGRAM,
        accounts: [
          { address: SIGNER_ATA, role: 1 },
          { address: HANDED_OVER, role: 1 },
          { address: SIGNER, role: 3 },
        ],
        data: new Uint8Array([9]),
      } as unknown as Instruction,
    ]);
  }

  it('does not let a pre-existing account handed to the signer offset the drain that funded it', async () => {
    // The provider owned the account, delegated it to themselves, then handed
    // it over inside the call. Crediting its balance would report a 500 USDC
    // drain as "nothing moves".
    await expectRefusal('spend-ceiling-exceeded', {
      card: descriptor({ max_per_call_subunits: String(10n * USDC) }),
      envelope: envelopeOf(drain()),
      rpc: fakeRpc(state({ existedBefore: true, delegate: OTHER_WALLET })),
    });
  });

  it('does not credit a handed-over account even when it arrives looking clean', async () => {
    // No delegate, no close authority, not frozen - and still not creditable.
    // Whoever owned it may hold a Token-2022 permanent delegate on the mint, or
    // may simply take it back; nothing in the post-state would show either.
    await expectRefusal('spend-ceiling-exceeded', {
      card: descriptor({ max_per_call_subunits: String(10n * USDC) }),
      envelope: envelopeOf(drain()),
      rpc: fakeRpc(state({ existedBefore: true })),
    });
  });

  it('reports the standing delegate on an account this call created for the signer', async () => {
    // No history to hide behind - but the delegate the call left on it is still
    // a grant the card never published, so with the spend inside its ceiling
    // that is the refusal the customer gets.
    await expectRefusal('authority-grant-not-declared', {
      envelope: envelopeOf(drain()),
      rpc: fakeRpc(state({ existedBefore: false, delegate: OTHER_WALLET })),
    });
  });
});

describe('verifyOnchainCall - an inflow a standing delegate can take back', () => {
  it('refuses lamports parked in the signer’s own wSOL account that a stranger may move', async () => {
    const moved = 100_000_000_000n;
    const delegated = (lamports: bigint) =>
      tokenAccountFixture(
        {
          mint: OTHER_MINT,
          owner: SIGNER,
          amount: 1n,
          isNative: true,
          delegate: OTHER_WALLET,
          delegatedAmount: 10n ** 18n,
        },
        lamports,
      );
    const pre: AccountMap = {
      [SIGNER]: systemAccount(SIGNER_LAMPORTS + moved),
      [DESTINATION_ATA]: delegated(2_039_280n),
      [SYSTEM_PROGRAM]: programAccount(),
    };
    const post: AccountMap = {
      [SIGNER]: systemAccount(SIGNER_LAMPORTS),
      [DESTINATION_ATA]: delegated(2_039_280n + moved),
      [SYSTEM_PROGRAM]: programAccount(),
    };
    await expectRefusal('spend-ceiling-exceeded', {
      card: descriptor({
        token: 'sol',
        mint: undefined,
        decimals: 9,
        symbol: 'SOL',
        max_per_call_subunits: '0',
        programs: [TOKEN_PROGRAM, SYSTEM_PROGRAM],
      }),
      envelope: envelopeOf(
        wireOf([
          getTransferSolInstruction({
            source: createNoopSigner(SIGNER),
            destination: DESTINATION_ATA,
            amount: moved,
          }) as Instruction,
        ]),
      ),
      rpc: fakeRpc({ pre, post }),
    });
  });
});

// --- one address, two lives -------------------------------------------------

describe('verifyOnchainCall - an account closed and re-created in the same call', () => {
  const SEEDED = address('BWDsvRLKZVvVfUCewJPCFsvHb8jwx6E8FUcqbxGgTVXG');

  function reborn(options: { asNative: boolean }) {
    return {
      pre: {
        [SIGNER]: systemAccount(SIGNER_LAMPORTS),
        // The signer's own USDC sub-account, with a real balance.
        [SEEDED]: tokenAccountFixture({ owner: SIGNER, amount: 500n * USDC }),
        [DESTINATION_ATA]: tokenAccountFixture({ owner: OTHER_WALLET, amount: 0n }),
        [TOKEN_PROGRAM]: programAccount(),
      } as AccountMap,
      post: {
        [SIGNER]: systemAccount(SIGNER_LAMPORTS),
        // Emptied, closed, and re-made at the same address - as wrapped SOL, or
        // simply for another mint. Either way the USDC is gone.
        [SEEDED]: tokenAccountFixture({
          owner: SIGNER,
          amount: 0n,
          ...(options.asNative ? { mint: OTHER_MINT, isNative: true } : { mint: OTHER_MINT }),
        }),
        [DESTINATION_ATA]: tokenAccountFixture({ owner: OTHER_WALLET, amount: 500n * USDC }),
        [TOKEN_PROGRAM]: programAccount(),
      } as AccountMap,
    };
  }

  /** A Transfer that actually names SEEDED, so the verifier watches it. */
  function drainSeeded(): string {
    return wireOf([
      {
        programAddress: TOKEN_PROGRAM,
        accounts: [
          { address: SEEDED, role: 1 },
          { address: DESTINATION_ATA, role: 1 },
          { address: SIGNER, role: 3 },
        ],
        data: new Uint8Array([3]),
      } as unknown as Instruction,
    ]);
  }

  it('still counts the balance the old account held when it comes back as wrapped SOL', async () => {
    // Deciding native-ness from the post side alone would drop the pre side's
    // 500 USDC entirely and report `deltas: []` for an emptied account.
    await expectRefusal('spend-ceiling-exceeded', {
      card: descriptor({ max_per_call_subunits: '0' }),
      envelope: envelopeOf(drainSeeded()),
      rpc: fakeRpc(reborn({ asNative: true })),
    });
  });

  it('still counts it when it comes back for another mint', async () => {
    await expectRefusal('spend-ceiling-exceeded', {
      card: descriptor({ max_per_call_subunits: '0' }),
      envelope: envelopeOf(drainSeeded()),
      rpc: fakeRpc(reborn({ asNative: false })),
    });
  });

  it('reports a delegate on the new mint rather than excusing it with the old one', async () => {
    // A delegate carried across a mint change is not evidence that the NEW
    // mint's approval was already standing.
    const state = reborn({ asNative: false });
    const post: AccountMap = {
      ...state.post,
      [SEEDED]: tokenAccountFixture({
        owner: SIGNER,
        mint: OTHER_MINT,
        amount: 0n,
        delegate: OTHER_WALLET,
        delegatedAmount: 10n ** 18n,
      }),
    };
    const pre: AccountMap = {
      ...state.pre,
      [SEEDED]: tokenAccountFixture({
        owner: SIGNER,
        amount: 500n * USDC,
        delegate: OTHER_WALLET,
        delegatedAmount: 10n ** 18n,
      }),
    };
    await expectRefusal('authority-grant-not-declared', {
      envelope: envelopeOf(drainSeeded()),
      rpc: fakeRpc({ pre, post }),
    });
  });
});

describe('verifyOnchainCall - an inflow a stranger may close out from under the signer', () => {
  it('refuses lamports parked in a wSOL account whose close authority is not the signer', async () => {
    // A PRE-EXISTING foreign close authority passes `assertCloseAuthorityUnchanged`
    // deliberately, so this branch of the inflow rule is the only thing between
    // that account and a credit.
    const moved = 50_000_000_000n;
    const closable = (lamports: bigint) =>
      tokenAccountFixture(
        {
          mint: OTHER_MINT,
          owner: SIGNER,
          amount: 1n,
          isNative: true,
          closeAuthority: OTHER_WALLET,
        },
        lamports,
      );
    const pre: AccountMap = {
      [SIGNER]: systemAccount(SIGNER_LAMPORTS + moved),
      [DESTINATION_ATA]: closable(2_039_280n),
      [SYSTEM_PROGRAM]: programAccount(),
    };
    const post: AccountMap = {
      [SIGNER]: systemAccount(SIGNER_LAMPORTS),
      [DESTINATION_ATA]: closable(2_039_280n + moved),
      [SYSTEM_PROGRAM]: programAccount(),
    };
    await expectRefusal('spend-ceiling-exceeded', {
      card: descriptor({
        token: 'sol',
        mint: undefined,
        decimals: 9,
        symbol: 'SOL',
        max_per_call_subunits: '0',
        programs: [TOKEN_PROGRAM, SYSTEM_PROGRAM],
      }),
      envelope: envelopeOf(
        wireOf([
          getTransferSolInstruction({
            source: createNoopSigner(SIGNER),
            destination: DESTINATION_ATA,
            amount: moved,
          }) as Instruction,
        ]),
      ),
      rpc: fakeRpc({ pre, post }),
    });
  });
});

// --- the signer's own wallet is an account too -------------------------------

describe('verifyOnchainCall - data allocated on the customer’s wallet', () => {
  it('refuses a call that gives the wallet data, which no delta would ever show', async () => {
    // A system account carrying data can neither pay a fee nor send SOL, so the
    // balance is stranded - and at nonce size the caller can name themselves
    // nonce authority and withdraw it. Lamports do not move, so only the
    // post-state shape catches this.
    const state = transferState(380n * USDC);
    const pre: AccountMap = { ...state.pre, [SIGNER]: systemAccount(SIGNER_LAMPORTS) };
    const post: AccountMap = {
      ...state.post,
      [SIGNER]: { ...systemAccount(SIGNER_LAMPORTS), data: ['AAAA', 'base64'], space: 3 },
    };
    await expectRefusal('account-authority-changed', { rpc: fakeRpc({ pre, post }) });
  });

  it('refuses a top-level System Allocate outright, for a reason a human can act on', async () => {
    const allocate = getAllocateInstruction({
      newAccount: createNoopSigner(SIGNER),
      space: 80n,
    }) as Instruction;
    await expectRefusal('account-authority-changed', {
      card: descriptor({ programs: [TOKEN_PROGRAM, SYSTEM_PROGRAM] }),
      envelope: envelopeOf(wireOf([allocate])),
    });
  });
});

describe('verifyOnchainCall - a card whose own ceilings cannot be read', () => {
  it('names the card rather than blaming the chain', async () => {
    // Only reachable for a hand-built descriptor - every network path goes
    // through `parseOnchainDescriptor` - but "the chain could not be reached"
    // would be the wrong thing to tell anyone.
    const broken = { ...descriptor(), max_per_call_subunits: 'lots' } as OnchainDescriptor;
    await expectRefusal('malformed-card', { card: broken });
  });
});

describe('verifyOnchainCall - a call that resolves its lookup tables', () => {
  const TABLE = address('9ivvJXV8Vg5eSMEvNjHnRfLQ2Zpg2sZbKNwXJVGCHNyG');
  it('accepts a routed-shaped call whose accounts arrive through a table', async () => {
    // The advertised primary case. Nothing else in the suite exercises the
    // resolve path, `compileToWire`'s re-compression, or a diff over
    // lookup-resolved accounts.
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (draft) => setTransactionMessageFeePayer(SIGNER, draft),
      (draft) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: BLOCKHASH as never, lastValidBlockHeight: 1_000n },
          draft,
        ),
      (draft) => appendTransactionMessageInstructions([usdcTransfer(120n * USDC)], draft),
    );
    const tables: Record<string, Address[]> = { [TABLE]: [DESTINATION_ATA] };
    const compressed = compressTransactionMessageUsingAddressLookupTables(message, tables);
    const wire = getBase64EncodedWireTransaction(compileTransaction(compressed));

    const state = transferState(380n * USDC);
    const result = await verify({
      envelope: envelopeOf(wire),
      rpc: fakeRpc({ pre: state.pre, post: state.post, lookupTables: tables }),
    });
    if (!result.ok) {
      throw new Error(`refused: ${result.reason} - ${result.detail}`);
    }
    expect(result.facts.deltas).toEqual([{ mint: USDC_MINT, subunits: -120n * USDC }]);
  });

  it('refuses a call that cannot be rebuilt inside Solana’s account limit', async () => {
    // 62 looked-up accounts + the signer + the token program = 64, and the
    // client's own budget instructions add the ComputeBudget program as a 65th.
    // Kit refuses to compile that, and an unwrapped throw would reach the
    // customer as "the chain could not be reached" - transient wording for a
    // permanent shape only the provider can fix, after they have paid. Note the
    // accounts arrive through a table: 64 static ones could never fit in 1232
    // bytes, which is why this cliff is reachable only by routed traffic.
    const extras = await Promise.all(Array.from({ length: 62 }, () => generateKeyPairSigner()));
    const instruction = {
      programAddress: TOKEN_PROGRAM,
      accounts: extras.map((extra) => ({ address: extra.address, role: 1 })),
      data: new Uint8Array([9]),
    } as unknown as Instruction;
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (draft) => setTransactionMessageFeePayer(SIGNER, draft),
      (draft) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: BLOCKHASH as never, lastValidBlockHeight: 1_000n },
          draft,
        ),
      (draft) => appendTransactionMessageInstructions([instruction], draft),
    );
    const tables: Record<string, Address[]> = { [TABLE]: extras.map((extra) => extra.address) };
    const compressed = compressTransactionMessageUsingAddressLookupTables(message, tables);
    const wire = getBase64EncodedWireTransaction(compileTransaction(compressed));

    const state = transferState(380n * USDC);
    await expectRefusal('too-many-accounts', {
      envelope: envelopeOf(wire),
      rpc: fakeRpc({ pre: state.pre, post: state.post, lookupTables: tables }),
    });
  });

  it('does not blame the tables for a decompile failure that is not about them', async () => {
    // A stray PROGRAM index in a call that also carries a healthy table. The
    // catch used to relabel every decompile failure as
    // `lookup-table-unavailable` whenever tables were present, sending the
    // operator hunting a table that resolved perfectly - while the identical
    // call WITHOUT a table reported the truth. Only two kit errors are really
    // about a table's contents.
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (draft) => setTransactionMessageFeePayer(SIGNER, draft),
      (draft) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: BLOCKHASH as never, lastValidBlockHeight: 1_000n },
          draft,
        ),
      (draft) => appendTransactionMessageInstructions([usdcTransfer(120n * USDC)], draft),
    );
    const tables: Record<string, Address[]> = { [TABLE]: [DESTINATION_ATA] };
    const compressed = compressTransactionMessageUsingAddressLookupTables(message, tables);
    const wire = getBase64EncodedWireTransaction(compileTransaction(compressed));
    const state = transferState(380n * USDC);
    await expectRefusal('undecodable-transaction', {
      envelope: envelopeOf(withStrayProgramIndex(wire)),
      rpc: fakeRpc({ pre: state.pre, post: state.post, lookupTables: tables }),
    });
  });

  it('names a stray account index for what it is, even when the call carries tables', async () => {
    // The unresolved-account refusal must not be raised from inside the block
    // whose catch turns everything into `lookup-table-unavailable`: the tables
    // here resolved perfectly, and blaming them sends the operator hunting the
    // wrong thing on exactly the routed traffic this feature exists for.
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (draft) => setTransactionMessageFeePayer(SIGNER, draft),
      (draft) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: BLOCKHASH as never, lastValidBlockHeight: 1_000n },
          draft,
        ),
      (draft) => appendTransactionMessageInstructions([usdcTransfer(120n * USDC)], draft),
    );
    const tables: Record<string, Address[]> = { [TABLE]: [DESTINATION_ATA] };
    const compressed = compressTransactionMessageUsingAddressLookupTables(message, tables);
    const wire = getBase64EncodedWireTransaction(compileTransaction(compressed));

    const state = transferState(380n * USDC);
    await expectRefusal('undecodable-transaction', {
      envelope: envelopeOf(withStrayAccountIndex(wire)),
      rpc: fakeRpc({ pre: state.pre, post: state.post, lookupTables: tables }),
    });
  });
});

describe('verifyOnchainCall - what the pre-state read asks the node for', () => {
  it('asks for the base token layout only, never the whole account', async () => {
    // A provider may name accounts holding megabytes. The byte bound refuses
    // the extreme case, but the ordinary one is bounded by asking for a slice:
    // only the 165-byte base layout is ever decoded on this side. Asserted on
    // the REQUEST, because that is where the saving is - a node that ignored
    // the slice would return the same values and hide the difference.
    const reads: PreStateRead[] = [];
    const state = transferState(380n * USDC);
    const result = await verify({ rpc: fakeRpc({ ...state, recordReads: reads }) });
    expect(result.ok).toBe(true);
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      expect(read.dataSlice).toEqual({ offset: 0, length: 165 });
    }
  });
});

describe('verifyOnchainCall - an account the call both creates and closes', () => {
  it('does not report a temporary wSOL account as one it could not attribute', async () => {
    // The ordinary SOL swap shape: wrap into a fresh account, swap, close it.
    // The account never existed before and is gone after, so there is nothing
    // to warn about - and MCP refuses an unattributed account outright.
    const state = transferState(380n * USDC);
    const pre: AccountMap = { ...state.pre, [DESTINATION_ATA]: null };
    const post: AccountMap = { ...state.post, [DESTINATION_ATA]: null };
    const result = await verify({ rpc: fakeRpc({ pre, post }) });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.facts.unattributed).toEqual([]);
    }
  });
});

describe('defaultCeilings - the clients call it before the verifier runs', () => {
  it('refuses a malformed card rather than throwing a raw decoding error', () => {
    // Both clients call this directly to seed their limit boxes, so the typed
    // refusal has to live here and not only inside `verifyOnchainCall`.
    const broken = { ...descriptor(), max_per_call_subunits: 'lots' } as OnchainDescriptor;
    expect(() => defaultCeilings(broken)).toThrow(/spend ceiling that is not a number/);
    const brokenAuthority = {
      ...descriptor(),
      max_authority_subunits: 'plenty',
    } as OnchainDescriptor;
    expect(() => defaultCeilings(brokenAuthority)).toThrow(
      /authority ceiling that is not a number/,
    );
  });

  it('refuses a ceiling no chain can express, not only a non-numeric one', () => {
    // The digit pattern alone admits 20 digits, i.e. ~1e20; the descriptor
    // schema pairs it with a u64 bound. A hand-built card carrying the wider
    // value would seed both clients' limit boxes with a ceiling the chain
    // cannot represent, shown as though the capability had published it.
    const tooLarge = {
      ...descriptor(),
      max_per_call_subunits: '99999999999999999999',
    } as OnchainDescriptor;
    expect(() => defaultCeilings(tooLarge)).toThrow(/spend ceiling that is not a number/);
  });
});

describe('verifyOnchainCall - budget instructions that are not the customer’s fee', () => {
  function budgetInstruction(discriminator: number, payload: number[]): Instruction {
    return {
      programAddress: address(COMPUTE_BUDGET),
      accounts: [],
      data: new Uint8Array([discriminator, ...payload]),
    } as unknown as Instruction;
  }

  it('keeps a heap-frame request, which moves no lamports and only says how much room the call needs', async () => {
    // Dropping it makes a program that asked for a bigger heap abort, reported
    // as "the call fails against the current chain state" - after payment.
    const record: string[] = [];
    const state = transferState(380n * USDC);
    const result = await verify({
      envelope: envelopeOf(wireOf([budgetInstruction(1, [0, 0, 4, 0]), usdcTransfer(120n * USDC)])),
      rpc: fakeRpc({ ...state, record }),
    });
    expect(result.ok).toBe(true);
    // Present in the bytes the customer signs, not just tolerated on the way in.
    expect(hasBudgetDiscriminator(record[1] ?? '', 1)).toBe(true);
  });

  it('still takes away the price the provider tried to set', async () => {
    const record: string[] = [];
    const state = transferState(380n * USDC);
    const result = await verify({
      envelope: envelopeOf(wireOf([setComputeUnitPrice(5_000_000n), usdcTransfer(120n * USDC)])),
      rpc: fakeRpc({ ...state, record }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.facts.feeLamports).toBeLessThan(1_000_000n);
    }
  });
});

describe('verifyOnchainCall - budget instructions the client must take away', () => {
  it('removes a deprecated RequestUnits, which kit would not overwrite', async () => {
    // Kit's own setters replace a `SetComputeUnitLimit`/`Price` they recognise,
    // so those two would be neutralised even without the strip. `RequestUnits`
    // is the one kit knows nothing about: left in, the transaction carries both
    // it and the client's limit, which the runtime rejects as a duplicate - and
    // it carries a fee of its own.
    const record: string[] = [];
    const requestUnits = {
      programAddress: address(COMPUTE_BUDGET),
      accounts: [],
      // discriminator 0, u32 units, u32 additional_fee
      data: new Uint8Array([0, 64, 13, 3, 0, 160, 134, 1, 0]),
    } as unknown as Instruction;
    const state = transferState(380n * USDC);
    const result = await verify({
      envelope: envelopeOf(wireOf([requestUnits, usdcTransfer(120n * USDC)])),
      rpc: fakeRpc({ ...state, record }),
    });
    expect(result.ok).toBe(true);
    expect(hasBudgetDiscriminator(record[1] ?? '', 0)).toBe(false);
  });

  it('keeps a loaded-data-size request, which only tells the runtime what to load', async () => {
    const record: string[] = [];
    const state = transferState(380n * USDC);
    const result = await verify({
      envelope: envelopeOf(
        wireOf([
          {
            programAddress: address(COMPUTE_BUDGET),
            accounts: [],
            data: new Uint8Array([4, 0, 0, 4, 0]),
          } as unknown as Instruction,
          usdcTransfer(120n * USDC),
        ]),
      ),
      rpc: fakeRpc({ ...state, record }),
    });
    expect(result.ok).toBe(true);
    expect(hasBudgetDiscriminator(record[1] ?? '', 4)).toBe(true);
  });

  it('refuses a budget instruction carrying account metas, which no real one does', async () => {
    // Those metas now survive into the signed transaction, so a signer role on
    // one would reach the wallet unchecked and the send would fail for want of
    // a signature the customer cannot produce - after paying.
    await expectRefusal('malformed-instruction', {
      envelope: envelopeOf(
        wireOf([
          {
            programAddress: address(COMPUTE_BUDGET),
            accounts: [{ address: OTHER_WALLET, role: 2 }],
            data: new Uint8Array([1, 0, 0, 4, 0]),
          } as unknown as Instruction,
          usdcTransfer(120n * USDC),
        ]),
      ),
    });
  });

  it('accepts metas on a budget instruction it is going to throw away', async () => {
    // Real traffic: 43 of the 904 compute-budget-carrying transactions in two
    // finalized mainnet blocks attach account metas, and every one of them
    // attaches to a PRICING discriminator - real Jupiter routes among them.
    // Those instructions are stripped before the rebuild, so their metas reach
    // neither the wallet nor the watched set, and refusing them turned the
    // flagship case for this feature into a post-payment dead end.
    const record: string[] = [];
    const state = transferState(380n * USDC);
    const result = await verify({
      envelope: envelopeOf(
        wireOf([
          {
            programAddress: address(COMPUTE_BUDGET),
            accounts: [{ address: OTHER_WALLET, role: 1 }],
            data: new Uint8Array([3, 0, 0, 0, 0, 0, 0, 0, 0]),
          } as unknown as Instruction,
          usdcTransfer(120n * USDC),
        ]),
      ),
      rpc: fakeRpc({ ...state, record }),
    });
    expect(result.ok).toBe(true);
    // Three instructions in the signed wire - the transfer plus the client's
    // own limit and price. The provider's priced one, metas and all, is gone;
    // a surviving one would make four.
    expect(instructionCountOf(record[1] ?? '')).toBe(3);
    expect(result.ok && result.facts.programs).toEqual([TOKEN_PROGRAM]);
  });

  it('refuses budget metas that ask for nobody’s signature either', async () => {
    // The rule is about the SHAPE, not the signature: a writable non-signer
    // meta is refused too, which is why the reason cannot be the one that
    // tells the customer someone else must sign.
    await expectRefusal('malformed-instruction', {
      envelope: envelopeOf(
        wireOf([
          {
            programAddress: address(COMPUTE_BUDGET),
            accounts: [{ address: OTHER_WALLET, role: 1 }],
            data: new Uint8Array([1, 0, 0, 4, 0]),
          } as unknown as Instruction,
          usdcTransfer(120n * USDC),
        ]),
      ),
    });
  });
});
