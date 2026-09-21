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
import { RECEIVE_POLICY_SELECTOR, TEMPO_POLICY_REGISTRY } from './constants';
import { readAddressWord, readUint256, readWords } from './rpc-read';

/** `(hasReceivePolicy, senderPolicyId, senderPolicyType, tokenFilterId, tokenFilterType, recoveryAuthority)`. */
const POLICY_WORDS = 6;
/** Built-in policy 0 is reject-all, 1 is allow-all. */
const POLICY_ALLOW_ALL = 1n;
/**
 * The `type` word beside each id, and half of what an id means. Read live: the
 * one configured-and-open account on Moderato answers ids 1 and 1 with types 1
 * and 1, while the account with real filters answers ids 1251837 and 1251838
 * with types 0 and 0 - a per-chain counter of custom lists. So `(id 1, type 0)`
 * is list number one, not "everyone", and quoting a price against it would hand
 * the customer's money to the guard. Both words are required.
 */
const POLICY_TYPE_BUILT_IN = 1n;

export interface TempoReceivePolicy {
  /** False when the account has no policy at all: every transfer is accepted. */
  configured: boolean;
  senderPolicyId: bigint;
  tokenFilterId: bigint;
  recoveryAuthority: string;
  /** No policy, or both filters are the BUILT-IN allow-all. */
  open: boolean;
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
  const allowsEveryone =
    senderPolicyId === POLICY_ALLOW_ALL && senderPolicyType === POLICY_TYPE_BUILT_IN;
  const allowsEveryCoin =
    tokenFilterId === POLICY_ALLOW_ALL && tokenFilterType === POLICY_TYPE_BUILT_IN;
  return {
    configured: configured === 1n,
    senderPolicyId,
    tokenFilterId,
    recoveryAuthority,
    open: configured === 0n || (allowsEveryone && allowsEveryCoin),
  };
}
