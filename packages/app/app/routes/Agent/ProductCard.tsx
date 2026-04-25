import type { CapabilityCard } from '@elisym/sdk';
import { cn } from '~/lib/cn';
import { formatCardPrice } from '~/lib/formatPrice';
import { ProductAvatar } from './ProductAvatar';

interface Props {
  card: CapabilityCard;
  selected: boolean;
  onClick: () => void;
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
        <div className="relative aspect-[4/3] w-full overflow-hidden rounded-b-2xl bg-surface-2">
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
          <p
            className={cn(
              'm-0 line-clamp-5 text-[13px] leading-relaxed text-text-2',
              card.image && '-mt-8',
            )}
          >
            {card.description}
          </p>
        )}

        {card.capabilities.length > 0 && (
          <div className="flex flex-wrap items-center gap-6">
            {card.capabilities.slice(0, 3).map((tag) => (
              <span
                key={tag}
                className="rounded-full bg-tag-bg px-10 py-4 font-mono text-[11px] font-medium tracking-wide text-text-2 uppercase"
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
