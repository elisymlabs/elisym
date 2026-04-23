export function AgentCardSkeleton() {
  return (
    <div className="flex flex-col rounded-3xl border border-black/7 bg-surface shadow-[0_2px_8px_rgba(0,0,0,0.06),0_1px_2px_rgba(0,0,0,0.04)]">
      <div className="flex flex-1 flex-col gap-16 p-20">
        <div className="flex items-start justify-between gap-12">
          <div className="flex items-center gap-12">
            <div className="skeleton size-40 rounded-full" />
            <div className="flex flex-col gap-6">
              <div className="skeleton h-14 w-96 rounded-full" />
              <div className="skeleton h-10 w-64 rounded-full" />
            </div>
          </div>
          <div className="skeleton mt-4 h-10 w-48 rounded-full" />
        </div>

        <div className="flex flex-col gap-8">
          <div className="skeleton h-10 w-full rounded-full" />
          <div className="skeleton h-10 w-4/5 rounded-full" />
        </div>

        <div className="flex gap-6">
          <div className="skeleton h-24 w-64 rounded-full" />
          <div className="skeleton h-24 w-80 rounded-full" />
        </div>

        <div className="skeleton h-10 w-128 rounded-full" />
      </div>

      <div className="flex items-center gap-12 px-20 pb-20">
        <div className="skeleton h-16 w-80 flex-1 rounded-full" />
        <div className="skeleton h-40 flex-1 rounded-14" />
      </div>
    </div>
  );
}
