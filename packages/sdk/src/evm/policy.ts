/**
 * TIP-403 receive policies.
 *
 * An account can refuse incoming transfers. When it does, the transfer SUCCEEDS,
 * the funds sit with the guard, and no `TransferWithMemo` is emitted - so a
 * provider whose own policy is closed would issue a payment request nobody can
 * ever pay, and read every attempt as "not paid". This module is how the issuer
 * finds that out before it quotes a price.
 *
 * An unreadable answer is never "open". Zero is the ACCEPTING value of the first
 * word, so an empty return - what an address with no code answers - must not be
 * allowed to decode as one; the length is checked before any word is read.
 */

import { isEvmWireAddress } from '../payment/chains';
import type { Eip1193Client } from './client';
import {
  RECEIVE_POLICY_SELECTOR,
  TEMPO_POLICY_REGISTRY,
  VALIDATE_RECEIVE_POLICY_SELECTOR,
} from './constants';
import { readAddressWord, readUint256, readWords } from './rpc-read';

/** `(hasReceivePolicy, senderPolicyId, senderPolicyType, tokenFilterId, tokenFilterType, recoveryAuthority)`. */
const POLICY_WORDS = 6;
export interface TempoReceivePolicy {
  /** False when the account has no policy at all: every transfer is accepted. */
  configured: boolean;
  /**
   * The four filter words, verbatim. NOTHING here decides deliverability: read
   * across 2164 accounts on both networks, an id of 1245557 appears with a
   * `type` of 1 and an id of 1 with a `type` of 0, so neither word is a
   * namespace flag; and 518 accounts whose `senderPolicy` reads `(0, 0)` -
   * which the registry's own docs call reject-all - receive transfers every
   * day. Deliverability is per `(token, sender, receiver)` and only
   * `canReceiveFrom` answers it.
   */
  senderPolicyId: bigint;
  senderPolicyType: bigint;
  tokenFilterId: bigint;
  tokenFilterType: bigint;
  recoveryAuthority: string;
}

/**
 * The receive policy of one address, or `null` when the registry did not answer
 * exactly six words with a first word of 0 or 1.
 *
 * A VIRTUAL address (TIP-1022) is not accepted anywhere in this SDK, and this is
 * one of the reasons: a transfer to an alias is resolved to its master and the
 * master's policy is enforced, but this read answers for the alias itself and
 * always says "open".
 */
export async function readTempoReceivePolicy(
  client: Eip1193Client,
  address: string,
): Promise<TempoReceivePolicy | null> {
  if (!isEvmWireAddress(address)) {
    throw new Error(`Not an address a receive policy can be read for: ${address}`);
  }
  const raw = await client
    .request({
      method: 'eth_call',
      params: [
        {
          to: TEMPO_POLICY_REGISTRY,
          data: `${RECEIVE_POLICY_SELECTOR}${'0'.repeat(24)}${address.slice(2).toLowerCase()}`,
        },
        // The same tag the config read uses, and for the same reason: a policy
        // that a reorg could take back is not one to quote a price against.
        'finalized',
      ],
    })
    .catch(() => null);
  const words = readWords(raw, POLICY_WORDS);
  const configured = readUint256(words?.[0]);
  const senderPolicyId = readUint256(words?.[1]);
  const senderPolicyType = readUint256(words?.[2]);
  const tokenFilterId = readUint256(words?.[3]);
  const tokenFilterType = readUint256(words?.[4]);
  const recoveryAuthority = readAddressWord(words?.[5]);
  if (
    configured === null ||
    senderPolicyId === null ||
    senderPolicyType === null ||
    tokenFilterId === null ||
    tokenFilterType === null ||
    recoveryAuthority === null ||
    configured > 1n
  ) {
    return null;
  }
  return {
    configured: configured === 1n,
    senderPolicyId,
    senderPolicyType,
    tokenFilterId,
    tokenFilterType,
    recoveryAuthority,
  };
}

/** Exactly 64 bytes, and only `(1, 0)` is a yes. `null` means unreadable. */
export async function canReceiveFrom(
  client: Eip1193Client,
  check: { token: string; sender: string; recipient: string },
): Promise<boolean | null> {
  const argument = (address: string): string =>
    `${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
  const raw = await client
    .request({
      method: 'eth_call',
      params: [
        {
          to: TEMPO_POLICY_REGISTRY,
          data:
            VALIDATE_RECEIVE_POLICY_SELECTOR +
            argument(check.token) +
            argument(check.sender) +
            argument(check.recipient),
        },
        // A policy a reorg could take back is not one to quote a price against.
        'finalized',
      ],
    })
    .catch(() => null);
  const words = readWords(raw, 2);
  const authorized = readUint256(words?.[0]);
  const reason = readUint256(words?.[1]);
  if (authorized === null || reason === null) {
    return null;
  }
  return authorized === 1n && reason === 0n;
}

/**
 * Can an arbitrary customer pay this address in this coin?
 *
 * That is the ISSUER's question, and it is not the same as "does this address
 * have a policy": most configured accounts on Moderato accept transfers from
 * their own senders and refuse a stranger, which is exactly the case a
 * broadcast card must not quote. The probe sender is RANDOM, so a policy
 * cannot be written to allow the question and refuse the answer.
 */
export async function canStrangerReceive(
  client: Eip1193Client,
  token: string,
  recipient: string,
): Promise<boolean | null> {
  const probe = new Uint8Array(20);
  globalThis.crypto.getRandomValues(probe);
  const sender = `0x${Array.from(probe, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  return await canReceiveFrom(client, { token, sender, recipient });
}
