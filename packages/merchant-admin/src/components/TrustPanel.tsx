import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { SecurityDetails } from './SecurityDetails';

const POINTS: { icon: IconName; title: string; body: ReactNode; tone: 'plain' | 'accent' }[] = [
  {
    icon: 'store',
    title: 'A view of your store',
    body: 'Your orders, what your node credited, your products and your store profile, read straight from your relays.',
    tone: 'plain',
  },
  {
    icon: 'shield',
    title: 'Your wallet stays yours',
    body: 'Buyers pay straight into your wallet. Nobody, neither elisym nor this page, can reach your wallet or the funds in it. The store key is not a wallet key: Pay Core never asks for a wallet’s secret key or seed phrase, so never paste one, here or anywhere else.',
    tone: 'accent',
  },
  {
    icon: 'key',
    title: 'Keep the store key like a password',
    body: 'It signs your store’s profile, which decides where new buyers’ payments go. Paste it only here or into the local admin.',
    tone: 'plain',
  },
];

const TONES = {
  plain: 'border-line bg-surface/60',
  accent: 'border-accent-ink/30 bg-accent-soft',
};

/** What the admin is and what the key can and cannot do, before the merchant pastes it. */
export function TrustPanel() {
  return (
    <aside className="flex flex-col gap-12" aria-label="About this page">
      {POINTS.map((point) => (
        <div
          key={point.title}
          className={`rounded-16 flex gap-12 border p-16 ${TONES[point.tone]}`}
        >
          <span className="rounded-10 bg-surface-2 text-text-2 grid size-32 shrink-0 place-items-center">
            <Icon name={point.icon} className="size-16" />
          </span>
          <div className="flex min-w-0 flex-col gap-4">
            <p className="text-14 font-semibold">{point.title}</p>
            <p className="text-13 text-text-2 leading-relaxed">{point.body}</p>
          </div>
        </div>
      ))}
      <SecurityDetails />
    </aside>
  );
}
