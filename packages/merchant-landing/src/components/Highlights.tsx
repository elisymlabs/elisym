import { Icon, type IconName } from './Icon';

const ITEMS: { icon: IconName; title: string; body: string }[] = [
  { icon: 'wallet', title: 'Your wallet', body: 'Paid to the address you list' },
  { icon: 'globe', title: 'Four networks', body: 'Solana, Tempo, Base and Arbitrum' },
  { icon: 'code', title: 'One tag', body: 'Plain HTML or React' },
  { icon: 'bot', title: 'Agent-ready', body: 'Buyable over MCP' },
];

export function Highlights() {
  return (
    <section aria-label="Highlights" className="border-line border-y">
      <ul className="divide-line mx-auto grid max-w-1160 grid-cols-2 lg:grid-cols-4 lg:divide-x">
        {ITEMS.map((item) => (
          <li key={item.title} className="flex items-center gap-14 px-16 py-24 sm:px-24">
            <span className="rounded-12 bg-accent-soft text-accent-ink grid size-40 shrink-0 place-items-center">
              <Icon name={item.icon} />
            </span>
            <span className="min-w-0">
              <span className="text-15 block font-semibold">{item.title}</span>
              <span className="text-13 text-text-2 block">{item.body}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
