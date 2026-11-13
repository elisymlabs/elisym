import { PRODUCT_NAME } from '../constants';
import { PHOTOS } from '../media';
import { Eyebrow } from './Eyebrow';
import { Icon, type IconName } from './Icon';
import { Reveal } from './Reveal';

const POINTS: { icon: IconName; title: string; body: string }[] = [
  {
    icon: 'clock',
    title: 'Conversations are not kept',
    body: "A visitor's chat lives up to 24 hours, then it is gone. There is no transcript archive.",
  },
  {
    icon: 'lock',
    title: 'Encrypted end to end',
    body: 'Messages travel encrypted between the visitor and the assistant. The gateway that admits a chat never sees what is in it.',
  },
  {
    icon: 'plug',
    title: 'No store tokens',
    body: 'Connectors read only what your shop already shows the public. No API token, no database access.',
  },
  {
    icon: 'ban',
    title: 'No payments',
    body: `${PRODUCT_NAME} never touches money. Checkout stays where it is on your site.`,
  },
  {
    icon: 'shield',
    title: 'A script that cannot be swapped',
    body: 'Pin the widget with its integrity hash, and the browser runs it only if it is exactly the file you approved.',
  },
  {
    icon: 'globe',
    title: 'Only on your sites',
    body: "A chat opens only on your store's origins, and the assistant sees the page's path, never its query string.",
  },
];

export function Trust() {
  return (
    <section id="trust" className="mx-auto max-w-1360 px-12 py-96 sm:px-24 sm:py-160">
      <div className="grid gap-48 lg:grid-cols-[0.8fr_1.2fr] lg:gap-80">
        <Reveal className="rounded-32 sm:rounded-40 relative aspect-[4/5] overflow-hidden lg:sticky lg:top-112 lg:self-start">
          <img
            src={PHOTOS.keys.src}
            alt={PHOTOS.keys.alt}
            width={PHOTOS.keys.width}
            height={PHOTOS.keys.height}
            loading="lazy"
            decoding="async"
            className="absolute inset-0 size-full object-cover"
          />
        </Reveal>
        <div className="flex flex-col gap-24 px-4">
          <Reveal className="flex flex-col gap-24">
            <Eyebrow>Your keys</Eyebrow>
            <h2 className="text-48 sm:text-80 font-serif leading-[0.95]">
              Your store, <em>signed by you.</em>
            </h2>
            <p className="text-18 text-text-2 max-w-600 leading-relaxed">
              {`Your catalog, policies and the assistant's settings live on Nostr, an open network, signed by keys only you hold. ${PRODUCT_NAME} runs the assistant on them, but does not own them: you are never locked in with us.`}
            </p>
            <p className="border-line-2 text-15 text-text-2 flex max-w-600 gap-12 border-l-2 pl-16 leading-relaxed">
              Your owner key is the store's identity. It decides which keys may write your products,
              and you revoke any of them in the admin at any time.
            </p>
          </Reveal>
          <Reveal delay={1}>
            <ul className="mt-24 grid gap-x-40 sm:grid-cols-2">
              {POINTS.map((point) => (
                <li key={point.title} className="border-line-2 flex flex-col gap-10 border-t py-24">
                  <div className="text-accent-ink flex items-center gap-10">
                    <Icon name={point.icon} className="size-20" />
                    <h3 className="text-text text-16 font-medium">{point.title}</h3>
                  </div>
                  <p className="text-15 text-text-2 leading-relaxed">{point.body}</p>
                </li>
              ))}
            </ul>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
