/**
 * Solana: every transaction that names the elisym protocol tag, from the marker
 * launch on, classified by its BOUND transfers - a System or SPL transfer whose
 * last two accounts are a reference and `ELISYM_PROTOCOL_TAG`, exactly what a
 * verifier binds. Balance deltas are never read: the stats PDA's rent shows as
 * one.
 *
 * A transaction is commerce when a top-level Memo v2 is exactly `elisym:commerce`,
 * a job when one starts `elisym:v1:`, ambiguous with both, untagged with
 * neither (an elisym payment from before the marker, or a wallet that dropped
 * it). A memo inside another program's call is not the payer's and is ignored.
 * Only commerce is counted as purchases; the rest are context counts.
 */
import {
  ELISYM_PROTOCOL_TAG,
  type DirectInstruction,
  classifyElisymMemo,
  directInstructionsFromRpcTransaction,
} from '@elisym/pay-core';
import type { Rpc, Signature, SolanaRpcApi } from '@solana/kit';
import { type Candidate, type ContextCount, type StatsNetwork, utcDay } from './aggregate';
import { coinOf } from './usd';

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
/** SPL Memo v2: the only memo program the widget and the MCP write with. */
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
/** System `Transfer`: a u32 discriminator, then the lamports. */
const SYSTEM_TRANSFER = 2;
/** SPL `TransferChecked`: one byte, the amount, the decimals. */
const TOKEN_TRANSFER_CHECKED = 12;
/** One `getSignaturesForAddress` page. */
const SIGNATURE_PAGE = 1000;

/** One bound transfer: who it paid, how much of what, under which reference. */
interface BoundLeg {
  reference: string;
  /** The receiving OWNER: the account itself for SOL, the token account's owner for SPL. */
  to: string;
  from: string;
  /** The SPL mint, `undefined` for SOL. */
  mint: string | undefined;
  amount: bigint;
}

export type SolanaClassification =
  | { kind: 'commerce'; candidate: Candidate }
  | { kind: 'context'; day: string; bucket: string }
  | { kind: 'skip' };

function readU64(data: Uint8Array, offset: number): bigint | undefined {
  if (data.length < offset + 8) {
    return undefined;
  }
  return new DataView(data.buffer, data.byteOffset + offset, 8).getBigUint64(0, true);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function fieldOf(value: unknown, key: string): unknown {
  return isRecord(value) && key in value ? value[key] : undefined;
}

function stringsOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries: unknown[] = value;
  return entries.every(isString) ? entries : undefined;
}

/**
 * The keys a balance row's `accountIndex` counts in: the static keys, then the
 * lookup table's writable and read-only ones - the order pay-core's
 * `mergeAccountKeys` reads (that one sits behind `@elisym/pay-core/internal`,
 * which no package's sources may import). A malformed loaded half is left out
 * rather than allowed to shift the halves after it.
 */
function mergedKeys(transaction: unknown): string[] {
  const message = fieldOf(fieldOf(transaction, 'transaction'), 'message');
  const loaded = fieldOf(fieldOf(transaction, 'meta'), 'loadedAddresses');
  const staticKeys = stringsOf(fieldOf(message, 'accountKeys')) ?? [];
  const writable = stringsOf(fieldOf(loaded, 'writable'));
  const readonly = stringsOf(fieldOf(loaded, 'readonly'));
  if (writable === undefined || readonly === undefined) {
    return staticKeys;
  }
  return [...staticKeys, ...writable, ...readonly];
}

/** Token account -> (owner, mint), from the transaction's own balance rows. */
function tokenOwners(transaction: unknown): Map<string, { owner: string; mint: string }> {
  const meta = fieldOf(transaction, 'meta');
  const keys = mergedKeys(transaction);
  const owners = new Map<string, { owner: string; mint: string }>();
  for (const side of ['preTokenBalances', 'postTokenBalances']) {
    const rows = fieldOf(meta, side);
    if (!Array.isArray(rows)) {
      continue;
    }
    for (const row of rows) {
      const index = fieldOf(row, 'accountIndex');
      const owner = fieldOf(row, 'owner');
      const mint = fieldOf(row, 'mint');
      const account = typeof index === 'number' ? keys[index] : undefined;
      if (account !== undefined && typeof owner === 'string' && typeof mint === 'string') {
        owners.set(account, { owner, mint });
      }
    }
  }
  return owners;
}

/** The bound transfer an instruction is, or `undefined`. */
function boundLeg(
  instruction: DirectInstruction,
  owners: ReadonlyMap<string, { owner: string; mint: string }>,
): BoundLeg | undefined {
  const accounts = instruction.accounts.map((account) => account.address);
  const tag = accounts.at(-1);
  const reference = accounts.at(-2);
  if (tag !== ELISYM_PROTOCOL_TAG || reference === undefined) {
    return undefined;
  }
  const data = instruction.data;
  if (instruction.program === SYSTEM_PROGRAM) {
    const discriminator =
      data.length >= 4 ? new DataView(data.buffer, data.byteOffset, 4).getUint32(0, true) : -1;
    const amount = readU64(data, 4);
    const [from, to] = accounts;
    if (
      discriminator !== SYSTEM_TRANSFER ||
      amount === undefined ||
      from === undefined ||
      to === undefined
    ) {
      return undefined;
    }
    return { reference, from, to, mint: undefined, amount };
  }
  if (instruction.program === TOKEN_PROGRAM || instruction.program === TOKEN_2022_PROGRAM) {
    const amount = readU64(data, 1);
    const [source, mint, destination] = accounts;
    if (
      data[0] !== TOKEN_TRANSFER_CHECKED ||
      amount === undefined ||
      source === undefined ||
      mint === undefined ||
      destination === undefined
    ) {
      return undefined;
    }
    const to = owners.get(destination);
    const from = owners.get(source);
    if (to === undefined || to.mint !== mint) {
      return undefined;
    }
    return { reference, from: from?.owner ?? source, to: to.owner, mint, amount };
  }
  return undefined;
}

/** What one `getTransaction` (json, finalized) says, read with no chain access. */
export function classifySolanaTransaction(
  transaction: unknown,
  signature: string,
  network: StatsNetwork,
  treasuries: ReadonlySet<string>,
): SolanaClassification {
  const meta = fieldOf(transaction, 'meta');
  const blockTime = fieldOf(transaction, 'blockTime');
  const slot = fieldOf(transaction, 'slot');
  if (meta === undefined || fieldOf(meta, 'err') !== null) {
    return { kind: 'skip' };
  }
  const time = typeof blockTime === 'bigint' ? Number(blockTime) : blockTime;
  const slotNumber = typeof slot === 'bigint' ? Number(slot) : slot;
  if (typeof time !== 'number' || typeof slotNumber !== 'number') {
    return { kind: 'skip' };
  }
  let instructions: DirectInstruction[];
  try {
    instructions = directInstructionsFromRpcTransaction(transaction);
  } catch {
    return { kind: 'skip' };
  }
  const owners = tokenOwners(transaction);
  const legs = instructions.flatMap((instruction) => {
    const leg = boundLeg(instruction, owners);
    // A self-transfer and a zero amount are free to forge: never a payment.
    return leg === undefined || leg.amount === 0n || leg.from === leg.to ? [] : [leg];
  });
  const first = legs[0];
  if (first === undefined) {
    return { kind: 'skip' };
  }
  const day = utcDay(time);
  const kinds = new Set(
    instructions.flatMap((instruction) =>
      instruction.program === MEMO_PROGRAM
        ? [classifyElisymMemo(new TextDecoder().decode(instruction.data))]
        : [],
    ),
  );
  const commerce = kinds.has('commerce');
  const job = kinds.has('job');
  if (commerce && job) {
    return { kind: 'context', day, bucket: 'ambiguous' };
  }
  if (job) {
    return { kind: 'context', day, bucket: 'job' };
  }
  if (!commerce) {
    return { kind: 'context', day, bucket: 'untagged' };
  }
  // The order's reference is the first bound transfer's; a leg under another
  // reference is extra, and so is one in another coin than the provider's.
  const ours = legs.filter((leg) => leg.reference === first.reference);
  let provider: BoundLeg | undefined;
  for (const leg of ours) {
    if (!treasuries.has(leg.to) && (provider === undefined || leg.amount > provider.amount)) {
      provider = leg;
    }
  }
  if (provider === undefined) {
    return { kind: 'context', day, bucket: 'treasury_only' };
  }
  const coin = provider.mint;
  const fees = ours
    .filter((leg) => treasuries.has(leg.to) && leg.mint === coin)
    .map((leg) => ({ treasury: leg.to, amount: leg.amount }));
  return {
    kind: 'commerce',
    candidate: {
      rail: 'solana',
      network,
      reference: first.reference,
      day,
      position: { primary: slotNumber, secondary: signature },
      coin: coinOf('solana', network, coin),
      payout: provider.to,
      provider: provider.amount,
      fees,
    },
  };
}

export interface SolanaScan {
  candidates: Candidate[];
  context: ContextCount[];
}

/** Every signature naming the tag down to `since` (unix seconds), newest first, failed ones left out. */
export async function tagSignatures(
  rpc: Rpc<SolanaRpcApi>,
  since: number,
): Promise<{ signature: Signature; slot: number }[]> {
  const found: { signature: Signature; slot: number }[] = [];
  let before: Signature | undefined;
  for (;;) {
    const page = await rpc
      .getSignaturesForAddress(ELISYM_PROTOCOL_TAG, {
        limit: SIGNATURE_PAGE,
        commitment: 'finalized',
        ...(before === undefined ? {} : { before }),
      })
      .send();
    for (const entry of page) {
      const time = entry.blockTime === null ? undefined : Number(entry.blockTime);
      if (time !== undefined && time < since) {
        return found;
      }
      if (entry.err === null) {
        found.push({ signature: entry.signature, slot: Number(entry.slot) });
      }
    }
    const last = page.at(-1);
    if (page.length < SIGNATURE_PAGE || last === undefined) {
      return found;
    }
    before = last.signature;
  }
}

/** Read and classify every tagged transaction since `since`. */
export async function scanSolana(
  rpc: Rpc<SolanaRpcApi>,
  network: StatsNetwork,
  since: number,
  treasuries: ReadonlySet<string>,
): Promise<SolanaScan> {
  const result: SolanaScan = { candidates: [], context: [] };
  for (const { signature } of await tagSignatures(rpc, since)) {
    const transaction = await rpc
      .getTransaction(signature, {
        commitment: 'finalized',
        encoding: 'json',
        maxSupportedTransactionVersion: 0,
      })
      .send();
    if (transaction === null) {
      throw new Error(`the Solana rpc does not serve transaction ${signature}`);
    }
    const classified = classifySolanaTransaction(transaction, signature, network, treasuries);
    if (classified.kind === 'commerce') {
      result.candidates.push(classified.candidate);
    } else if (classified.kind === 'context') {
      result.context.push({
        day: classified.day,
        rail: 'solana',
        bucket: classified.bucket,
        count: 1,
      });
    }
  }
  return result;
}
