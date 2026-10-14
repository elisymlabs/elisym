import { type OrderSlice, SERIES_DOTS, SERIES_STROKES, seriesClass, shareOf } from '../lib/charts';
import { ChartCard } from './ChartCard';

interface Props {
  slices: readonly OrderSlice[];
}

const CENTER = 60;
const RADIUS = 46;
/** Room between two arcs, in hundredths of the ring. */
const GAP = 1.2;

const OTHER_STROKES: Readonly<Record<string, string>> = {
  unknown: 'stroke-warn',
  unpaid: 'stroke-chart-idle',
};

const OTHER_DOTS: Readonly<Record<string, string>> = {
  unknown: 'bg-warn',
  unpaid: 'bg-chart-idle',
};

/** The loaded orders by the coin and network they were paid in, drawn in on first show. */
export function OrdersDonut({ slices }: Props) {
  const total = slices.reduce((sum, slice) => sum + slice.count, 0);
  const gap = slices.length > 1 ? GAP : 0;
  let start = 0;
  const arcs = slices.map((slice) => {
    const length = shareOf(slice.count, total) * 100;
    const arc = { slice, start, length: Math.max(length - gap, 0.5) };
    start += length;
    return arc;
  });
  return (
    <ChartCard title="Orders by network" caption="Each loaded order by the coin it was paid in.">
      {total === 0 ? (
        <p id="donut-empty" className="text-13 text-text-2 py-24 text-center">
          No orders yet.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-20">
          <svg
            viewBox="0 0 120 120"
            className="size-128 shrink-0"
            role="img"
            aria-label={`${total} ${total === 1 ? 'order' : 'orders'} loaded: ${slices
              .map((slice) => `${slice.count} ${slice.label}`)
              .join(', ')}`}
          >
            <circle
              cx={CENTER}
              cy={CENTER}
              r={RADIUS}
              strokeWidth={14}
              className="stroke-surface-2 fill-none"
            />
            <g transform={`rotate(-90 ${CENTER} ${CENTER})`} className="chart-arcs">
              {arcs.map((arc) => (
                <circle
                  key={arc.slice.key}
                  cx={CENTER}
                  cy={CENTER}
                  r={RADIUS}
                  pathLength={100}
                  strokeWidth={14}
                  strokeDasharray={`${arc.length} ${100 - arc.length}`}
                  strokeDashoffset={-arc.start}
                  className={`chart-arc fill-none ${
                    arc.slice.series === undefined
                      ? (OTHER_STROKES[arc.slice.key] ?? 'stroke-chart-idle')
                      : seriesClass(SERIES_STROKES, arc.slice.series)
                  }`}
                />
              ))}
            </g>
            <text
              x={CENTER}
              y={CENTER - 2}
              textAnchor="middle"
              className="fill-text text-24 font-semibold"
            >
              {total}
            </text>
            <text x={CENTER} y={CENTER + 16} textAnchor="middle" className="fill-text-2 text-11">
              {total === 1 ? 'order' : 'orders'}
            </text>
          </svg>
          <ul id="donut-legend" className="flex min-w-200 flex-1 flex-col gap-8">
            {slices.map((slice) => (
              <li key={slice.key} className="text-13 flex items-center gap-8">
                <span
                  aria-hidden="true"
                  className={`size-10 shrink-0 rounded-full ${
                    slice.series === undefined
                      ? (OTHER_DOTS[slice.key] ?? 'bg-chart-idle')
                      : seriesClass(SERIES_DOTS, slice.series)
                  }`}
                />
                <span className="text-text-2 min-w-0 flex-1 truncate">{slice.label}</span>
                <span className="font-medium tabular-nums">{slice.count}</span>
                <span className="text-text-3 w-40 text-right tabular-nums">
                  {`${Math.round(shareOf(slice.count, total) * 100)}%`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </ChartCard>
  );
}
