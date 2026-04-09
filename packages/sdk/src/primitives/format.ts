import Decimal from 'decimal.js-light';
import { LAMPORTS_PER_SOL } from '../constants';

export function formatSol(lamports: number): string {
  const sol = new Decimal(lamports).div(LAMPORTS_PER_SOL);
  if (sol.gte(1_000_000)) {
    return `${sol.idiv(1_000_000)}m SOL`;
  }
  if (sol.gte(10_000)) {
    return `${sol.idiv(1_000)}k SOL`;
  }
  return `${compactSol(sol)} SOL`;
}

/** Format a SOL Decimal - show enough decimals so the value isn't lost. */
function compactSol(sol: Decimal): string {
  if (sol.isZero()) {
    return '0';
  }
  if (sol.gte(1000)) {
    return sol.toDecimalPlaces(0, Decimal.ROUND_FLOOR).toString();
  }
  // Show enough decimals so the rounded value equals the original
  const maxFrac = 9; // lamport precision
  for (let d = 1; d <= maxFrac; d++) {
    const s = sol.toFixed(d);
    if (new Decimal(s).eq(sol)) {
      return s.replace(/0+$/, '').replace(/\.$/, '');
    }
  }
  return sol.toFixed(maxFrac).replace(/0+$/, '').replace(/\.$/, '');
}

export function timeAgo(unix: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - unix));
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function truncateKey(hex: string, chars = 6): string {
  if (hex.length <= chars * 2) {
    return hex;
  }
  return `${hex.slice(0, chars)}...${hex.slice(-chars)}`;
}
