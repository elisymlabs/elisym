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

export interface TempoReceivePolicy {
  /** False when the account has no policy at all: every transfer is accepted. */
  configured: boolean;
  senderPolicyId: bigint;
  tokenFilterId: bigint;
  recoveryAuthority: string;
  /** No policy, or both filters are the built-in allow-all. */
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
  const tokenFilterId = readUint256(words?.[3]);
  const recoveryAuthority = readAddressWord(words?.[5]);
  if (
    configured === null ||
    senderPolicyId === null ||
    tokenFilterId === null ||
    recoveryAuthority === null ||
    configured > 1n
  ) {
    return null;
  }
  return {
    configured: configured === 1n,
    senderPolicyId,
    tokenFilterId,
    recoveryAuthority,
    open:
      configured === 0n ||
      (senderPolicyId === POLICY_ALLOW_ALL && tokenFilterId === POLICY_ALLOW_ALL),
  };
}
