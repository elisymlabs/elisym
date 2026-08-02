import { useLayoutEffect, useRef } from 'react';
import { MAINNET_APP_URL, SOLANA_CLUSTER, SOLANA_CLUSTER_LABEL } from '~/lib/cluster';

export function DevnetBanner() {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const node = ref.current;
    const root = document.documentElement;
    if (!node) {
      // Mainnet: the banner does not render, but the stylesheet defaults the
      // var to 56px (pre-measurement clip guard) - zero it so sticky elements
      // offset by --devnet-banner-h sit flush with the viewport bottom.
      root.style.setProperty('--devnet-banner-h', '0px');
      return () => {
        root.style.removeProperty('--devnet-banner-h');
      };
    }
    const update = () => {
      root.style.setProperty('--devnet-banner-h', `${node.offsetHeight}px`);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => {
      observer.disconnect();
      root.style.removeProperty('--devnet-banner-h');
    };
  }, []);

  // Mainnet is the production surface - no banner (D10/D11). The cluster is
  // fixed per page load, so the hook order above never changes; the effect
  // no-ops on the null ref. WalletMenu carries the reverse (Devnet) link.
  if (SOLANA_CLUSTER === 'mainnet') {
    return null;
  }

  return (
    <div ref={ref} className="sticky bottom-0 z-30 border-t border-black/7 bg-surface">
      <div className="mx-auto flex flex-wrap items-center justify-center gap-x-14 gap-y-4 px-16 py-6 sm:px-32">
        <span className="rounded-12 bg-stat-indigo-bg px-8 py-5 font-mono text-[10px] leading-none font-medium tracking-wide text-stat-indigo uppercase">
          {SOLANA_CLUSTER_LABEL}
        </span>
        <span className="text-[10px] tracking-wide text-text-2">
          Switch your wallet to {SOLANA_CLUSTER_LABEL}
        </span>
        <span className="font-mono text-[10px] tracking-wide text-text-2/70">
          Settings &rarr; Developer Settings &rarr; Testnet Mode
        </span>
        <a
          href={MAINNET_APP_URL}
          className="text-[10px] tracking-wide text-text-2 underline transition-colors hover:text-text"
        >
          Mainnet app &rarr;
        </a>
      </div>
    </div>
  );
}
