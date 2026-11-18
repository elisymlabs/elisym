import { useState } from 'react';
import { BUTTON } from '../buttons';
import { DOCS, PRODUCT_NAME } from '../constants';
import { NICHES } from '../niches';
import { AdminLink } from './AdminLink';
import { ChatDemo } from './ChatDemo';
import { ExternalLink } from './ExternalLink';
import { Icon } from './Icon';
import { Reveal } from './Reveal';

/** The first screen: the promise on the left, a store with the widget answering on the right. */
export function Hero() {
  const [current, setCurrent] = useState(0);
  const [chosen, setChosen] = useState(false);
  const niche = NICHES[current] ?? NICHES[0];
  if (niche === undefined) {
    throw new Error('the hero has no niches');
  }
  const advance = () => setCurrent((index) => (index + 1) % NICHES.length);
  return (
    <section id="top" className="relative pt-104 sm:pt-120">
      <div className="mx-auto grid max-w-1440 gap-48 px-16 sm:px-32 lg:min-h-[calc(100vh-120px)] lg:grid-cols-12 lg:items-center lg:gap-32">
        <div className="flex flex-col gap-28 lg:col-span-6 lg:pr-24">
          <Reveal>
            <p className="text-13 text-text-2 flex items-center gap-10 font-medium tracking-[0.12em] uppercase">
              <span className="bg-text inline-block h-px w-32" />
              {`${PRODUCT_NAME}, the shopping assistant for your store's site`}
            </p>
          </Reveal>
          <Reveal delay={1}>
            <h1 className="font-serif text-[clamp(3.5rem,14vw,5.5rem)] leading-[0.88] tracking-[-0.035em] lg:text-[clamp(4rem,6.6vw,8.25rem)]">
              Helps every visitor buy.{' '}
              <span className="text-text-3">
                <em>Never</em> makes up a price.
              </span>
            </h1>
          </Reveal>
          <Reveal delay={2}>
            <p className="text-18 text-text-2 max-w-560 leading-relaxed">
              {`${PRODUCT_NAME} answers your visitors from your own catalog and policies, finds the product for their need and budget, and sends them to your cart. AI agents read the same catalog straight from the open network. It sells nothing itself.`}
            </p>
          </Reveal>
          <Reveal delay={3} className="flex flex-wrap gap-12">
            <AdminLink label="Create your store" className={BUTTON.solid} />
            <ExternalLink href={DOCS.overview} className={BUTTON.ghost}>
              Read the docs
              <Icon name="arrow" className="size-18" />
            </ExternalLink>
          </Reveal>
        </div>

        <Reveal delay={2} className="relative lg:col-span-6">
          <div className="rounded-32 sm:rounded-40 relative h-[min(560px,120vw)] overflow-hidden sm:h-[640px] lg:h-[min(820px,calc(100vh-150px))] lg:min-h-[660px]">
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
            <div className="from-ink/60 absolute inset-0 bg-gradient-to-b via-transparent to-transparent to-45%" />
            <div className="absolute top-20 left-20 flex flex-col gap-12 sm:top-28 sm:left-28">
              <span className="text-12 text-on-ink/85 font-medium tracking-[0.14em] uppercase">
                See it in a store
              </span>
              <div
                role="tablist"
                aria-label="Store niche"
                className="bg-ink/40 flex flex-wrap rounded-full p-4 backdrop-blur-md"
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
                    className={`text-13 rounded-full px-12 py-7 font-medium transition sm:px-14 ${index === current ? 'bg-surface text-text' : 'text-on-ink hover:bg-on-ink/10'}`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div
            id="niche-demo"
            role="tabpanel"
            aria-labelledby={`niche-tab-${niche.id}`}
            className="relative z-10 mx-auto -mt-200 w-full max-w-380 px-8 sm:-mt-280 lg:absolute lg:right-24 lg:bottom-24 lg:mt-0 lg:w-380 lg:px-0"
          >
            <ChatDemo key={niche.id} niche={niche} onFinished={chosen ? undefined : advance} />
          </div>
        </Reveal>
      </div>
    </section>
  );
}
