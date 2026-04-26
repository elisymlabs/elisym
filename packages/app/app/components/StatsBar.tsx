import Decimal from 'decimal.js-light';
import { useCallback, useState, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useStats } from '~/hooks/useStats';
import { cn } from '~/lib/cn';

type VolumeCurrency = 'usdc' | 'sol';
const VOLUME_ORDER: VolumeCurrency[] = ['usdc', 'sol'];

const AGENTS_TOOLTIP_TEXT =
  'Data is collected from decentralized Nostr relays. Each relay stores a partial view of the network, so the actual numbers may be higher.';

const ON_CHAIN_TOOLTIP_TEXT =
  'Based on incoming transfers to the protocol treasury address on Solana.';

const TOOLTIP_MAX_WIDTH = 240;
const TOOLTIP_EDGE_MARGIN = 12;

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

const VOLUME_ICON: Record<VolumeCurrency, ReactElement> = {
  sol: (
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
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3.2" />
    </svg>
  ),
  usdc: (
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
      <line x1="12" y1="2" x2="12" y2="22" />
      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </svg>
  ),
};

function withCommas(decimalStr: string): string {
  const [intPart, decPart] = decimalStr.split('.');
  const formatted = (intPart ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return decPart ? `${formatted}.${decPart}` : formatted;
}

function formatCount(n: number | string): string {
  return typeof n === 'number' ? n.toLocaleString('en-US') : n;
}

function StatSkeleton() {
  return (
    <div className="flex min-w-180 flex-col items-center gap-8">
      <div className="h-28 w-96 animate-pulse rounded-lg bg-white/10" />
      <div className="h-10 w-64 animate-pulse rounded-full bg-white/7" />
    </div>
  );
}

function InfoTooltip({ text }: { text: string }) {
  const [pos, setPos] = useState<{ tooltipLeft: number; arrowLeft: number; top: number } | null>(
    null,
  );

  return (
    <span
      className="relative ml-4 inline-flex cursor-default align-middle"
      onMouseEnter={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const iconCenter = rect.left + rect.width / 2;
        const viewportWidth = window.innerWidth;
        const halfWidth = TOOLTIP_MAX_WIDTH / 2;
        const minCenter = halfWidth + TOOLTIP_EDGE_MARGIN;
        const maxCenter = viewportWidth - halfWidth - TOOLTIP_EDGE_MARGIN;
        const clampedCenter = Math.max(minCenter, Math.min(maxCenter, iconCenter));
        const tooltipLeft = clampedCenter - halfWidth;
        setPos({
          tooltipLeft,
          arrowLeft: iconCenter - tooltipLeft,
          top: rect.top,
        });
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
            style={{ left: pos.tooltipLeft, top: pos.top - 8, width: TOOLTIP_MAX_WIDTH }}
            className="pointer-events-none fixed z-[9999] -translate-y-full rounded-2xl bg-surface px-16 py-12 text-xs leading-relaxed text-text/60 shadow-tooltip"
          >
            {text}
            <svg
              aria-hidden
              className="absolute top-full -mt-px -translate-x-1/2"
              style={{ left: pos.arrowLeft }}
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

function StatValue({ children }: { children: ReactNode }) {
  return (
    <span className="text-xl leading-none font-semibold tracking-[-0.02em] whitespace-nowrap text-white/92 sm:text-2xl">
      {children}
    </span>
  );
}

function StatLabel({
  icon,
  label,
  tooltipText,
}: {
  icon: ReactElement | null;
  label: string;
  tooltipText?: string;
}) {
  return (
    <span className="flex items-center justify-center gap-4">
      <div className="flex items-center justify-center gap-4 text-center text-white/35">
        {icon && <span className="flex shrink-0">{icon}</span>}
        <span className="font-mono text-[10px] font-normal tracking-[0.14em] uppercase">
          {label}
        </span>
      </div>
      {tooltipText && (
        <span className="inline-flex">
          <InfoTooltip text={tooltipText} />
        </span>
      )}
    </span>
  );
}

function StatItem({
  value,
  label,
  tooltipText,
}: {
  value: string | number;
  label: string;
  tooltipText?: string;
}) {
  return (
    <div className="flex min-w-180 flex-col items-center gap-8">
      <StatValue>{value}</StatValue>
      <StatLabel icon={STAT_ICONS[label] ?? null} label={label} tooltipText={tooltipText} />
    </div>
  );
}

function Divider() {
  return <div className="w-[1px] shrink-0 self-stretch bg-white/10" />;
}

function VolumeArrow({ direction, onClick }: { direction: 'left' | 'right'; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={direction === 'left' ? 'Previous currency' : 'Next currency'}
      className="flex size-20 cursor-pointer items-center justify-center rounded-full border-0 bg-white/5 text-white/55 transition-colors hover:bg-white/10 hover:text-white/85"
    >
      <svg
        aria-hidden
        className="size-12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {direction === 'left' ? (
          <polyline points="15 6 9 12 15 18" />
        ) : (
          <polyline points="9 6 15 12 9 18" />
        )}
      </svg>
    </button>
  );
}

function CurrencyStack({
  currency,
  children,
}: {
  currency: VolumeCurrency;
  children: (cur: VolumeCurrency) => ReactNode;
}) {
  return (
    <span className="volume-stack tabular-nums">
      {VOLUME_ORDER.map((cur) => (
        <span
          key={cur}
          aria-hidden={cur !== currency}
          className={cn('volume-stack-item', cur === currency ? 'opacity-100' : 'opacity-0')}
        >
          {children(cur)}
        </span>
      ))}
    </span>
  );
}

function MobileRowIcon({ children }: { children: ReactNode }) {
  return (
    <span className="flex size-16 shrink-0 items-center justify-center text-white/55">
      {children}
    </span>
  );
}

function MobileRowLabel({ children, tooltipText }: { children: ReactNode; tooltipText?: string }) {
  return (
    <span className="flex flex-1 items-center gap-4 font-mono text-[10px] font-normal tracking-[0.14em] text-white/50 uppercase">
      <span className="truncate">{children}</span>
      {tooltipText && <InfoTooltip text={tooltipText} />}
    </span>
  );
}

function MobileStatRow({
  icon,
  label,
  value,
  tooltipText,
}: {
  icon: ReactElement | null;
  label: string;
  value: ReactNode;
  tooltipText?: string;
}) {
  return (
    <div className="flex items-center gap-10 px-16 py-14">
      <MobileRowIcon>{icon}</MobileRowIcon>
      <MobileRowLabel tooltipText={tooltipText}>{label}</MobileRowLabel>
      <span className="text-xl leading-none font-semibold tracking-[-0.02em] whitespace-nowrap text-white/95 tabular-nums">
        {value}
      </span>
    </div>
  );
}

function MobileVolumeRow({
  currency,
  volumes,
  cycleCurrency,
}: {
  currency: VolumeCurrency;
  volumes: Record<VolumeCurrency, string>;
  cycleCurrency: (delta: number) => void;
}) {
  return (
    <div className="flex items-center gap-10 px-16 py-14">
      <MobileRowIcon>
        <CurrencyStack currency={currency}>{(cur) => VOLUME_ICON[cur]}</CurrencyStack>
      </MobileRowIcon>
      <MobileRowLabel tooltipText={ON_CHAIN_TOOLTIP_TEXT}>Volume</MobileRowLabel>
      <div className="flex items-center gap-6">
        <VolumeArrow direction="left" onClick={() => cycleCurrency(-1)} />
        <span className="text-xl leading-none font-semibold tracking-[-0.02em] whitespace-nowrap text-white/95">
          <CurrencyStack currency={currency}>{(cur) => volumes[cur]}</CurrencyStack>
        </span>
        <VolumeArrow direction="right" onClick={() => cycleCurrency(1)} />
      </div>
    </div>
  );
}

function MobileRowDivider() {
  return <div className="mx-16 h-px bg-white/[0.06]" />;
}

function MobileRowSkeleton() {
  return (
    <div className="flex items-center gap-10 px-16 py-14">
      <div className="size-16 shrink-0 animate-pulse rounded-md bg-white/10" />
      <div className="h-10 w-96 animate-pulse rounded-full bg-white/7" />
      <div className="ml-auto h-16 w-72 animate-pulse rounded-md bg-white/10" />
    </div>
  );
}

export function StatsBar() {
  const { data, isLoading } = useStats();
  const [currency, setCurrency] = useState<VolumeCurrency>('usdc');

  const cycleCurrency = useCallback((delta: number) => {
    setCurrency((cur) => {
      const idx = VOLUME_ORDER.indexOf(cur);
      const next = (idx + delta + VOLUME_ORDER.length) % VOLUME_ORDER.length;
      return VOLUME_ORDER[next] ?? cur;
    });
  }, []);

  const agentCount = formatCount(data?.totalAgentCount ?? '-');
  const jobCount = formatCount(data?.jobCount ?? '-');

  const volumes: Record<VolumeCurrency, string> = data
    ? {
        usdc: `${withCommas(new Decimal(data.totalUsdcMicro).div(1e6).toFixed(2))} USDC`,
        sol: `${withCommas(new Decimal(data.totalLamports).div(1e9).toFixed(2))} SOL`,
      }
    : { usdc: '-', sol: '-' };

  return (
    <div className="mx-auto max-w-3xl px-16 pb-72 sm:px-24 sm:pb-96">
      {/* Mobile: glass card with stacked rows */}
      <div className="overflow-hidden rounded-3xl border border-white/[0.08] bg-white/[0.04] backdrop-blur-md sm:hidden">
        {isLoading ? (
          <>
            <MobileRowSkeleton />
            <MobileRowDivider />
            <MobileRowSkeleton />
            <MobileRowDivider />
            <MobileRowSkeleton />
          </>
        ) : (
          <>
            <MobileStatRow
              icon={STAT_ICONS.Agents ?? null}
              label="Agents"
              value={agentCount}
              tooltipText={AGENTS_TOOLTIP_TEXT}
            />
            <MobileRowDivider />
            <MobileStatRow
              icon={STAT_ICONS['Completed Jobs'] ?? null}
              label="Completed Jobs"
              value={jobCount}
              tooltipText={ON_CHAIN_TOOLTIP_TEXT}
            />
            <MobileRowDivider />
            <MobileVolumeRow currency={currency} volumes={volumes} cycleCurrency={cycleCurrency} />
          </>
        )}
      </div>

      {/* Desktop: glass card containing horizontal stat strip */}
      <div className="hidden justify-center sm:flex">
        <div className="rounded-3xl border border-white/[0.08] bg-white/[0.04] px-32 py-20 backdrop-blur-md">
          <div className="flex items-center justify-center gap-40">
            {isLoading ? (
              <>
                <StatSkeleton />
                <Divider />
                <StatSkeleton />
                <Divider />
                <StatSkeleton />
              </>
            ) : (
              <>
                <StatItem value={agentCount} label="Agents" tooltipText={AGENTS_TOOLTIP_TEXT} />
                <Divider />
                <StatItem
                  value={jobCount}
                  label="Completed Jobs"
                  tooltipText={ON_CHAIN_TOOLTIP_TEXT}
                />
                <Divider />
                <div className="flex min-w-180 flex-col items-center gap-8">
                  <div className="flex items-center justify-center gap-8">
                    <VolumeArrow direction="left" onClick={() => cycleCurrency(-1)} />
                    <StatValue>
                      <CurrencyStack currency={currency}>{(cur) => volumes[cur]}</CurrencyStack>
                    </StatValue>
                    <VolumeArrow direction="right" onClick={() => cycleCurrency(1)} />
                  </div>
                  <span className="flex items-center justify-center gap-4">
                    <div className="flex items-center justify-center gap-4 text-center text-white/35">
                      <CurrencyStack currency={currency}>{(cur) => VOLUME_ICON[cur]}</CurrencyStack>
                      <span className="font-mono text-[10px] font-normal tracking-[0.14em] uppercase">
                        Volume
                      </span>
                    </div>
                    <span className="inline-flex">
                      <InfoTooltip text={ON_CHAIN_TOOLTIP_TEXT} />
                    </span>
                  </span>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
