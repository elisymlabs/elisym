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
      <meter className="h-8 w-full" min={0} max={10_000} value={bps} aria-label={label} />
    </div>
  );
}
