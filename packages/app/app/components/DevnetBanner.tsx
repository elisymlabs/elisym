export function DevnetBanner() {
  return (
    <div className="sticky bottom-0 z-30 border-t border-border bg-surface/90 backdrop-blur-md">
      <div className="mx-auto flex flex-wrap items-center justify-center gap-x-14 gap-y-4 px-16 py-8 sm:px-32">
        <span className="rounded-4 bg-warning/12 px-6 py-2 font-mono text-[10px] leading-none font-medium tracking-wide text-warning uppercase">
          Devnet
        </span>
        <span className="text-[10px] tracking-wide text-text-2">Switch your wallet to Devnet</span>
        <span className="font-mono text-[10px] tracking-wide text-text-2/70">
          Settings &rarr; Developer Settings &rarr; Testnet Mode
        </span>
      </div>
    </div>
  );
}
