import Decimal from 'decimal.js-light';
import { useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { useStats } from '~/hooks/useStats';

const TOOLTIP_TEXT =
  'Data is collected from decentralized Nostr relays. Each relay stores a partial view of the network, so the actual numbers may be higher.';

const STAT_ICONS: Record<string, ReactElement> = {
  Agents: (
    <svg
      aria-hidden
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="7" y="7" width="10" height="10" rx="2" />
      <path d="M9 3v2M12 3v2M15 3v2M9 19v2M12 19v2M15 19v2M3 9h2M3 12h2M3 15h2M19 9h2M19 12h2M19 15h2" />
    </svg>
  ),
  'Completed Jobs': (
    <svg
      aria-hidden
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  ),
};

function StatSkeleton({ width }: { width: number }) {
  return (
    <div className="flex flex-col items-center gap-8">
      <div className="h-28 animate-pulse rounded-lg bg-white/10" style={{ width: `${width}px` }} />
      <div
        className="h-10 animate-pulse rounded-full bg-white/7"
        style={{ width: `${width * 0.7}px` }}
      />
    </div>
  );
}

function InfoTooltip({ text }: { text: string }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  return (
    <span
      className="relative ml-4 inline-flex cursor-default align-middle"
      onMouseEnter={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        setPos({ x: rect.left + rect.width / 2, y: rect.top });
      }}
      onMouseLeave={() => setPos(null)}
    >
      <svg
        aria-hidden
        className="size-14 text-white/35"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z"
        />
      </svg>
      {pos &&
        createPortal(
          <span
            style={{ left: pos.x, top: pos.y - 8 }}
            className="pointer-events-none fixed z-[9999] max-w-[240px] -translate-x-1/2 -translate-y-full rounded-2xl bg-surface px-16 py-12 text-xs leading-relaxed text-text/60 shadow-tooltip"
          >
            {text}
            <svg
              aria-hidden
              className="absolute top-full left-1/2 -mt-px -translate-x-1/2"
              width="14"
              height="8"
              viewBox="0 0 14 8"
              fill="white"
            >
              <path d="M0 0 L5.5 6.4 Q7 7.8 8.5 6.4 L14 0 Z" />
            </svg>
          </span>,
          document.body,
        )}
    </span>
  );
}

function StatValue({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-2xl font-semibold tracking-[-0.02em] text-white/92">{children}</span>
  );
}

function StatLabel({ icon, label }: { icon: ReactElement | null; label: string }) {
  return (
    <span className="flex items-center gap-4">
      <div className="flex items-center gap-4 text-white/35">
        {icon && <span className="flex">{icon}</span>}
        <span className="font-sans text-xs font-medium">{label}</span>
      </div>
      <InfoTooltip text={TOOLTIP_TEXT} />
    </span>
  );
}

function StatItem({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="flex flex-col items-center gap-4">
      <StatValue>{value}</StatValue>
      <StatLabel icon={STAT_ICONS[label] ?? null} label={label} />
    </div>
  );
}

function Divider() {
  return <div className="h-32 w-[1px] bg-white/10" />;
}

export function StatsBar() {
  const { data, isLoading } = useStats();

  const agentCount = data?.totalAgentCount ?? '-';
  const jobCount = data?.jobCount ?? '-';
  const volume = data ? `${new Decimal(data.totalLamports).div(1e9).toFixed(2)} SOL` : '-';

  return (
    <div className="mx-auto max-w-3xl px-24 pb-96">
      <div className="flex items-center justify-center gap-40">
        {isLoading ? (
          <>
            <StatSkeleton width={56} />
            <Divider />
            <StatSkeleton width={80} />
            <Divider />
            <StatSkeleton width={96} />
          </>
        ) : (
          <>
            <StatItem value={agentCount} label="Agents" />
            <Divider />
            <StatItem value={jobCount} label="Completed Jobs" />
            <Divider />
            <div className="flex flex-col items-center gap-4">
              <StatValue>{volume}</StatValue>
              <span className="flex items-center gap-4">
                <div className="flex items-center gap-4 text-white/35">
                  <span className="text-[13px] leading-none">◎</span>
                  <span className="font-sans text-xs font-medium">Volume</span>
                </div>
                <InfoTooltip text={TOOLTIP_TEXT} />
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
