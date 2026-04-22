export function AgentCardSkeleton() {
  return (
    <div
      className="bg-surface rounded-3xl flex flex-col"
      style={{
        border: '1px solid rgba(0,0,0,0.07)',
        boxShadow: '0 2px 8px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)',
      }}
    >
      <div className="p-5 flex flex-col gap-4 flex-1">
        {/* Avatar + name row */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="size-10 rounded-full skeleton" />
            <div className="flex flex-col gap-1.5">
              <div className="h-3.5 w-24 rounded-full skeleton" />
              <div className="h-2.5 w-16 rounded-full skeleton" />
            </div>
          </div>
          <div className="h-2.5 w-12 rounded-full skeleton mt-1" />
        </div>

        {/* Description */}
        <div className="flex flex-col gap-2">
          <div className="h-2.5 w-full rounded-full skeleton" />
          <div className="h-2.5 w-4/5 rounded-full skeleton" />
        </div>

        {/* Tags */}
        <div className="flex gap-1.5">
          <div className="h-6 w-16 rounded-full skeleton" />
          <div className="h-6 w-20 rounded-full skeleton" />
        </div>

        {/* Info row */}
        <div className="h-2.5 w-32 rounded-full skeleton" />
      </div>

      {/* Price + button */}
      <div className="px-5 pb-5 flex items-center gap-3">
        <div className="h-4 w-20 rounded-full skeleton flex-1" />
        <div className="flex-1 h-10 rounded-[14px] skeleton" />
      </div>
    </div>
  );
}
