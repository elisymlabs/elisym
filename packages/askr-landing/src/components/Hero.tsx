import { useState } from 'react';
import { BUTTON } from '../buttons';
import { DOCS, PRODUCT_NAME } from '../constants';
import { NICHES } from '../niches';
import { AdminLink } from './AdminLink';
import { ChatDemo } from './ChatDemo';
import { ExternalLink } from './ExternalLink';
import { Icon } from './Icon';
import { Reveal } from './Reveal';

export function Hero() {
  const [current, setCurrent] = useState(0);
  const [chosen, setChosen] = useState(false);
  const niche = NICHES[current] ?? NICHES[0];
  if (niche === undefined) {
    throw new Error('the hero has no niches');
  }
  const advance = () => setCurrent((index) => (index + 1) % NICHES.length);
  return (
    <section id="top" className="relative overflow-hidden pt-128 sm:pt-160">
      <div className="mx-auto flex max-w-1200 flex-col items-center px-16 text-center sm:px-24">
        <Reveal>
          <p className="border-line-2 bg-surface/70 text-13 text-text-2 inline-flex items-center gap-8 rounded-full border px-14 py-6">
            <span className="bg-accent size-6 rounded-full" />
            {`${PRODUCT_NAME}: the shopping assistant for your store's site`}
          </p>
        </Reveal>
        <Reveal delay={1}>
          <h1 className="text-48 sm:text-96 lg:text-128 mt-28 font-serif leading-[0.9] tracking-[-0.02em]">
            Helps every visitor buy.
            <br />
            <em className="text-accent-ink">Never</em> makes up a price.
          </h1>
        </Reveal>
        <Reveal delay={2}>
          <p className="text-18 sm:text-20 text-text-2 mx-auto mt-28 max-w-640 leading-relaxed">
            {`${PRODUCT_NAME} answers your visitors from your own catalog and policies, finds the product for their need and budget, and sends them to your cart. One script tag. It sells nothing itself.`}
          </p>
        </Reveal>
        <Reveal delay={3} className="mt-36 flex flex-wrap justify-center gap-12">
          <AdminLink label="Create your store" className={BUTTON.solid} />
          <ExternalLink href={DOCS.overview} className={BUTTON.ghost}>
            Read the docs
            <Icon name="arrow" className="size-18" />
          </ExternalLink>
        </Reveal>
      </div>
      <div className="relative mx-auto mt-64 max-w-1360 px-12 sm:mt-80 sm:px-24">
        <div className="mb-16 flex flex-col items-center gap-10 sm:flex-row sm:justify-center">
          <span className="text-13 text-text-3">See it in a store:</span>
          <div
            role="tablist"
            aria-label="Store niche"
            className="border-line bg-surface/80 flex rounded-full border p-4 backdrop-blur"
          >
            {NICHES.map((item, index) => (
              <button
                key={item.id}
                id={`niche-tab-${item.id}`}
                type="button"
                role="tab"
                aria-selected={index === current}
                aria-controls="niche-demo"
                onClick={() => {
                  setChosen(true);
                  setCurrent(index);
                }}
                className={`text-13 sm:text-14 rounded-full px-12 py-8 font-medium transition sm:px-16 ${index === current ? 'bg-ink text-on-ink' : 'text-text-2 hover:text-text'}`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
        <div className="rounded-32 sm:rounded-40 relative aspect-[4/5] overflow-hidden sm:aspect-[4/3] md:aspect-[16/9] lg:aspect-[2/1] xl:aspect-[21/10]">
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
          <div className="from-ink/30 absolute inset-0 bg-gradient-to-t to-transparent to-50%" />
          <p className="bg-surface/85 text-13 absolute bottom-24 left-24 hidden items-center gap-8 rounded-full px-14 py-8 font-medium backdrop-blur lg:flex">
            <Icon name="shield" className="text-accent-ink size-16" />
            Every price checked against the catalog
          </p>
        </div>
        <div
          id="niche-demo"
          role="tabpanel"
          aria-labelledby={`niche-tab-${niche.id}`}
          className="relative z-10 mx-auto -mt-200 w-full max-w-400 px-8 lg:absolute lg:right-56 lg:bottom-40 lg:mt-0 lg:w-400 lg:px-0"
        >
          <ChatDemo key={niche.id} niche={niche} onFinished={chosen ? undefined : advance} />
        </div>
      </div>
    </section>
  );
}
