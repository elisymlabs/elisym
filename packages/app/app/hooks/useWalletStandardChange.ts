import { useWallet } from '@solana/wallet-adapter-react';
import { useEffect, useRef } from 'react';

interface StandardEventsFeature {
  on(event: 'change', listener: () => void): () => void;
}

function getEventsFeature(adapter: unknown): StandardEventsFeature | null {
  if (typeof adapter !== 'object' || adapter === null) {
    return null;
  }
  if ((adapter as { standard?: unknown }).standard !== true) {
    return null;
  }
  const wallet = (adapter as { wallet?: unknown }).wallet;
  if (typeof wallet !== 'object' || wallet === null) {
    return null;
  }
  const feature = (wallet as { features?: Record<string, unknown> }).features?.['standard:events'];
  if (typeof feature !== 'object' || feature === null) {
    return null;
  }
  if (typeof (feature as { on?: unknown }).on !== 'function') {
    return null;
  }
  return feature as StandardEventsFeature;
}

/**
 * Subscribe to the connected Wallet Standard wallet's `standard:events`
 * 'change' feed. Fires when the wallet mutates accounts, chains, or features
 * (e.g. user toggles Phantom's Testnet Mode, switches active account, grants
 * a new feature).
 *
 * The callback is read through a ref so callers can pass an inline arrow
 * without churning the underlying subscription on every render.
 *
 * No-op for non-Wallet-Standard adapters (legacy fallbacks).
 */
export function useWalletStandardChange(callback: () => void): void {
  const { wallet, connected } = useWallet();
  const callbackRef = useRef(callback);
  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    if (!connected || !wallet) {
      return;
    }
    const feature = getEventsFeature(wallet.adapter);
    if (!feature) {
      return;
    }
    const off = feature.on('change', () => callbackRef.current());
    return off;
  }, [connected, wallet]);
}
