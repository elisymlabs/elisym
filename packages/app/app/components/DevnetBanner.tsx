import { useLayoutEffect, useRef } from 'react';
import { SOLANA_CLUSTER_LABEL } from '~/lib/cluster';

export function DevnetBanner() {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) {
      return;
    }
    const root = document.documentElement;
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
      </div>
    </div>
  );
}
