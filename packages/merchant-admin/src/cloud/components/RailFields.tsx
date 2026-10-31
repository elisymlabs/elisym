import type { EvmForm, RailForm } from '../lib/settings';

interface Props {
  id: string;
  label: string;
  rail: RailForm | EvmForm;
  onChange: (rail: RailForm | EvmForm) => void;
}

/** One payment network: on or off, and an EVM chain's credit. Its RPC is the cloud's. */
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
