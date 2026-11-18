import { percentOfBps, shareBps } from '../lib/usage';

interface Props {
  label: string;
  used: string;
  limit: string;
  /** How `used` and `limit` read, like "$1.20 of $5.00". */
  text: string;
}

export function UsageMeter({ label, used, limit, text }: Props) {
  const bps = shareBps(used, limit);
  return (
    <div className="flex flex-col gap-4">
      <div className="text-13 flex justify-between gap-8">
        <span className="font-medium">{label}</span>
        <span className="text-text-2">
          {text} ({percentOfBps(bps)}%)
        </span>
      </div>
      <div
        className="bg-surface-2 h-6 w-full overflow-hidden rounded-full"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={10_000}
        aria-valuenow={bps}
      >
        <div
          className={`h-full rounded-full ${bps >= 9_000 ? 'bg-error' : 'bg-text'}`}
          style={{ width: `${Math.min(bps, 10_000) / 100}%` }}
        />
      </div>
    </div>
  );
}
