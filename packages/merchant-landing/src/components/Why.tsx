import { PRODUCT_NAME } from '../constants';
import { Icon, type IconName } from './Icon';
import { SectionHeading } from './SectionHeading';

const POINTS: { icon: IconName; title: string; body: string }[] = [
  {
    icon: 'wallet',
    title: 'Nobody holds your money',
    body: 'The buyer’s wallet pays yours in one transaction. There is no balance to withdraw and no platform account to freeze.',
  },
  {
    icon: 'key',
    title: 'No platform account',
    body: 'Your store is a key and a node you run. Orders travel over Nostr relays, payments are checked on chain.',
  },
  {
    icon: 'shield',
    title: 'Open and verifiable',
    body: 'Listings are public signed events, orders travel encrypted end to end to your store, and every payment is on chain for anyone to check. The checkout, the node and the SDK are open source.',
  },
  {
    icon: 'globe',
    title: 'More than one chain',
    body: 'Take USDC on Solana, Ethereum, Base and Arbitrum, and USDC.e or pathUSD on Tempo, from the same store, and let each buyer pay on the network they already use. More networks are on the way.',
  },
  {
    icon: 'table',
    title: 'An admin panel included',
    body: 'Sign in with your store key to see orders, what your node credited, your products and payout networks, and export a CSV for your books.',
  },
  {
    icon: 'bot',
    title: 'AI agents buy too',
    body: 'The offer your buyers see is readable by agents: the elisym MCP server buys a product with buy_product.',
  },
];

export function Why() {
  return (
    <section id="why" className="mx-auto max-w-1160 px-16 py-80 sm:px-24 sm:py-112">
      <SectionHeading eyebrow="Why it is different" title={`Why ${PRODUCT_NAME}`}>
        A checkout that works like a protocol, not a platform.
      </SectionHeading>
      <div className="mt-48 grid gap-16 sm:grid-cols-2 lg:grid-cols-3">
        {POINTS.map((point) => (
          <div
            key={point.title}
            className="rounded-20 border-line bg-surface hover:border-line-2 flex flex-col gap-16 border p-24 transition"
          >
            <span className="rounded-12 bg-accent-soft text-accent-ink grid size-44 shrink-0 place-items-center">
              <Icon name={point.icon} className="size-22" />
            </span>
            <div className="flex flex-col gap-6">
              <h3 className="text-18 font-semibold">{point.title}</h3>
              <p className="text-15 text-text-2 leading-relaxed">{point.body}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
