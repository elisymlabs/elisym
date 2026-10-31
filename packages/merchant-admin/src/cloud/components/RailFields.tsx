import type { EvmForm, RailForm } from '../lib/settings';

interface Props {
  id: string;
  label: string;
  rail: RailForm | EvmForm;
  onChange: (rail: RailForm | EvmForm) => void;
}

/**
 * The rail as changed: turned off or on, it runs on our endpoint (an own one
 * it was saved with is dropped); any other change is taken as it comes.
 */
export function railChange<T extends RailForm>(was: T, next: T): T {
  return next.on === was.on ? next : { ...next, rpcUrl: '' };
}

/**
 * One payment network: on or off, and an EVM chain's credit. Its endpoint is
 * ours; an own one it was saved with is named, with "Use ours" to drop it.
 */
export function RailFields({ id, label, rail, onChange }: Props) {
  return (
    <div className="border-line flex flex-col gap-8 border-t pt-12">
      <label className="text-14 flex items-center gap-8 font-medium">
        <input
          type="checkbox"
          checked={rail.on}
          onChange={(event) => onChange({ ...rail, on: event.target.checked })}
        />
        {label}
      </label>
      {rail.on ? (
        <>
          {rail.rpcUrl === '' ? null : (
            <div className="text-13 text-text-2 flex flex-wrap items-center gap-8">
              <span id={`${id}-own`}>Uses your own network endpoint.</span>
              <button
                type="button"
                aria-describedby={`${id}-own`}
                onClick={() => onChange({ ...rail, rpcUrl: '' })}
                className="text-accent-ink font-medium underline underline-offset-2"
              >
                Use ours
              </button>
            </div>
          )}
          {'credit' in rail ? (
            <label className="text-13 text-text-2 flex items-center gap-8">
              Credit a payment
              <select
                id={`${id}-credit`}
                value={rail.credit}
                onChange={(event) => {
                  const credit = event.target.value;
                  onChange({
                    ...rail,
                    credit: credit === 'fast' || credit === 'safe' ? credit : '',
                  });
                }}
                className="rounded-10 border-line-2 bg-bg text-14 border px-8 py-4"
              >
                <option value="">as the node does by default</option>
                <option value="fast">fast (on inclusion)</option>
                <option value="safe">safe (once final)</option>
              </select>
            </label>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
