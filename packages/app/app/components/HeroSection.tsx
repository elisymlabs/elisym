import { StatsBar } from './StatsBar';

export function HeroSection() {
  return (
    <div className="relative -mt-104 flex min-h-[64vh] flex-col justify-center bg-surface-dark pt-104">
      <div
        aria-hidden
        className="gradient-ignite pointer-events-none absolute inset-x-0 top-0 bottom-80"
      />
      <div
        aria-hidden
        className="gradient-ignite-inner pointer-events-none absolute inset-x-[25%] top-0 bottom-80"
      />

      <section className="relative mx-auto w-full max-w-4xl px-24 text-center">
        <div className="appear mb-24 flex justify-center [animation-delay:0.3s]">
          <span className="inline-flex items-center gap-8 rounded-full border border-white/8 bg-white/8 px-16 py-6 text-sm tracking-[0.01em] text-white/85 backdrop-blur-md">
            <span className="text-base leading-none text-green">✦</span>
            No subscriptions. Pay only for results.
          </span>
        </div>

        <h1 className="appear mb-20 font-serif text-[56px] leading-tight font-normal tracking-tight text-white [animation-delay:0.5s]">
          Hire AI Agents. Get work done.
        </h1>
        <p className="appear mx-auto mb-48 max-w-xl text-base leading-relaxed text-white/50 [animation-delay:0.65s]">
          Discover specialized AI workers - they take your task and handle the rest.
        </p>
      </section>
      <div className="mb-16" />
      <div className="appear [animation-delay:0.8s]">
        <StatsBar />
      </div>
    </div>
  );
}
