import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { paytoProofMessage } from '@elisym/commerce';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { KIND_HTTP_AUTH, sha256Hex } from '../src/admin/nip98';
import type { Db } from '../src/db/db';
import { KeyVault } from '../src/db/keys';
import { StoreDirectory } from '../src/state/stores';

export const NOW = 1_790_000_000;
export const MASTER_KEY = 'ab'.repeat(32);
export const BASE = 'https://paycore.example';
export const OPERATOR = 'paycore.example';
export const RELAY = 'wss://relay.elisym.network';
export const USDC_DEVNET =
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
export const RPCS = {
  mainnet: { evm: {} },
  devnet: { solana: 'https://solana-devnet.example', evm: {} },
};

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58(bytes: Uint8Array): string {
  let value = BigInt(`0x${Buffer.from(bytes).toString('hex') || '0'}`);
  let text = '';
  while (value > 0n) {
    text = (ALPHABET[Number(value % 58n)] ?? '') + text;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) {
      break;
    }
    text = `1${text}`;
  }
  return text;
}

/** A Solana wallet that signs payout proofs (ed25519 over the proof text). */
export function solanaWallet(): {
  address: string;
  prove: (owner: string, caip19: string) => string;
} {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const key = createPrivateKey(privateKey.export({ format: 'pem', type: 'pkcs8' }));
  return {
    address: base58(raw),
    prove: (owner, caip19) =>
      base58(sign(null, Buffer.from(paytoProofMessage(owner, caip19), 'utf8'), key)),
  };
}

export function ownerKeys(): { secret: Uint8Array; pubkey: string } {
  const secret = generateSecretKey();
  return { secret, pubkey: getPublicKey(secret) };
}

/** A signed draft payout list of one devnet USDC payout. */
export function signedPayouts(
  owner: string,
): { caip19: string; address: string; signature: string }[] {
  const wallet = solanaWallet();
  return [
    { caip19: USDC_DEVNET, address: wallet.address, signature: wallet.prove(owner, USDC_DEVNET) },
  ];
}

export function directoryFor(
  db: Db,
  overrides: { now?: () => number; pendingMaxProducts?: number } = {},
): StoreDirectory {
  return new StoreDirectory({
    db,
    vault: new KeyVault(MASTER_KEY),
    inboxRelays: [RELAY],
    rpcs: RPCS,
    now: overrides.now ?? (() => NOW),
    ...(overrides.pendingMaxProducts === undefined
      ? {}
      : { pendingMaxProducts: overrides.pendingMaxProducts }),
  });
}

/** Put the store on tier `name` (made with `maxProducts`) and `status`. */
export async function activate(
  db: Db,
  owner: string,
  maxProducts = 2,
  status = 'active',
): Promise<void> {
  const name = `tier-${maxProducts}`;
  await db.query(
    'insert into tiers (name, max_products) values ($1, $2) on conflict (name) do nothing',
    [name, maxProducts],
  );
  await db.query('update stores set status = $2, tier = $3 where owner = $1', [
    owner,
    status,
    name,
  ]);
}

export const PRODUCT = {
  title: 'Socks',
  description: 'Warm socks.',
  priceUsd: '5',
};

/** A NIP-98 `Authorization` header. */
export function authHeader(input: {
  secret: Uint8Array;
  method: string;
  url: string;
  body?: string;
  payload?: string;
  createdAt?: number;
}): string {
  const payload = input.payload ?? (input.body ? sha256Hex(input.body) : undefined);
  const tags = [
    ['u', input.url],
    ['method', input.method],
    ...(payload === undefined ? [] : [['payload', payload]]),
    ['nonce', Buffer.from(generateSecretKey()).toString('hex')],
  ];
  const event = finalizeEvent(
    { kind: KIND_HTTP_AUTH, created_at: input.createdAt ?? NOW, tags, content: '' },
    input.secret,
  );
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`;
}
