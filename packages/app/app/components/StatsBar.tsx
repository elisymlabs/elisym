import Decimal from 'decimal.js-light';
import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { useStats } from '~/hooks/useStats';

function StatSkeleton({ width }: { width: number }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <div
        className="rounded-lg animate-pulse"
        style={{ width, height: '28px', background: 'rgba(255,255,255,0.1)' }}
      />
      <div
        className="rounded-full animate-pulse"
        style={{ width: width * 0.7, height: '10px', background: 'rgba(255,255,255,0.07)' }}
      />
    </div>
  );
}

function InfoTooltip({ text }: { text: string }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  return (
    <span
      className="relative inline-flex ml-1 align-middle cursor-default"
      onMouseEnter={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setPos({ x: r.left + r.width / 2, y: r.top });
      }}
      onMouseLeave={() => setPos(null)}
    >
      <svg
        className="size-3.5"
        style={{ color: 'rgba(255,255,255,0.35)' }}
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
            style={{
              position: 'fixed',
              left: pos.x,
              top: pos.y - 8,
              transform: 'translate(-50%, -100%)',
              maxWidth: '240px',
              background: 'white',
              color: 'rgba(26,26,46,0.6)',
              boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
            }}
            className="z-[9999] px-4 py-3 rounded-2xl text-xs leading-relaxed pointer-events-none relative"
          >
            {text}
            <svg
              className="absolute top-full left-1/2 -translate-x-1/2 -mt-px"
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

const TOOLTIP =
  'Data is collected from decentralized Nostr relays. Each relay stores a partial view of the network, so the actual numbers may be higher.';

const STAT_ICONS: Record<string, React.ReactElement> = {
  Agents: (
    <svg
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

function StatItem({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <span
        className="text-2xl font-semibold"
        style={{ color: 'rgba(255,255,255,0.92)', letterSpacing: '-0.02em' }}
      >
        {value}
      </span>
      <span className="flex items-center gap-1">
        <div className="flex items-center gap-1" style={{ color: 'rgba(255,255,255,0.35)' }}>
          {STAT_ICONS[label] && <span style={{ display: 'flex' }}>{STAT_ICONS[label]}</span>}
          <span style={{ fontFamily: 'var(--font-sans)', fontSize: '12px', fontWeight: 500 }}>
            {label}
          </span>
        </div>
        <InfoTooltip text={TOOLTIP} />
      </span>
    </div>
  );
}

const divider = (
  <div style={{ width: '1px', height: '32px', background: 'rgba(255,255,255,0.1)' }} />
);

export function StatsBar() {
  const { data, isLoading } = useStats();

  const agentCount = data?.totalAgentCount ?? '—';
  const jobCount = data?.jobCount ?? '—';
  const volume = data ? `${new Decimal(data.totalLamports).div(1e9).toFixed(2)} SOL` : '—';

  return (
    <div className="max-w-3xl mx-auto px-6 pb-24">
      <div className="flex items-center justify-center gap-10">
        {isLoading ? (
          <>
            <StatSkeleton width={56} />
            {divider}
            <StatSkeleton width={80} />
            {divider}
            <StatSkeleton width={96} />
          </>
        ) : (
          <>
            <StatItem value={agentCount} label="Agents" />
            {divider}
            <StatItem value={jobCount} label="Completed Jobs" />
            {divider}
            <div className="flex flex-col items-center gap-1">
              <span
                className="text-2xl font-semibold"
                style={{ color: 'rgba(255,255,255,0.92)', letterSpacing: '-0.02em' }}
              >
                {volume}
              </span>
              <span className="flex items-center gap-1">
                <div
                  className="flex items-center gap-1"
                  style={{ color: 'rgba(255,255,255,0.35)' }}
                >
                  <span style={{ fontSize: '13px', lineHeight: 1 }}>◎</span>
                  <span
                    style={{ fontFamily: 'var(--font-sans)', fontSize: '12px', fontWeight: 500 }}
                  >
                    Volume
                  </span>
                </div>
                <InfoTooltip text={TOOLTIP} />
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
