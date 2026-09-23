import { ed25519 } from '@noble/curves/ed25519.js';
import { base58 } from '@scure/base';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import type { EventTemplate, NostrEvent } from 'nostr-tools';
import { paytoProofMessage } from '../src/wallet-proof';

export const USDC_DEVNET_CAIP19 =
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
export const USDC_MAINNET_CAIP19 =
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDCE_TEMPO_CAIP19 = 'eip155:4217/erc20:0x20c000000000000000000000b9537d11c60e8b50';

/**
 * Produced by viem's `account.signMessage` (an independent EIP-191 implementation)
 * for private key 0x4c08...2318 over
 * `paytoProofMessage('a'.repeat(64), USDCE_TEMPO_CAIP19)`.
 */
export const EVM_VECTOR = {
  owner: 'a'.repeat(64),
  address: '0x2c7536e3605d9c16a7a3d7b1898e529396a65c23',
  signature:
    '0xdb167e9e9fac8ba6b069251df889846643c1e2677774870c6fe55af29a92a1761ff9c7a1d15fe78c010885ef6ccab3fccf008ae538bafe32f5cc544a83a8cbab1c',
};

export interface NostrKey {
  secretKey: Uint8Array;
  pubkey: string;
}

export function nostrKey(): NostrKey {
  const secretKey = generateSecretKey();
  return { secretKey, pubkey: getPublicKey(secretKey) };
}

export function sign(template: EventTemplate, key: NostrKey): NostrEvent {
  return finalizeEvent(template, key.secretKey);
}

export interface SolanaWallet {
  secretKey: Uint8Array;
  address: string;
  proveFor: (ownerPubkey: string, caip19: string) => string;
}

export function solanaWallet(): SolanaWallet {
  const secretKey = ed25519.utils.randomSecretKey();
  const address = base58.encode(ed25519.getPublicKey(secretKey));
  return {
    secretKey,
    address,
    proveFor: (ownerPubkey, caip19) =>
      base58.encode(
        ed25519.sign(new TextEncoder().encode(paytoProofMessage(ownerPubkey, caip19)), secretKey),
      ),
  };
}
