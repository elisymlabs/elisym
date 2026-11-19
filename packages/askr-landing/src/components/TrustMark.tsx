import { LiveMark } from './LiveMark';

/**
 * The block's picture: the Askr mark, large and alive, looking down the shaft from wherever the
 * pointer is on the page's soft panel. Decoration only.
 */
export function TrustMark() {
  return (
    <div
      aria-hidden="true"
      className="rounded-32 sm:rounded-40 bg-surface-2 relative grid aspect-[4/5] place-items-center overflow-hidden [--mark-paper:var(--surface-2)]"
    >
      <LiveMark followPointer rings={9} className="relative w-[72%]" />
    </div>
  );
}
