import { useState } from 'react';
import { MotionToggle } from './MotionToggle';

const ITEMS = ['Shopify', 'WooCommerce', 'Google product feed', 'CSV', 'Any website'];

/** The sources a catalog comes from, on a slow loop. */
export function WorksWith() {
  const [paused, setPaused] = useState(false);
  const row = ITEMS.map((item) => (
    <li key={item} className="flex shrink-0 items-center gap-40 pr-40">
      <span className="text-32 sm:text-40 font-serif italic">{item}</span>
      <span aria-hidden="true" className="text-accent text-20">
        ✳
      </span>
    </li>
  ));
  return (
    <section id="works-with" aria-labelledby="works-with-title" className="py-56 sm:py-72">
      <h2
        id="works-with-title"
        className="text-12 text-text-3 text-center font-semibold tracking-[0.14em] uppercase"
      >
        Works with your store
      </h2>
      <div className="mt-8 flex justify-center">
        <MotionToggle
          paused={paused}
          onToggle={() => setPaused((value) => !value)}
          what="the store list"
        />
      </div>
      <div className="marquee mt-24 overflow-hidden" data-paused={paused}>
        <ul className="marquee-track flex w-max">
          {row}
          {ITEMS.map((item) => (
            <li
              key={`${item}-again`}
              aria-hidden="true"
              className="flex shrink-0 items-center gap-40 pr-40"
            >
              <span className="text-32 sm:text-40 font-serif italic">{item}</span>
              <span className="text-accent text-20">✳</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
