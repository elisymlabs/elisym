import {
  type FeeRail,
  type FeeTerms,
  type Network,
  FeeConfigError,
  readFeeTerms,
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
 * Throws for a chain with no fee config.
 */
export function feeTermsSourceFor(chain: string): FeeTermsSource {
  return {
    network: solanaConfigNetworkFor(chain),
    rail: chain.startsWith('eip155:') ? 'tempo' : 'solana',
  };
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
