import { PRODUCT_NAME } from '../constants';
import { Icon, type IconName } from './Icon';
import { SectionHeading } from './SectionHeading';

const POINTS: { icon: IconName; title: string; body: string }[] = [
  {
    icon: 'tag',
    title: 'Prices from your signed catalog',
    body: 'A product card always shows the price from the listing signed for your store, never one the model wrote. A price check gates every answer before a visitor sees it.',
  },
  {
    icon: 'key',
    title: 'Your keys',
    body: "Your catalog, policies and the public part of your settings are signed Nostr events; the assistant's instructions are encrypted to it. Your owner key is the store's identity and decides which catalog keys may write your products. Revoke one at any time.",
  },
  {
    icon: 'plug',
    title: 'No store tokens',
    body: 'Connectors read only what your shop already shows the public. You never hand over an API token or database access.',
  },
  {
    icon: 'ban',
    title: 'No payments',
    body: `${PRODUCT_NAME} takes no payments and sells nothing. Checkout stays where it is on your site, and a listing a catalog key signs can never carry payment terms.`,
  },
  {
    icon: 'eye',
    title: 'Origin and path only',
    body: 'The widget tells the assistant which page the visitor is on as its origin and path, never the query string.',
  },
  {
    icon: 'globe',
    title: 'Only on your sites',
    body: "The server opens a chat session only for pages on the origins listed in your store's config.",
  },
];

export function Trust() {
  return (
    <section id="trust" className="border-line bg-surface border-y">
      <div className="mx-auto max-w-1160 px-16 py-80 sm:px-24 sm:py-112">
        <SectionHeading eyebrow="Trust" title="An assistant you can put in front of buyers">
          It quotes your catalog and policies, it runs on keys you control, and it never touches
          money.
        </SectionHeading>
        <ul className="mt-48 grid gap-16 sm:grid-cols-2 lg:grid-cols-3">
          {POINTS.map((point) => (
            <li
              key={point.title}
              className="rounded-20 border-line bg-bg flex flex-col gap-16 border p-24"
            >
              <span className="rounded-12 bg-accent-soft text-accent-ink grid size-44 place-items-center">
                <Icon name={point.icon} className="size-22" />
              </span>
              <div className="flex flex-col gap-6">
                <h3 className="text-18 font-semibold">{point.title}</h3>
                <p className="text-15 text-text-2 leading-relaxed">{point.body}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
