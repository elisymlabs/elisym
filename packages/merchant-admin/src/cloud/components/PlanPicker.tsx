import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { CONTACT_URL } from '../../constants';
import type { ApiAnswer } from '../lib/api';
import { type TierCard, canStart, paidBy, tierCardsFrom } from '../lib/tiers';
import { Card } from './Card';

interface Props {
  /** Reads the catalog (`GET /tiers`, no auth). */
  loadTiers: () => Promise<ApiAnswer>;
  /** A tier id to start on (a `/start` link's), if any. */
  preselect: string | undefined;
  /** The tier picked now, if any. */
  chosen: string | undefined;
  onChoose: (tier: TierCard) => void;
}

const NUMBER = new Intl.NumberFormat('en-US');

/** A tier's limits in words: a display string where the catalog has one. */
function limitsOf(tier: TierCard): string[] {
  const orders =
    tier.display.ordersPerMonth ??
    (tier.limits.ordersPerMonth === undefined
      ? 'No cap'
      : NUMBER.format(tier.limits.ordersPerMonth));
  return [
    `Products: ${tier.display.products ?? NUMBER.format(tier.limits.products)}`,
    `Paid orders a month: ${orders}`,
    ...(tier.ownRpc ? ['Your own network endpoints (RPC)'] : []),
  ];
}

/**
 * The plans a store can start on, from the catalog: a self-serve plan with a
 * way to pay is chosen with a click; the others say why not. A `/start`
 * link's plan is chosen at once when it can be, else said to be one that
 * cannot start here.
 */
export function PlanPicker({ loadTiers, preselect, chosen, onChoose }: Props) {
  // Undefined while the catalog loads; `failed` when it could not be read.
  const [tiers, setTiers] = useState<TierCard[] | 'failed' | undefined>(undefined);
  const [loads, setLoads] = useState(0);
  // The `/start` plan is applied once, on the first catalog read.
  const preselected = useRef(false);

  useEffect(() => {
    let current = true;
    void loadTiers().then((answer) => {
      if (!current) {
        return;
      }
      const read = answer.status === 200 ? tierCardsFrom(answer.body) : undefined;
      setTiers(read ?? 'failed');
      if (read !== undefined && !preselected.current) {
        preselected.current = true;
        const named = read.find((tier) => tier.id === preselect);
        if (named !== undefined && canStart(named)) {
          onChoose(named);
        }
      }
    });
    return () => {
      current = false;
    };
  }, [loadTiers, loads, preselect, onChoose]);

  if (tiers === undefined) {
    return (
      <Card title="Choose a plan">
        <p className="text-14 text-text-3 mt-12">Loading the plans...</p>
      </Card>
    );
  }
  if (tiers === 'failed') {
    return (
      <Card title="Choose a plan">
        <p role="alert" className="text-14 text-error mt-8 leading-relaxed">
          The plans could not be loaded. Check your connection and try again.
        </p>
        <Button
          onClick={() => {
            setTiers(undefined);
            setLoads((count) => count + 1);
          }}
          size="lg"
          className="mt-16"
        >
          Try again
        </Button>
      </Card>
    );
  }

  const named = tiers.find((tier) => tier.id === preselect);
  const refused = preselect !== undefined && (named === undefined || !canStart(named));
  const selfServe = tiers.filter((tier) => tier.selfServe);
  return (
    <Card title="Choose a plan">
      <p className="text-14 text-text-2 mt-8 leading-relaxed">
        Billed monthly. Buyers always pay straight to your wallet: the plan pays for the payment
        server we run for your store.
      </p>
      {refused ? (
        <p role="alert" className="text-14 text-warn mt-12 leading-relaxed">
          That plan cannot be started here: pick one below or talk to us.
        </p>
      ) : null}
      <ul className="mt-16 grid gap-12 sm:grid-cols-2">
        {selfServe.map((tier) => {
          const way = paidBy(tier.payable);
          const open = canStart(tier);
          const picked = tier.id === chosen;
          return (
            <li key={tier.id}>
              <button
                type="button"
                data-tier={tier.id}
                aria-pressed={picked}
                disabled={!open}
                onClick={() => onChoose(tier)}
                className={`rounded-16 flex h-full w-full flex-col gap-8 border p-16 text-left transition disabled:cursor-not-allowed disabled:opacity-60 ${
                  picked ? 'border-accent-ink bg-accent-soft/40' : 'border-line hover:border-line-2'
                }`}
              >
                <span className="text-16 font-semibold">{tier.name}</span>
                <span className="text-20 font-semibold tracking-tight">{tier.price}</span>
                <ul className="text-13 text-text-2 flex flex-col gap-4">
                  {limitsOf(tier).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
                <span className="text-13 text-text-3">{way ?? 'Not available yet'}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="text-13 text-text-3 mt-16">
        Need more?{' '}
        <a
          href={CONTACT_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-text-2 hover:text-text underline underline-offset-2"
        >
          Talk to us
        </a>
      </p>
    </Card>
  );
}
