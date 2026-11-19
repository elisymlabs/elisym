import { type KeyboardEvent, useRef, useState } from 'react';
import { BUTTON } from '../buttons';
import { PRODUCT_NAME, START_LABEL } from '../constants';
import { NICHES } from '../niches';
import { AdminLink } from './AdminLink';
import { ChatDemo } from './ChatDemo';
import { Icon } from './Icon';
import { MotionToggle } from './MotionToggle';
import { Reveal } from './Reveal';

/** The first screen: the promise on the left, a store with the widget answering on the right. */
export function Hero() {
  const [current, setCurrent] = useState(0);
  // Turning on its own until the visitor picks a store or pauses it.
  const [chosen, setChosen] = useState(false);
  const [paused, setPaused] = useState(false);
  // While the pointer is over the store, the chat keeps playing but the store does not change.
  const [reading, setReading] = useState(false);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const niche = NICHES[current] ?? NICHES[0];
  if (niche === undefined) {
    throw new Error('the hero has no niches');
  }
  const advance = () => setCurrent((index) => (index + 1) % NICHES.length);
  const choose = (index: number) => {
    setChosen(true);
    setCurrent(index);
  };
  // The tabs as a tab list should behave: one tab stop, the arrow keys move and choose.
  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    const edge = { Home: 0, End: NICHES.length - 1 }[event.key];
    if (step === undefined && edge === undefined) {
      return;
    }
    event.preventDefault();
    const next = edge ?? (current + (step ?? 0) + NICHES.length) % NICHES.length;
    choose(next);
    tabs.current[next]?.focus();
  };
  const turning = !chosen && !paused;
  return (
    <section id="top" className="relative pt-104 sm:pt-120">
      <div className="mx-auto grid max-w-1440 grid-cols-[minmax(0,1fr)] gap-48 px-16 sm:px-32 lg:min-h-[calc(100vh-120px)] lg:grid-cols-12 lg:items-center lg:gap-32">
        <div className="flex flex-col gap-28 lg:col-span-6 lg:pr-24">
          <Reveal>
            <p className="text-13 text-text-2 flex items-center gap-10 font-medium tracking-[0.12em] uppercase">
              <span className="bg-text inline-block h-px w-32" />
              AI shopping assistant for online stores
            </p>
          </Reveal>
          <Reveal delay={1}>
            <h1 className="font-serif text-[clamp(3.5rem,14vw,5.5rem)] leading-[0.88] tracking-[-0.035em] lg:text-[clamp(4rem,6.6vw,8.25rem)]">
              Your best salesperson, <em className="text-text-3">on every page.</em>
            </h1>
          </Reveal>
          <Reveal delay={2}>
            <p className="text-18 text-text-2 max-w-560 leading-relaxed">
              {`${PRODUCT_NAME} answers shoppers right away, in their language. It finds the right product for their need and budget and sends them to your cart. Every answer comes from your own catalog and policies, so every price and promise is yours.`}
            </p>
          </Reveal>
          <Reveal delay={3} className="flex flex-wrap gap-12">
            <AdminLink label={START_LABEL} className={BUTTON.solid} />
            <a href="#features" className={BUTTON.ghost}>
              See how it works
              <Icon name="arrow" className="size-18 rotate-90" />
            </a>
          </Reveal>
          <Reveal delay={3}>
            <p className="text-14 text-text-3">
              One line of code. Works with Shopify, WooCommerce and any other site.
            </p>
          </Reveal>
        </div>

        <Reveal delay={2} className="relative lg:col-span-6">
          <div onPointerEnter={() => setReading(true)} onPointerLeave={() => setReading(false)}>
            <div className="mb-16 flex flex-wrap items-center gap-12">
              <span className="text-12 text-text-2 font-medium tracking-[0.14em] uppercase">
                See it in a store
              </span>
              <div
                role="tablist"
                aria-label="Store niche"
                onKeyDown={onTabKey}
                className="border-line bg-surface flex flex-wrap rounded-full border p-4"
              >
                {NICHES.map((item, index) => (
                  <button
                    key={item.id}
                    ref={(tab) => {
                      tabs.current[index] = tab;
                    }}
                    id={`niche-tab-${item.id}`}
                    type="button"
                    role="tab"
                    aria-selected={index === current}
                    aria-controls="niche-demo"
                    tabIndex={index === current ? 0 : -1}
                    onClick={() => choose(index)}
                    className={`text-13 rounded-full px-12 py-7 font-medium transition sm:px-14 ${index === current ? 'bg-ink text-on-ink' : 'text-text-2 hover:text-text'}`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              {!chosen && (
                <MotionToggle
                  paused={paused}
                  onToggle={() => setPaused((value) => !value)}
                  what="the store demo"
                />
              )}
            </div>
            <div className="rounded-32 sm:rounded-40 relative h-[min(560px,120vw)] overflow-hidden sm:h-[640px] lg:h-[min(760px,calc(100vh-200px))] lg:min-h-[640px]">
              {NICHES.map((item, index) => (
                <img
                  key={item.id}
                  src={item.photo.src}
                  alt={index === current ? item.photo.alt : ''}
                  aria-hidden={index !== current}
                  width={item.photo.width}
                  height={item.photo.height}
                  fetchPriority={index === 0 ? 'high' : 'low'}
                  className={`absolute inset-0 size-full object-cover transition-opacity duration-1000 ${index === current ? 'settle opacity-100' : 'opacity-0'}`}
                />
              ))}
            </div>
            <div
              id="niche-demo"
              role="tabpanel"
              aria-labelledby={`niche-tab-${niche.id}`}
              className="relative z-10 mx-auto -mt-200 w-full max-w-380 px-8 sm:-mt-280 lg:absolute lg:right-24 lg:bottom-24 lg:mt-0 lg:w-380 lg:px-0"
            >
              <ChatDemo
                key={niche.id}
                niche={niche}
                hold={paused && !chosen}
                onFinished={turning && !reading ? advance : undefined}
              />
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
