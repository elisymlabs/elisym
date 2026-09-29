/**
 * The Solana RPC a purchase uses, per network, and whether it can prove that a
 * payment attempt ended unpaid (`canProveOver`).
 *
 * Proving "not paid" needs a full-history endpoint: a public RPC may miss a
 * payment, and acting on that miss (a retry, a new order) could pay twice. So
 * mainnet proof needs the operator's own endpoint in `~/.elisym/solana-rpc.json`
 * (`{ "mainnet": "https://..." }`, mode 0600: the URL usually carries an API
 * key, and it is never echoed). Without it a mainnet purchase is paid once and
 * then only followed. Devnet uses the public endpoint (test money).
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { type SolanaNetwork, rpcUrlFor } from './context.js';

export const SOLANA_RPC_FILE = join(homedir(), '.elisym', 'solana-rpc.json');

const RpcFileSchema = z
  .object({
    mainnet: z
      .string()
      .refine((value) => URL.canParse(value) && new URL(value).protocol === 'https:', {
        message: 'must be an https URL',
      })
      .optional(),
  })
  .strict();

export interface PurchaseRpc {
  url: string;
  /** Whether "no payment found" from this endpoint can be acted on. */
  canProveOver: boolean;
}

export class SolanaRpcFileError extends Error {}

/**
 * The RPC for `network`. A missing file means no full-history endpoint; a
 * malformed one refuses mainnet purchases (never a silent public fallback).
 */
export async function purchaseRpc(
  network: SolanaNetwork,
  path: string = SOLANA_RPC_FILE,
): Promise<PurchaseRpc> {
  if (network === 'devnet') {
    return { url: rpcUrlFor('devnet'), canProveOver: true };
  }
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { url: rpcUrlFor('mainnet'), canProveOver: false };
    }
    throw new SolanaRpcFileError(`cannot read ${path}`);
  }
  let parsed: z.infer<typeof RpcFileSchema>;
  try {
    parsed = RpcFileSchema.parse(JSON.parse(text));
  } catch {
    throw new SolanaRpcFileError(
      `${path} is not usable: it must be {"mainnet": "https://..."}; mainnet purchases are refused until it is fixed`,
    );
  }
  return parsed.mainnet === undefined
    ? { url: rpcUrlFor('mainnet'), canProveOver: false }
    : { url: parsed.mainnet, canProveOver: true };
}
