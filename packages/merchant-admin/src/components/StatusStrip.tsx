import { STATE_DOTS, STATE_FILLS, shareOf } from '../lib/charts';
import type { OrderState } from '../lib/core';
import { STATE_SHORT } from '../lib/orders';
import { ChartCard } from './ChartCard';
import { Icon } from './Icon';

interface Props {
  parts: readonly { state: OrderState; count: number }[];
  /** Payments reported that no credit confirms (`unconfirmedPayments`): warned about. */
  unconfirmed: number;
}

/** Where the loaded orders stand, as one bar split by state. */
export function StatusStrip({ parts, unconfirmed: reported }: Props) {
  const total = parts.reduce((sum, part) => sum + part.count, 0);
  let start = 0;
  const segments = parts.map((part) => {
    const width = shareOf(part.count, total) * 100;
    const segment = { part, start, width };
    start += width;
    return segment;
  });
  return (
    <ChartCard title="Order status" caption="Where the loaded orders stand.">
      {total === 0 ? (
        <p id="status-empty" className="text-13 text-text-2 py-8 text-center">
          No orders yet.
        </p>
      ) : (
        <div className="flex flex-col gap-12">
          {reported > 0 && (
            <p
              id="status-reported"
              className="rounded-10 bg-warn-bg text-warn text-13 flex items-center gap-8 px-12 py-8 font-medium"
            >
              <Icon name="alert" className="size-16 shrink-0" />
              {`${reported} ${reported === 1 ? 'payment' : 'payments'} reported, not confirmed by your node`}
            </p>
          )}
          <svg
            viewBox="0 0 100 10"
            preserveAspectRatio="none"
            className="chart-strip rounded-6 h-10 w-full overflow-hidden"
            role="img"
            aria-label={parts.map((part) => `${part.count} ${STATE_SHORT[part.state]}`).join(', ')}
          >
            {segments.map((segment) => (
              <rect
                key={segment.part.state}
                x={segment.start}
                y={0}
                width={segment.width}
                height={10}
                className={`chart-segment ${STATE_FILLS[segment.part.state]}`}
              />
            ))}
          </svg>
          <ul id="status-legend" className="text-13 flex flex-wrap gap-x-16 gap-y-6">
            {parts.map((part) => (
              <li key={part.state} className="flex items-center gap-6">
                <span
                  aria-hidden="true"
                  className={`size-8 rounded-full ${STATE_DOTS[part.state]}`}
                />
                <span className="text-text-2">{STATE_SHORT[part.state]}</span>
                <span className="font-medium tabular-nums">{part.count}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </ChartCard>
  );
}
