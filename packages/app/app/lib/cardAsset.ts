import {
  NATIVE_SOL,
  splAssetsForNetwork,
  type Asset,
  type CapabilityCard,
  type Network,
} from '@elisym/sdk';

type PaymentInfo = NonNullable<CapabilityCard['payment']>;

/**
 * Resolve a capability card's payment asset against the assets that exist on
 * `network`. USDC has a different mint per cluster and LSM exists on mainnet
 * only, so a flat `KNOWN_ASSETS` lookup cannot answer this - it would resolve a
 * mint-less `token: usdc` card to the wrong cluster's USDC.
 *
 * Returns `null` when this network cannot pay the card (unknown token, a chain
 * we do not settle on, a mint that is not canonical here, or a mainnet-only
 * asset on devnet). Callers treat that as "cannot interpret" rather than
 * "zero balance".
 */
export function resolvePaymentAsset(
  payment: PaymentInfo | undefined,
  network: Network,
): Asset | null {
  const token = payment?.token?.toLowerCase();
  const chain = payment?.chain ?? NATIVE_SOL.chain;
  if (chain !== NATIVE_SOL.chain) {
    return null;
  }
  if (!token || token === 'sol') {
    return NATIVE_SOL;
  }
  const cardMint = payment?.mint;
  return (
    splAssetsForNetwork(network).find(
      (asset) => asset.token === token && (cardMint === undefined || asset.mint === cardMint),
    ) ?? null
  );
}
