import type { CapabilityCard } from '@elisym/sdk';
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '~/lib/cn';
import { formatCardPrice } from '~/lib/formatPrice';
import { ProductAvatar } from './ProductAvatar';

const DESCRIPTION_TOOLTIP_MAX_WIDTH = 320;
const DESCRIPTION_TOOLTIP_EDGE_MARGIN = 12;
const DESCRIPTION_TOOLTIP_OFFSET = 8;

type TooltipPlacement = 'above' | 'below';

interface Props {
  card: CapabilityCard;
  selected: boolean;
  onClick: () => void;
}

interface TooltipPos {
  tooltipLeft: number;
  arrowLeft: number;
  anchorTop: number;
  anchorBottom: number;
  placement: TooltipPlacement;
}

interface DescriptionProps {
  text: string;
  className?: string;
}

function ProductDescription({ text, className }: DescriptionProps) {
  const ref = useRef<HTMLParagraphElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const lastPointerWasTouch = useRef(false);
  const placementAdjusted = useRef(false);
  const [pos, setPos] = useState<TooltipPos | null>(null);

  function openTooltip() {
    const element = ref.current;
    if (!element) {
      return;
    }
    if (element.scrollHeight <= element.clientHeight) {
      return;
    }
    const rect = element.getBoundingClientRect();
    const anchorCenter = rect.left + rect.width / 2;
    const viewportWidth = window.innerWidth;
    const halfWidth = DESCRIPTION_TOOLTIP_MAX_WIDTH / 2;
    const minCenter = halfWidth + DESCRIPTION_TOOLTIP_EDGE_MARGIN;
    const maxCenter = viewportWidth - halfWidth - DESCRIPTION_TOOLTIP_EDGE_MARGIN;
    const clampedCenter = Math.max(minCenter, Math.min(maxCenter, anchorCenter));
    const tooltipLeft = clampedCenter - halfWidth;
    placementAdjusted.current = false;
    setPos({
      tooltipLeft,
      arrowLeft: anchorCenter - tooltipLeft,
      anchorTop: rect.top,
      anchorBottom: rect.bottom,
      placement: 'above',
    });
  }

  function closeTooltip() {
    setPos(null);
  }

  useLayoutEffect(() => {
    if (!pos) {
      placementAdjusted.current = false;
      return;
    }
    if (placementAdjusted.current) {
      return;
    }
    placementAdjusted.current = true;
    const tip = tipRef.current;
    if (!tip) {
      return;
    }
    const tipHeight = tip.scrollHeight;
    const projectedTop = pos.anchorTop - DESCRIPTION_TOOLTIP_OFFSET - tipHeight;
    if (projectedTop < DESCRIPTION_TOOLTIP_EDGE_MARGIN) {
      const viewportHeight = window.innerHeight;
      const spaceBelow =
        viewportHeight -
        pos.anchorBottom -
        DESCRIPTION_TOOLTIP_OFFSET -
        DESCRIPTION_TOOLTIP_EDGE_MARGIN;
      if (spaceBelow > tipHeight) {
        setPos({ ...pos, placement: 'below' });
      }
    }
  }, [pos]);

  useEffect(() => {
    if (!pos) {
      return;
    }
    function handleScroll() {
      closeTooltip();
    }
    function handleClickOutside(event: globalThis.MouseEvent) {
      const desc = ref.current;
      const target = event.target;
      if (!(target instanceof Node) || !desc) {
        return;
      }
      if (desc.contains(target)) {
        return;
      }
      closeTooltip();
    }
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleScroll);
    document.addEventListener('click', handleClickOutside);
    return () => {
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleScroll);
      document.removeEventListener('click', handleClickOutside);
    };
  }, [pos]);

  function handlePointerEnter(event: PointerEvent<HTMLParagraphElement>) {
    if (event.pointerType === 'touch') {
      lastPointerWasTouch.current = true;
      return;
    }
    lastPointerWasTouch.current = false;
    openTooltip();
  }

  function handlePointerLeave(event: PointerEvent<HTMLParagraphElement>) {
    if (event.pointerType === 'touch') {
      return;
    }
    closeTooltip();
  }

  function handleClick() {
    if (!lastPointerWasTouch.current) {
      return;
    }
    if (pos) {
      closeTooltip();
    } else {
      openTooltip();
    }
  }

  return (
    <>
      <p
        ref={ref}
        className={className}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
        onClick={handleClick}
      >
        {text}
      </p>
      {pos &&
        createPortal(
          <span
            ref={tipRef}
            style={{
              left: pos.tooltipLeft,
              top:
                pos.placement === 'above'
                  ? pos.anchorTop - DESCRIPTION_TOOLTIP_OFFSET
                  : pos.anchorBottom + DESCRIPTION_TOOLTIP_OFFSET,
              width: DESCRIPTION_TOOLTIP_MAX_WIDTH,
            }}
            className={cn(
              'pointer-events-none fixed z-[9999]',
              pos.placement === 'above' && '-translate-y-full',
            )}
          >
            <span
              className={cn(
                'tooltip-in block rounded-2xl bg-surface px-16 py-12 text-[13px] leading-relaxed text-text-2 shadow-tooltip',
                pos.placement === 'above' ? 'origin-bottom' : 'origin-top',
              )}
            >
              {text}
              <svg
                aria-hidden
                className={cn(
                  'absolute -translate-x-1/2',
                  pos.placement === 'above' ? 'top-full -mt-px' : 'bottom-full -mb-px rotate-180',
                )}
                style={{ left: pos.arrowLeft }}
                width="14"
                height="8"
                viewBox="0 0 14 8"
                fill="white"
              >
                <path d="M0 0 L5.5 6.4 Q7 7.8 8.5 6.4 L14 0 Z" />
              </svg>
            </span>
          </span>,
          document.body,
        )}
    </>
  );
}

export function ProductCard({ card, selected, onClick }: Props) {
  const price = card.payment?.job_price;
  const hasPrice = price !== null && price !== undefined;
  const isFree = price === 0;
  const formattedPrice = hasPrice && !isFree ? formatCardPrice(card.payment, price) : null;

  return (
    <div
      onClick={onClick}
      className={cn(
        'group flex cursor-pointer flex-col overflow-hidden rounded-3xl border bg-surface shadow-[0_2px_8px_rgba(0,0,0,0.06),0_1px_2px_rgba(0,0,0,0.04)] transition-all',
        selected
          ? 'border-black/14 shadow-[0_0_0_4px_rgba(0,0,0,0.05),0_2px_8px_rgba(0,0,0,0.06),0_1px_2px_rgba(0,0,0,0.04)]'
          : 'border-black/7 hover:-translate-y-2 hover:shadow-lg',
      )}
    >
      {card.image && (
        <div className="relative h-180 w-full overflow-hidden rounded-b-2xl bg-surface-2">
          <img
            src={card.image}
            alt={card.name}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
          <span
            className={cn(
              'absolute top-12 right-12 flex size-24 items-center justify-center rounded-full transition-all',
              selected
                ? 'bg-surface-dark text-white shadow-[0_2px_6px_rgba(0,0,0,0.2)]'
                : 'bg-white/70 ring-1 ring-black/10 backdrop-blur-md ring-inset group-hover:bg-white',
            )}
          >
            {selected && (
              <svg
                aria-hidden
                className="size-14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
          </span>
        </div>
      )}

      <div className="flex flex-1 flex-col gap-16 p-20">
        <div className="flex items-start justify-between gap-12">
          <div className="flex min-w-0 items-center gap-12">
            {!card.image && <ProductAvatar name={card.name} size={40} />}
            <div className="min-w-0">
              <div className="line-clamp-1 text-sm font-bold">{card.name}</div>
            </div>
          </div>
          {!card.image && (
            <span
              className={cn(
                'flex size-20 shrink-0 items-center justify-center rounded-full transition-all',
                selected ? 'bg-surface-dark text-white' : 'ring-1 ring-black/15 ring-inset',
              )}
            >
              {selected && (
                <svg
                  aria-hidden
                  className="size-12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              )}
            </span>
          )}
        </div>

        {card.description && (
          <ProductDescription
            text={card.description}
            className={cn(
              'm-0 line-clamp-5 text-[13px] leading-relaxed text-text-2',
              card.image && '-mt-8',
            )}
          />
        )}

        {card.capabilities.length > 0 && (
          <div className="flex flex-wrap items-center gap-6">
            {card.capabilities.slice(0, 3).map((tag) => (
              <span
                key={tag}
                className="inline-flex h-24 items-center rounded-full bg-tag-bg px-10 font-mono text-[11px] leading-none font-medium tracking-wide text-text-2 uppercase"
              >
                {tag}
              </span>
            ))}
            {card.capabilities.length > 3 && (
              <span className="text-[11px] text-text-2 opacity-50">
                +{card.capabilities.length - 3}
              </span>
            )}
          </div>
        )}
      </div>

      {hasPrice && (
        <div className="px-20 pb-16">
          <div className="flex items-center justify-between border-t border-black/6 pt-12 text-sm">
            <div>
              <span className="font-bold">{isFree ? 'Free' : formattedPrice}</span>
              <span className="ml-4 text-text-2">/ task</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
