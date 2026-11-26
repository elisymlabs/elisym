import { parseCaip19 } from '@elisym/commerce';

/** A coin as the merchant reads it (`USDC on Base`), or undefined for an id the registry does not know. */
export function coinLabel(caip19: string): string | undefined {
  const parsed = parseCaip19(caip19);
  if (parsed === undefined) {
    return undefined;
  }
  const chain =
    parsed.chain.chainName ?? (parsed.chain.family === 'solana' ? 'Solana' : parsed.caip2);
  return `${parsed.asset.symbol} on ${chain}`;
}
