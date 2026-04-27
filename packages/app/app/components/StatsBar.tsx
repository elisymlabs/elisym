import Decimal from 'decimal.js-light';
import { useId, useState, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useStats } from '~/hooks/useStats';

const ON_CHAIN_TOOLTIP_TEXT =
  'Aggregated from every elisym payment transaction on Solana, indexed by the on-chain protocol tag attached to each transfer.';

const TOOLTIP_MAX_WIDTH = 240;
const TOOLTIP_EDGE_MARGIN = 12;

const COMPLETED_JOBS_ICON: ReactElement = (
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
);

const SOL_ICON: ReactElement = (
  <svg aria-hidden width="16" height="16" viewBox="0 0 397.7 311.7" fill="currentColor">
    <path d="M64.6 237.9c2.4-2.4 5.7-3.8 9.2-3.8h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1l62.7-62.7zM64.6 3.8C67.1 1.4 70.4 0 73.8 0h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1L64.6 3.8zM333.1 120.1c-2.4-2.4-5.7-3.8-9.2-3.8H6.5c-5.8 0-8.7 7-4.6 11.1l62.7 62.7c2.4 2.4 5.7 3.8 9.2 3.8h317.4c5.8 0 8.7-7 4.6-11.1l-62.7-62.6z" />
  </svg>
);

const USDC_DOLLAR_PATH =
  'M15.05 8.4c-2.32.34-3.86 1.92-3.86 4.05 0 2.45 1.55 3.62 4.83 4.21 2.07.42 2.62.86 2.62 1.95 0 .97-.85 1.65-2 1.65-1.45 0-1.97-.62-2.16-1.55-.05-.18-.21-.3-.4-.3h-.92c-.23 0-.4.18-.4.4v.04c.21 1.65 1.5 2.84 3.4 3.16v1.5c0 .23.14.4.36.4h.86c.23 0 .4-.18.4-.4v-1.5c2.39-.32 4.04-1.86 4.04-4.06 0-2.5-1.59-3.7-4.94-4.27-2.23-.4-2.55-.83-2.55-1.83 0-.85.7-1.46 1.92-1.46 1.36 0 1.97.5 2.16 1.41.05.18.21.3.4.3h.92c.21 0 .4-.18.4-.4v-.05c-.23-1.55-1.45-2.7-3.27-3.04V7.06c0-.23-.14-.4-.36-.4h-.86c-.23 0-.4.18-.4.4v1.34z';

const USDC_CIRCLE_AND_ARCS_PATH =
  'M16 32C24.84 32 32 24.84 32 16S24.84 0 16 0 0 7.16 0 16s7.16 16 16 16zM2.83 16c0 5.73 3.66 10.55 8.86 12.36.4.14.8-.16.8-.6v-.92c0-.34-.18-.56-.45-.7-3.93-1.45-6.43-5.04-6.43-10.14s2.5-8.7 6.43-10.14c.27-.14.45-.36.45-.7v-.92c0-.45-.4-.74-.8-.6C6.49 5.45 2.83 10.27 2.83 16zm26.34 0c0-5.73-3.66-10.55-8.86-12.36-.4-.14-.8.16-.8.6v.92c0 .34.18.56.45.7 3.93 1.45 6.43 5.04 6.43 10.14s-2.5 8.7-6.43 10.14c-.27.14-.45.36-.45.7v.92c0 .45.4.74.8.6 5.2-1.81 8.86-6.63 8.86-12.36z';

function UsdcIcon() {
  const maskId = useId();
  return (
    <svg aria-hidden width="16" height="16" viewBox="0 0 32 32" fill="currentColor">
      <mask id={maskId}>
        <rect width="32" height="32" fill="white" />
        <path d={USDC_DOLLAR_PATH} fill="black" transform="rotate(9 16 16)" />
      </mask>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d={USDC_CIRCLE_AND_ARCS_PATH}
        mask={`url(#${maskId})`}
      />
    </svg>
  );
}

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
  icon: ReactElement;
  label: string;
  tooltipText: string;
}) {
  return (
    <span className="flex items-center justify-center gap-4">
      <div className="flex items-center justify-center gap-4 text-center text-white/35">
        <span className="flex shrink-0">{icon}</span>
        <span className="font-mono text-[10px] font-normal tracking-[0.14em] uppercase">
          {label}
        </span>
      </div>
      <span className="inline-flex">
        <InfoTooltip text={tooltipText} />
      </span>
    </span>
  );
}

function StatItem({
  value,
  label,
  icon,
  tooltipText,
}: {
  value: string;
  label: string;
  icon: ReactElement;
  tooltipText: string;
}) {
  return (
    <div className="flex min-w-180 flex-col items-center gap-8">
      <StatValue>{value}</StatValue>
      <StatLabel icon={icon} label={label} tooltipText={tooltipText} />
    </div>
  );
}

function Divider() {
  return <div className="w-[1px] shrink-0 self-stretch bg-white/10" />;
}

function MobileRowIcon({ children }: { children: ReactNode }) {
  return (
    <span className="flex size-16 shrink-0 items-center justify-center text-white/55">
      {children}
    </span>
  );
}

function MobileRowLabel({ children, tooltipText }: { children: ReactNode; tooltipText: string }) {
  return (
    <span className="flex flex-1 items-center gap-4 font-mono text-[10px] font-normal tracking-[0.14em] text-white/50 uppercase">
      <span className="truncate">{children}</span>
      <InfoTooltip text={tooltipText} />
    </span>
  );
}

function MobileStatRow({
  icon,
  label,
  value,
  tooltipText,
}: {
  icon: ReactElement;
  label: string;
  value: ReactNode;
  tooltipText: string;
}) {
  return (
    <div className="flex h-48 items-center gap-10 px-16">
      <MobileRowIcon>{icon}</MobileRowIcon>
      <MobileRowLabel tooltipText={tooltipText}>{label}</MobileRowLabel>
      <span className="text-base leading-none font-semibold tracking-[-0.02em] whitespace-nowrap text-white/95 tabular-nums">
        {value}
      </span>
    </div>
  );
}

function MobileRowDivider() {
  return <div className="mx-16 h-px bg-white/[0.06]" />;
}

function MobileRowSkeleton() {
  return (
    <div className="flex h-48 items-center gap-10 px-16">
      <div className="size-16 shrink-0 animate-pulse rounded-md bg-white/10" />
      <div className="h-10 w-96 animate-pulse rounded-full bg-white/7" />
      <div className="ml-auto h-16 w-72 animate-pulse rounded-md bg-white/10" />
    </div>
  );
}

export function StatsBar() {
  const { data, isLoading } = useStats();

  const jobCount = formatCount(data?.jobCount ?? '-');
  const solVolume = data ? withCommas(new Decimal(data.totalLamports).div(1e9).toFixed(2)) : '-';
  const usdcVolume = data ? withCommas(new Decimal(data.totalUsdcMicro).div(1e6).toFixed(2)) : '-';

  return (
    <div className="mx-auto max-w-[480px] px-16 pb-72 sm:px-24 sm:pb-96 stats:max-w-[780px]">
      {/* Mobile / narrow desktop (< 800px): glass card with stacked rows */}
      <div className="overflow-hidden rounded-3xl border border-white/[0.08] bg-white/[0.04] backdrop-blur-md stats:hidden">
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
              icon={COMPLETED_JOBS_ICON}
              label="Completed Jobs"
              value={jobCount}
              tooltipText={ON_CHAIN_TOOLTIP_TEXT}
            />
            <MobileRowDivider />
            <MobileStatRow
              icon={SOL_ICON}
              label="SOL Volume"
              value={solVolume}
              tooltipText={ON_CHAIN_TOOLTIP_TEXT}
            />
            <MobileRowDivider />
            <MobileStatRow
              icon={<UsdcIcon />}
              label="USDC Volume"
              value={usdcVolume}
              tooltipText={ON_CHAIN_TOOLTIP_TEXT}
            />
          </>
        )}
      </div>

      {/* Desktop (>= 800px): glass card containing horizontal stat strip */}
      <div className="hidden justify-center stats:flex">
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
                <StatItem
                  value={jobCount}
                  label="Completed Jobs"
                  icon={COMPLETED_JOBS_ICON}
                  tooltipText={ON_CHAIN_TOOLTIP_TEXT}
                />
                <Divider />
                <StatItem
                  value={solVolume}
                  label="SOL Volume"
                  icon={SOL_ICON}
                  tooltipText={ON_CHAIN_TOOLTIP_TEXT}
                />
                <Divider />
                <StatItem
                  value={usdcVolume}
                  label="USDC Volume"
                  icon={<UsdcIcon />}
                  tooltipText={ON_CHAIN_TOOLTIP_TEXT}
                />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
