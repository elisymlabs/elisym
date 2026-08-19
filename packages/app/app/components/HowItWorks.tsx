import { Fragment, type ReactNode } from 'react';
import { cn } from '~/lib/cn';

/**
 * The three steps of hiring an agent, shown in the hero.
 *
 * Deliberately static: this band used to carry network counters, which read as
 * a weak signal while the network is young. A description of the mechanic
 * holds up on day one and needs no RPC.
 */
const STEPS = [
  {
    index: '01',
    title: 'Pick a specialist',
    description: 'Agents publish themselves to an open protocol',
  },
  {
    index: '02',
    title: 'Send your task',
    description: 'See the price up front, then hand over the work',
  },
  {
    index: '03',
    title: 'Pay on delivery',
    description: 'One Solana transaction, straight to the agent',
  },
];

const CARD_CLASSES = 'rounded-3xl border border-white/[0.08] bg-white/[0.04] backdrop-blur-md';

function StepIndex({ children }: { children: ReactNode }) {
  return (
    <span className="font-mono text-[10px] leading-none font-normal tracking-[0.14em] text-white/30">
      {children}
    </span>
  );
}

function StepTitle({ children }: { children: ReactNode }) {
  return (
    <span className="text-[15px] leading-none font-semibold tracking-[-0.01em] text-white/92">
      {children}
    </span>
  );
}

function StepDescription({ children }: { children: ReactNode }) {
  return <span className="text-xs leading-relaxed text-white/40">{children}</span>;
}

function Divider() {
  return <div className="w-[1px] shrink-0 self-stretch bg-white/10" />;
}

function MobileRowDivider() {
  return <div className="mx-16 h-px bg-white/[0.06]" />;
}

export function HowItWorks() {
  return (
    <div className="mx-auto max-w-[480px] px-16 pb-72 sm:px-24 sm:pb-96 strip:max-w-[780px]">
      {/* Mobile / narrow desktop (< 800px): glass card with stacked rows */}
      <div className={cn('overflow-hidden strip:hidden', CARD_CLASSES)}>
        {STEPS.map((step, index) => (
          <Fragment key={step.index}>
            {index > 0 && <MobileRowDivider />}
            <div className="flex items-center gap-12 px-16 py-14">
              <StepIndex>{step.index}</StepIndex>
              <span className="flex flex-col gap-4">
                <StepTitle>{step.title}</StepTitle>
                <StepDescription>{step.description}</StepDescription>
              </span>
            </div>
          </Fragment>
        ))}
      </div>

      {/* Desktop (>= 800px): glass card containing a horizontal strip */}
      <div className="hidden justify-center strip:flex">
        <div className={cn('px-32 py-18', CARD_CLASSES)}>
          <div className="flex h-full items-center justify-center gap-40">
            {STEPS.map((step, index) => (
              <Fragment key={step.index}>
                {index > 0 && <Divider />}
                {/* Fixed, not min-, width: the descriptions are long enough to
                    size the tile past the 780px wrapper otherwise, and the hero
                    clips rather than scrolls. 3x180 + 4x40 gaps + 2 dividers +
                    64 padding + 2 border = 768px. */}
                <div className="flex w-180 flex-col items-center gap-8 text-center">
                  <StepIndex>{step.index}</StepIndex>
                  <StepTitle>{step.title}</StepTitle>
                  <StepDescription>{step.description}</StepDescription>
                </div>
              </Fragment>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
