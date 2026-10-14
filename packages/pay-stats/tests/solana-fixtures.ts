/**
 * `getTransaction` (`encoding: 'json'`) answers built by hand: the instructions
 * as addresses and bytes, the keys indexed the way a node indexes them (static
 * keys, then the lookup table's writable and read-only ones).
 */
import { ELISYM_PROTOCOL_TAG } from '@elisym/pay-core';
import { getBase58Decoder } from '@solana/kit';

export const SYSTEM = '11111111111111111111111111111111';
export const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const TAG: string = ELISYM_PROTOCOL_TAG;
export const USDC_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export const PAYER = '9vSzVjVGUKqs6vEk1sKc3RPCRkAQfKHDzEkqM6ErqJkz';
export const PAYOUT = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
export const TREASURY = 'GY7vnWMkKpftU4nQ16C2ATkj1JwrQpHhknkaBUn67VTy';
export const REFERENCE = '9X2A3QwTyptFanKJABbs62fSYnsBqUdXZrmeiJRHwGy2';
export const OTHER_REFERENCE = '4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T';
/** Token accounts: the payer's, the payout's and the treasury's USDC accounts. */
export const PAYER_ATA = 'HXtBm8XZbxaTt41uqaKhwUAa6Z1aPyvJdsZVENiWsetg';
export const PAYOUT_ATA = 'Bt8KVz26uLrXrMzRKaJgX9rYd2VcfBh8J2Nxbgxdeb3b';
export const TREASURY_ATA = 'CLgGnjpg4f3H3EWpqoEdTdcmtbTwUoWHG9fsg8LmJ1aZ';

export interface FixtureInstruction {
  program: string;
  accounts: readonly string[];
  data: Uint8Array;
}

export function solTransfer(from: string, to: string, amount: bigint, reference = REFERENCE) {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, amount, true);
  return { program: SYSTEM, accounts: [from, to, reference, TAG], data };
}

export function usdcTransfer(
  source: string,
  destination: string,
  amount: bigint,
  reference = REFERENCE,
) {
  const data = new Uint8Array(10);
  const view = new DataView(data.buffer);
  data[0] = 12;
  view.setBigUint64(1, amount, true);
  data[9] = 6;
  return {
    program: TOKEN,
    accounts: [source, USDC_MAINNET, destination, PAYER, reference, TAG],
    data,
  };
}

export function memo(text: string): FixtureInstruction {
  return { program: MEMO, accounts: [], data: new TextEncoder().encode(text) };
}

export interface FixtureOptions {
  /** Addresses served from a lookup table instead of the static keys. */
  loaded?: { writable?: readonly string[]; readonly?: readonly string[] };
  /** Token account -> owner, every one USDC. */
  tokenOwners?: Record<string, string>;
  err?: unknown;
  blockTime?: number;
  slot?: number;
  inner?: readonly FixtureInstruction[];
}

export function landedJson(
  instructions: readonly FixtureInstruction[],
  options: FixtureOptions = {},
): Record<string, unknown> {
  const loadedWritable = [...(options.loaded?.writable ?? [])];
  const loadedReadonly = [...(options.loaded?.readonly ?? [])];
  const loaded = new Set([...loadedWritable, ...loadedReadonly]);
  const staticKeys: string[] = [PAYER];
  const named = [
    ...instructions.flatMap((instruction) => [instruction.program, ...instruction.accounts]),
    ...(options.inner ?? []).flatMap((instruction) => [
      instruction.program,
      ...instruction.accounts,
    ]),
    ...Object.keys(options.tokenOwners ?? {}),
  ];
  for (const address of named) {
    if (!loaded.has(address) && !staticKeys.includes(address)) {
      staticKeys.push(address);
    }
  }
  const keys = [...staticKeys, ...loadedWritable, ...loadedReadonly];
  const base58 = getBase58Decoder();
  const compiled = (instruction: FixtureInstruction) => ({
    programIdIndex: keys.indexOf(instruction.program),
    accounts: instruction.accounts.map((account) => keys.indexOf(account)),
    data: base58.decode(instruction.data),
  });
  const rows = Object.entries(options.tokenOwners ?? {}).map(([account, owner]) => ({
    accountIndex: keys.indexOf(account),
    mint: USDC_MAINNET,
    owner,
    uiTokenAmount: { amount: '0' },
  }));
  return {
    slot: options.slot ?? 1000,
    blockTime: options.blockTime ?? Date.parse('2026-10-20T12:00:00Z') / 1000,
    transaction: {
      signatures: ['sig'],
      message: {
        accountKeys: staticKeys,
        header: {
          numRequiredSignatures: 1,
          numReadonlySignedAccounts: 0,
          numReadonlyUnsignedAccounts: 0,
        },
        instructions: instructions.map(compiled),
      },
    },
    meta: {
      err: options.err ?? null,
      loadedAddresses: { writable: loadedWritable, readonly: loadedReadonly },
      preTokenBalances: rows,
      postTokenBalances: rows,
      innerInstructions:
        options.inner === undefined
          ? []
          : [{ index: 0, instructions: options.inner.map(compiled) }],
    },
  };
}
