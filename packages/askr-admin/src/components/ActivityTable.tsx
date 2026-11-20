import type { ActivityDay } from '../lib/types';

interface Props {
  days: readonly ActivityDay[];
}

const SECS_PER_DAY = 86_400;
const MS_PER_SEC = 1_000;

/** "Nov 20": the UTC day, as the server counts it. */
function dayLabel(day: number): string {
  return new Date(day * SECS_PER_DAY * MS_PER_SEC).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** The widget's activity per day, newest first, with the 30 days' totals under it. */
export function ActivityTable({ days }: Props) {
  if (days.length === 0) {
    return <p className="text-14 text-text-2 px-20 py-16">No activity in the last 30 days.</p>;
  }
  const totals = days.reduce(
    (sum, day) => ({
      conversations: sum.conversations + day.conversations,
      answers: sum.answers + day.answers,
      links: sum.links + day.links,
      carts: sum.carts + day.carts,
    }),
    { conversations: 0, answers: 0, links: 0, carts: 0 },
  );
  return (
    <div className="overflow-x-auto">
      <table className="data-table" aria-label="Last 30 days">
        <thead>
          <tr>
            <th>Day (UTC)</th>
            <th className="text-right">Conversations</th>
            <th className="text-right">Questions answered</th>
            <th className="text-right">Page opened</th>
            <th className="text-right">Added to cart</th>
          </tr>
        </thead>
        <tbody>
          {[...days].reverse().map((day) => (
            <tr key={day.day}>
              <td className="text-13">{dayLabel(day.day)}</td>
              <td className="text-right tabular-nums">{day.conversations}</td>
              <td className="text-right tabular-nums">{day.answers}</td>
              <td className="text-right tabular-nums">{day.links}</td>
              <td className="text-right tabular-nums">{day.carts}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th className="text-13">30 days</th>
            <td className="text-right font-semibold tabular-nums">{totals.conversations}</td>
            <td className="text-right font-semibold tabular-nums">{totals.answers}</td>
            <td className="text-right font-semibold tabular-nums">{totals.links}</td>
            <td className="text-right font-semibold tabular-nums">{totals.carts}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
