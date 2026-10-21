import {
  type FeeRail,
  type FeeTerms,
  type Network,
  FeeConfigError,
  chainByCaip2,
  readFeeTerms,
  settlementOf,
  solanaConfigNetworkFor,
} from '@elisym/pay-core';

/** Where a chain's fee terms are read: the Solana config network, and the rail's treasury in it. */
export interface FeeTermsSource {
  network: Network;
  rail: FeeRail;
}

/**
 * The fee terms source of a chain (CAIP-2): a Solana chain reads its own
 * network's config for the Solana treasury; a Tempo chain reads its paired
 * network's (mainnet -> mainnet, Moderato -> devnet) for the EVM treasury.
 * Throws for a chain with no fee config, and for an `eip3009` chain (Ethereum,
 * Arbitrum, Base), which this widget does not pay on yet: its rail is the
 * chain's `settlement`, never the CAIP-2 prefix.
 */
export function feeTermsSourceFor(chain: string): FeeTermsSource {
  const network = solanaConfigNetworkFor(chain);
  const known = chainByCaip2(chain);
  const rail = known === undefined ? undefined : settlementOf(known);
  if (rail !== 'solana' && rail !== 'tempo') {
    throw new Error('No fee terms are read for that chain here.');
  }
  return { network, rail };
}

type FeeTermsRpc = Parameters<typeof readFeeTerms>[0];

/**
 * The protocol fee terms of a chain, read fresh from the Solana config of its
 * paired network (Tempo mainnet reads Solana mainnet's): over this widget's own
 * Solana RPC of that network. A build without one cannot read them.
 */
export function feeTermsReader(
  rpcFor: (network: Network) => FeeTermsRpc | undefined,
  read: typeof readFeeTerms = readFeeTerms,
): (chain: string) => Promise<FeeTerms> {
  return (chain) => {
    const { network, rail } = feeTermsSourceFor(chain);
    const rpc = rpcFor(network);
    if (rpc === undefined) {
      return Promise.reject(
        new FeeConfigError('unavailable', `No Solana ${network} RPC to read the fee terms from.`),
      );
    }
    return read(rpc, network, rail);
  };
}
