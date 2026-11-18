import { useState } from 'react';
import { BUTTON } from '../buttons';
import { DOCS, PRODUCT_NAME } from '../constants';
import { NICHES } from '../niches';
import { AdminLink } from './AdminLink';
import { ChatDemo } from './ChatDemo';
import { ExternalLink } from './ExternalLink';
import { Icon } from './Icon';
import { LiveMark } from './LiveMark';
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
    <section id="top" className="relative overflow-hidden pt-112 sm:pt-136">
      <div className="mx-auto grid max-w-1440 items-center gap-y-40 px-16 sm:px-32 lg:grid-cols-12">
        <div className="lg:col-span-8">
          <Reveal>
            <p className="text-13 text-text-2 flex items-center gap-10 font-medium tracking-[0.12em] uppercase">
              <span className="bg-text inline-block h-px w-32" />
              {`${PRODUCT_NAME}, the shopping assistant for your store's site`}
            </p>
          </Reveal>
          <Reveal delay={1}>
            <h1 className="mt-28 font-serif text-[clamp(3.5rem,15vw,6rem)] leading-[0.88] tracking-[-0.035em] lg:text-[clamp(3.25rem,8.6vw,9.75rem)]">
              <span className="block">Helps every</span>
              <span className="block">visitor buy.</span>
              <span className="text-text-3 block">
                <em>Never</em> makes up
              </span>
              <span className="text-text-3 block">a price.</span>
            </h1>
          </Reveal>
        </div>
        <Reveal delay={2} className="relative lg:col-span-4">
          <LiveMark
            followPointer
            className="mx-auto block aspect-square w-[min(72vw,30rem)] lg:w-full"
          />
        </Reveal>
        <Reveal
          delay={2}
          className="flex flex-col gap-28 lg:col-span-12 lg:flex-row lg:items-end lg:justify-between"
        >
          <p className="text-18 sm:text-20 text-text-2 max-w-640 leading-relaxed">
            {`${PRODUCT_NAME} answers your visitors from your own catalog and policies, finds the product for their need and budget, and sends them to your cart. AI agents read the same catalog straight from the open network. It sells nothing itself.`}
          </p>
          <div className="flex flex-wrap gap-12">
            <AdminLink label="Create your store" className={BUTTON.solid} />
            <ExternalLink href={DOCS.overview} className={BUTTON.ghost}>
              Read the docs
              <Icon name="arrow" className="size-18" />
            </ExternalLink>
          </div>
        </Reveal>
      </div>

      <div className="relative mx-auto mt-72 max-w-1440 px-8 sm:mt-96 sm:px-16">
        <div className="rounded-24 sm:rounded-40 relative overflow-hidden">
          <div className="relative aspect-[4/5] sm:aspect-[4/3] md:aspect-[16/9] lg:aspect-[2/1]">
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
            <div className="from-ink/55 absolute inset-0 bg-gradient-to-r via-transparent to-transparent" />
            <div className="absolute top-20 left-20 flex flex-col gap-14 sm:top-32 sm:left-32">
              <span className="text-12 text-on-ink/80 font-medium tracking-[0.14em] uppercase">
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
                    className={`text-13 sm:text-14 rounded-full px-12 py-8 font-medium transition sm:px-16 ${index === current ? 'bg-surface text-text' : 'text-on-ink hover:bg-on-ink/10'}`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
            <p className="text-on-ink absolute bottom-32 left-32 hidden max-w-420 font-serif text-[clamp(2rem,3.4vw,3.5rem)] leading-[0.95] lg:block">
              {niche.store}
            </p>
          </div>
        </div>
        <div
          id="niche-demo"
          role="tabpanel"
          aria-labelledby={`niche-tab-${niche.id}`}
          className="relative z-10 mx-auto -mt-160 w-full max-w-380 px-8 sm:-mt-240 lg:absolute lg:right-56 lg:bottom-40 lg:mt-0 lg:w-380 lg:px-0"
        >
          <ChatDemo key={niche.id} niche={niche} onFinished={chosen ? undefined : advance} />
        </div>
      </div>
    </section>
  );
}
