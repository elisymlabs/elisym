/**
 * SPL token account decoding, done here rather than through the RPC's
 * `jsonParsed` view.
 *
 * Two reasons. A node that cannot parse Token-2022 silently falls back to
 * base64 - the failure `fetchSplBalanceBreakdown` in the MCP withdraw path
 * already works around - and the verifier must never treat "the node did not
 * parse it" as "there is no delegate here". And the first 165 bytes of a
 * Token-2022 account are byte-identical to a classic SPL Token account, so one
 * decoder covers both programs; extensions live past that offset and none of
 * them move the fields we assert on.
 *
 * Layout (SPL Token `Account`, 165 bytes):
 *   0..32    mint
 *   32..64   owner
 *   64..72   amount (u64 LE)
 *   72..76   delegate COption tag (u32 LE, 1 = Some)
 *   76..108  delegate
 *   108      state (0 uninitialized, 1 initialized, 2 frozen)
 *   109..113 is_native COption tag
 *   113..121 is_native
 *   121..129 delegated_amount (u64 LE)
 *   129..133 close_authority COption tag
 *   133..165 close_authority
 */

import { getBase58Decoder } from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS_STR } from '../payment/assets';

/** Classic SPL Token program. */
export const TOKEN_PROGRAM_ADDRESS_STR = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/** Both programs whose accounts this decoder understands. */
export const TOKEN_PROGRAM_IDS: readonly string[] = [
  TOKEN_PROGRAM_ADDRESS_STR,
  TOKEN_2022_PROGRAM_ADDRESS_STR,
];

const TOKEN_ACCOUNT_LEN = 165;
const COPTION_SOME = 1;

/**
 * `Multisig::LEN`. Its body is entirely caller-chosen at initialization, so its
 * first 165 bytes can be ground to decode as a token account "owned by" any
 * wallet an attacker names - and a multisig can never be closed, so lamports
 * parked in one are destroyed rather than merely moved. Both token programs
 * refuse to unpack an account of this exact length; so does this decoder.
 */
const MULTISIG_LEN = 355;

/**
 * Token-2022 tags anything longer than the base layout with an account type at
 * offset 165. `2` is `Account`; `1` is `Mint`, whose padded body would
 * otherwise decode as a garbage "uninitialized account" with a nonsense mint
 * and owner.
 *
 * Only reachable when the caller passes unsliced data - the verifier's
 * pre-state read is sliced to 165 bytes, so the guard applies to the post-state
 * only. That asymmetry is safe rather than lucky: a Token-2022 mint's first 165
 * bytes place `is_initialized = 1` and a `COption` tag inside the range this
 * decoder reads as `owner`, and those fixed bytes cannot be ground to match a
 * chosen wallet - so a mint can never decode as an account the signer owns, and
 * every path that depends on ownership fails closed.
 */
const TOKEN_2022_ACCOUNT_TYPE_OFFSET = 165;
const TOKEN_2022_TYPE_ACCOUNT = 2;

export type TokenAccountLifecycle = 'uninitialized' | 'initialized' | 'frozen';

/** What the caller knows about the account beyond the bytes it holds. */
export interface DecodeTokenAccountOptions {
  /** The account's true on-chain length, when the read was sliced. */
  length?: number;
  /** The owning token program, which decides the exact-length rule. */
  program?: string;
}

export interface TokenAccountState {
  mint: string;
  /** The wallet that owns the funds, NOT the owning program. */
  owner: string;
  amount: bigint;
  /** Present when someone other than the owner may move funds from this account. */
  delegate?: string;
  /** How much that delegate may move. Zero when there is no delegate. */
  delegatedAmount: bigint;
  /**
   * True for a wrapped-SOL account. The native mint has no freeze authority and
   * never will, so lamports in such an account stay recoverable by its owner -
   * which is not true of any other mint, whose issuer may freeze at will.
   */
  isNative: boolean;
  state: TokenAccountLifecycle;
  closeAuthority?: string;
  /**
   * The Token-2022 ConfidentialTransferAccount extension is present, so
   * `amount` is only the PUBLIC half of what this account holds. A
   * `ConfidentialTransfer::Withdraw` moves the owner's hidden balance into it,
   * which reads here as an inflow out of nowhere and can net a real outflow to
   * zero. Only knowable on the post side, whose data arrives whole; the
   * pre-state read is sliced to the base layout.
   */
  hasConfidentialBalance: boolean;
}

function readAddress(data: Uint8Array, offset: number): string {
  return getBase58Decoder().decode(data.subarray(offset, offset + 32));
}

function readU64(view: DataView, offset: number): bigint {
  return view.getBigUint64(offset, true);
}

function readU32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function readLifecycle(raw: number): TokenAccountLifecycle | null {
  if (raw === 0) {
    return 'uninitialized';
  }
  if (raw === 1) {
    return 'initialized';
  }
  if (raw === 2) {
    return 'frozen';
  }
  return null;
}

/** Whether an account's owning program is one of the token programs. */
export function isTokenProgram(programId: string | undefined): boolean {
  return programId !== undefined && TOKEN_PROGRAM_IDS.includes(programId);
}

/**
 * Decode a token account's base layout. Returns `null` when the buffer is too
 * short or the state byte is not one the SPL layout defines - a caller must
 * treat that as "unknown", never as "empty".
 */
export function decodeTokenAccount(
  data: Uint8Array,
  options: DecodeTokenAccountOptions = {},
): TokenAccountState | null {
  if (data.length < TOKEN_ACCOUNT_LEN) {
    return null;
  }
  // The account's TRUE length, which is what the layout rules are about. A
  // sliced read (the verifier's pre-state) carries fewer bytes than the account
  // has, so `data.length` alone would let a forged layout through on one side
  // of the diff and not the other.
  const length = options.length !== undefined && options.length > 0 ? options.length : data.length;
  if (length === MULTISIG_LEN) {
    return null;
  }
  // A classic SPL Token account is exactly 165 bytes. Anything else owned by
  // that program is a mint or a multisig wearing an account's first 165 bytes.
  if (options.program === TOKEN_PROGRAM_ADDRESS_STR && length !== TOKEN_ACCOUNT_LEN) {
    return null;
  }
  // The Token-2022 account-type tag sits past the base layout, so it is only
  // checkable when the caller actually holds those bytes.
  if (
    data.length > TOKEN_ACCOUNT_LEN &&
    data[TOKEN_2022_ACCOUNT_TYPE_OFFSET] !== TOKEN_2022_TYPE_ACCOUNT
  ) {
    return null;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const state = readLifecycle(data[108] ?? -1);
  if (state === null) {
    return null;
  }
  const hasDelegate = readU32(view, 72) === COPTION_SOME;
  const hasCloseAuthority = readU32(view, 129) === COPTION_SOME;
  const isNative = readU32(view, 109) === COPTION_SOME;
  return {
    mint: readAddress(data, 0),
    owner: readAddress(data, 32),
    amount: readU64(view, 64),
    ...(hasDelegate ? { delegate: readAddress(data, 76) } : {}),
    delegatedAmount: hasDelegate ? readU64(view, 121) : 0n,
    isNative,
    state,
    ...(hasCloseAuthority ? { closeAuthority: readAddress(data, 133) } : {}),
    hasConfidentialBalance: carriesConfidentialTransfer(data, view),
  };
}

/** Token-2022 extension discriminator for `ConfidentialTransferAccount`. */
const EXTENSION_CONFIDENTIAL_TRANSFER_ACCOUNT = 5;
/** Base layout plus the one-byte account-type tag: where the TLV list starts. */
const TOKEN_2022_TLV_OFFSET = TOKEN_ACCOUNT_LEN + 1;

/**
 * Whether this account carries a confidential balance.
 *
 * Walks the Token-2022 TLV list - `u16` type, `u16` length, payload - and stops
 * on anything malformed rather than guessing. A truncated or nonsensical list
 * reads as "no extension", which is the direction that keeps `amount` the whole
 * story only when the bytes actually say so.
 */
function carriesConfidentialTransfer(data: Uint8Array, view: DataView): boolean {
  let offset = TOKEN_2022_TLV_OFFSET;
  while (offset + 4 <= data.length) {
    const type = view.getUint16(offset, true);
    const length = view.getUint16(offset + 2, true);
    if (type === EXTENSION_CONFIDENTIAL_TRANSFER_ACCOUNT) {
      return true;
    }
    if (type === 0) {
      return false;
    }
    offset += 4 + length;
  }
  return false;
}
