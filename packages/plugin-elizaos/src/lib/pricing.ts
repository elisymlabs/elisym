import { LAMPORTS_PER_SOL } from '@elisym/sdk';

const LAMPORTS_PER_SOL_BIG = BigInt(LAMPORTS_PER_SOL);

export function solToLamports(sol: string | number): bigint {
  const asNumber = typeof sol === 'string' ? Number(sol) : sol;
  if (!Number.isFinite(asNumber) || asNumber < 0) {
    throw new Error(`Invalid SOL amount: ${sol}`);
  }
  return BigInt(Math.round(asNumber * LAMPORTS_PER_SOL));
}

export function lamportsToSol(lamports: bigint): number {
  return Number(lamports) / LAMPORTS_PER_SOL;
}

export function formatLamportsAsSol(lamports: bigint, precision = 9): string {
  return lamportsToSol(lamports).toFixed(precision).replace(/0+$/, '').replace(/\.$/, '');
}

export { LAMPORTS_PER_SOL_BIG };
