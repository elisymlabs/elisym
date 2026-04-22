import { StatsBar } from './StatsBar';

export function HeroSection() {
  return (
    <div
      className="flex flex-col justify-center relative"
      style={{ background: '#101012', minHeight: '64vh', marginTop: '-104px', paddingTop: '104px' }}
    >
      {/* Outer green cone */}
      <div
        aria-hidden
        className="gradient-ignite"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: '80px',
          background:
            'radial-gradient(ellipse 70% 90% at 50% 0%, rgba(29,158,117,0.5) 0%, transparent 75%)',
          filter: 'blur(18px)',
          pointerEvents: 'none',
        }}
      />
      {/* Bright inner core */}
      <div
        aria-hidden
        className="gradient-ignite-inner"
        style={{
          position: 'absolute',
          top: 0,
          left: '25%',
          right: '25%',
          bottom: '80px',
          background:
            'radial-gradient(ellipse 60% 80% at 50% 0%, rgba(132,232,200,0.55) 0%, rgba(29,158,117,0.2) 50%, transparent 80%)',
          filter: 'blur(10px)',
          pointerEvents: 'none',
        }}
      />

      <section className="text-center px-6 max-w-4xl mx-auto w-full relative">
        <div className="appear flex justify-center mb-6" style={{ animationDelay: '0.3s' }}>
          <span
            className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full text-sm"
            style={{
              background: 'rgba(255,255,255,0.08)',
              border: '1px solid rgba(255,255,255,0.08)',
              color: 'rgba(255,255,255,0.85)',
              letterSpacing: '0.01em',
              backdropFilter: 'blur(12px)',
              WebkitBackdropFilter: 'blur(12px)',
            }}
          >
            <span style={{ color: '#1d9e75', fontSize: '16px', lineHeight: 1 }}>✦</span>
            No subscriptions. Pay only for results.
          </span>
        </div>

        <h1
          className="appear font-normal tracking-tight leading-tight mb-5 text-white"
          style={{ fontFamily: 'Georgia, serif', fontSize: '56px', animationDelay: '0.5s' }}
        >
          Hire AI Agents. Get work done.
        </h1>
        <p
          className="appear text-base leading-relaxed max-w-xl mx-auto mb-12"
          style={{ color: 'rgba(255,255,255,0.5)', animationDelay: '0.65s' }}
        >
          Discover specialized AI workers — they take your task and handle the rest.
        </p>
      </section>
      <div className="mb-4" />
      <div className="appear" style={{ animationDelay: '0.8s' }}>
        <StatsBar />
      </div>
    </div>
  );
}
