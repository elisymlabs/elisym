import Decimal from 'decimal.js-light';
import { useState, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useStats } from '~/hooks/useStats';
import { useTweenedNumber } from '~/hooks/useTweenedNumber';
import { UsdcIcon } from './UsdcIcon';

const ON_CHAIN_TOOLTIP_TEXT =
  'Live on-chain counter updated by the elisym client SDK alongside each payment.';

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
    <div className="flex h-90 min-w-180 flex-col items-center justify-center gap-8">
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
    <span className="text-xl leading-none font-semibold tracking-[-0.02em] whitespace-nowrap text-white/92 tabular-nums sm:text-2xl">
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

  const tweenedJobs = useTweenedNumber(data?.jobCount);
  const tweenedUsdcMicro = useTweenedNumber(data?.totalUsdcMicro);

  const jobCount = data ? formatCount(Math.round(tweenedJobs)) : '-';
  const usdcVolume = data ? withCommas(new Decimal(tweenedUsdcMicro).div(1e6).toFixed(2)) : '-';

  return (
    <div className="mx-auto max-w-[480px] px-16 pb-72 sm:px-24 sm:pb-96 stats:max-w-[780px]">
      {/* Mobile / narrow desktop (< 800px): glass card with stacked rows */}
      <div className="overflow-hidden rounded-3xl border border-white/[0.08] bg-white/[0.04] backdrop-blur-md stats:hidden">
        {isLoading ? (
          <>
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
              icon={<UsdcIcon className="size-14" />}
              label="USDC Volume"
              value={usdcVolume}
              tooltipText={ON_CHAIN_TOOLTIP_TEXT}
            />
          </>
        )}
      </div>

      {/* Desktop (>= 800px): glass card containing horizontal stat strip */}
      <div className="hidden justify-center stats:flex">
        <div className="h-90 rounded-3xl border border-white/[0.08] bg-white/[0.04] px-32 backdrop-blur-md">
          <div className="flex h-full items-center justify-center gap-40">
            {isLoading ? (
              <>
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
                  value={usdcVolume}
                  label="USDC Volume"
                  icon={<UsdcIcon className="size-14" />}
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
