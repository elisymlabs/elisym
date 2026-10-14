import { type DayPoint, dayLabel, ratioOf } from '../lib/charts';

interface Props {
  points: readonly DayPoint[];
  peak: string;
  symbol: string;
  fill: string;
  active: number | undefined;
  onActive: (index: number | undefined) => void;
}

/** One unit of the drawing's width per day; the bars stretch to the card. */
const DAY_WIDTH = 10;
const BAR_WIDTH = 6;
const HEIGHT = 100;
/** A day with any credit stays visible however small next to the peak. */
const MIN_BAR = 2;

/** Daily bars, growing in on first draw; each day can be hovered or focused for its numbers. */
export function DayBars({ points, peak, symbol, fill, active, onActive }: Props) {
  return (
    <svg
      viewBox={`0 0 ${points.length * DAY_WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      className="chart-bars absolute inset-0 size-full overflow-visible"
      role="group"
      aria-label={`${symbol} credited by order date`}
      onMouseLeave={() => onActive(undefined)}
    >
      {points.map((point, index) => {
        const ratio = ratioOf(point.amount, peak);
        const height = ratio === 0 ? 0 : Math.max(ratio * HEIGHT, MIN_BAR);
        const x = index * DAY_WIDTH + (DAY_WIDTH - BAR_WIDTH) / 2;
        const dimmed = active !== undefined && active !== index;
        return (
          <g
            key={point.day}
            tabIndex={0}
            role="img"
            aria-label={`Placed ${dayLabel(point.day)}: ${point.amount} ${symbol} credited, ${point.orders} ${point.orders === 1 ? 'order' : 'orders'}`}
            className="chart-day"
            onMouseEnter={() => onActive(index)}
            onFocus={() => onActive(index)}
            onBlur={() => onActive(undefined)}
          >
            <rect
              x={index * DAY_WIDTH}
              y={0}
              width={DAY_WIDTH}
              height={HEIGHT}
              className={active === index ? 'fill-surface-2' : 'fill-transparent'}
            />
            {height > 0 && (
              <rect
                x={x}
                y={HEIGHT - height}
                width={BAR_WIDTH}
                height={height}
                rx={1}
                className={`chart-bar transition-opacity ${fill} ${dimmed ? 'opacity-40' : ''}`}
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}
