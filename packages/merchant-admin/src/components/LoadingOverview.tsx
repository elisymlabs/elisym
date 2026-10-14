const STATS = ['first', 'second', 'third', 'fourth'];
const LINES = ['first', 'second', 'third'];

/** Placeholders while the first read runs. */
export function LoadingOverview() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-24">
      <div className="skeleton rounded-8 h-20 w-160" />
      <div className="grid grid-cols-2 gap-12 lg:grid-cols-4">
        {STATS.map((key) => (
          <div key={key} className="skeleton rounded-16 h-96" />
        ))}
      </div>
      <div className="grid gap-16 lg:grid-cols-[1.6fr_1fr]">
        <div className="skeleton rounded-16 h-360 lg:row-span-2 lg:h-auto" />
        <div className="skeleton rounded-16 h-212" />
        <div className="skeleton rounded-16 h-144" />
      </div>
      <div className="rounded-16 border-line bg-surface flex flex-col gap-12 border p-16">
        {LINES.map((key) => (
          <div key={key} className="skeleton rounded-8 h-40" />
        ))}
      </div>
      <div className="grid gap-12 sm:grid-cols-2">
        <div className="skeleton rounded-16 h-72" />
        <div className="skeleton rounded-16 h-72" />
      </div>
    </div>
  );
}
