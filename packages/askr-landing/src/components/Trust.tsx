import { PRODUCT_NAME } from '../constants';
import { Icon, type IconName } from './Icon';
import { SectionHeading } from './SectionHeading';
import { Visual } from './Visual';

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
    body: 'Connectors read only what your shop already shows the public. You never hand over an API token or database access.',
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
    body: "A chat opens only on pages on the origins listed in your store's settings, and the assistant sees the page's path, never its query string.",
  },
];

export function Trust() {
  return (
    <section id="trust" className="mx-auto max-w-1200 px-16 py-80 sm:px-24 sm:py-112">
      <div className="rounded-32 border-line-2 bg-surface relative isolate grid gap-40 overflow-hidden border p-24 sm:p-48 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
        <div className="flex flex-col gap-24">
          <SectionHeading eyebrow="Your keys" title="Your store, signed by you">
            {`Your catalog, policies and the assistant's settings live on Nostr, an open network, signed by keys only you hold. ${PRODUCT_NAME} runs the assistant on them, but it does not own them: you are never locked in with us.`}
          </SectionHeading>
          <ul className="text-15 text-text-2 flex flex-col gap-10">
            <li className="flex gap-10">
              <Icon name="key" className="text-accent-ink mt-2 size-18 shrink-0" />
              Your owner key is the store's identity. It decides which keys may write your products.
            </li>
            <li className="flex gap-10">
              <Icon name="check" className="text-accent-ink mt-2 size-18 shrink-0" />
              Revoke a key in the admin at any time.
            </li>
          </ul>
        </div>
        <div className="rounded-24 border-line relative aspect-square overflow-hidden border lg:aspect-[4/5]">
          <Visual name="keys" className="absolute inset-0 size-full" />
        </div>
      </div>
      <ul className="mt-16 grid gap-16 sm:grid-cols-2 lg:grid-cols-3">
        {POINTS.map((point) => (
          <li
            key={point.title}
            className="rounded-24 border-line bg-surface flex flex-col gap-14 border p-24"
          >
            <span className="rounded-12 bg-accent-soft text-accent-ink grid size-40 place-items-center">
              <Icon name={point.icon} className="size-20" />
            </span>
            <h3 className="text-18 font-semibold">{point.title}</h3>
            <p className="text-15 text-text-2 leading-relaxed">{point.body}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
