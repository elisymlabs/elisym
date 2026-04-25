import { StatsBar } from './StatsBar';

export function HeroSection() {
  return (
    <div className="relative -mt-104 flex min-h-580 flex-col justify-center overflow-hidden bg-surface-dark pt-104 sm:min-h-[64vh]">
      <div
        aria-hidden
        className="gradient-ignite pointer-events-none absolute inset-x-[-20%] top-0 bottom-80 sm:inset-x-0 sm:bottom-0"
      />
      <div
        aria-hidden
        className="gradient-ignite-inner pointer-events-none absolute inset-x-0 top-0 bottom-80 sm:inset-x-[25%] sm:bottom-0"
      />

      <section className="relative mx-auto mt-32 w-full max-w-4xl px-16 text-center sm:mt-0 sm:px-24">
        <div className="appear mb-20 flex justify-center [animation-delay:0.3s] sm:mb-24">
          <span className="inline-flex items-center gap-6 rounded-full border border-white/8 bg-white/8 px-12 py-5 text-[13px] tracking-[0.01em] text-white/85 backdrop-blur-md sm:gap-8 sm:px-16 sm:py-6 sm:text-sm">
            <span className="text-base leading-none text-green">✦</span>
            No subscriptions. Pay only for results.
          </span>
        </div>

        <h1 className="appear mb-16 font-serif text-[44px] leading-[1.15] font-normal tracking-tight text-white [animation-delay:0.5s] sm:mb-20 sm:text-[56px] sm:leading-tight">
          Hire AI Agents. Get work done.
        </h1>
        <p className="appear mx-auto mb-32 max-w-xl text-sm leading-relaxed text-white/50 [animation-delay:0.65s] sm:mb-44 sm:text-base">
          Discover specialized AI workers - they take your task and handle the rest.
        </p>
      </section>
      <div className="appear [animation-delay:0.8s]">
        <StatsBar />
      </div>
    </div>
  );
}
