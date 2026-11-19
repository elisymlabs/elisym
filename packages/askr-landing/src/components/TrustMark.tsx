import { LiveMark } from './LiveMark';

/**
 * The block's picture: the Askr mark, large and alive, looking at the pointer wherever it is, on a soft panel. Decoration only.
 */
export function TrustMark() {
  return (
    <div
      aria-hidden="true"
      className="rounded-32 sm:rounded-40 bg-surface-2 relative grid aspect-[4/5] place-items-center overflow-hidden [--mark-paper:var(--surface-2)]"
    >
      <LiveMark watchPointer rings={9} className="relative w-[72%]" />
    </div>
  );
}
