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
  /** A signup is on its way: no other plan can be picked until it is answered. */
  locked: boolean;
}

const NUMBER = new Intl.NumberFormat('en-US');
/** The arrow keys of a radio group: the step each takes through the plans that can start. */
const ARROW_STEPS: Readonly<Record<string, number>> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

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
export function PlanPicker({ loadTiers, preselect, chosen, onChoose, locked }: Props) {
  // Undefined while the catalog loads; `failed` when it could not be read.
  const [tiers, setTiers] = useState<TierCard[] | 'failed' | undefined>(undefined);
  const [loads, setLoads] = useState(0);
  // The plan to start on is the one given at mount (a later pick never reads the catalog again),
  // applied once, on the first catalog read.
  const startOn = useRef(preselect);
  const preselected = useRef(false);
  const cards = useRef(new Map<string, HTMLButtonElement>());

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
        const named = read.find((tier) => tier.id === startOn.current);
        if (named !== undefined && canStart(named)) {
          onChoose(named);
        }
      }
    });
    return () => {
      current = false;
    };
  }, [loadTiers, loads, onChoose]);

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

  const named = tiers.find((tier) => tier.id === startOn.current);
  // Said until a plan that can start is picked.
  const refused =
    startOn.current !== undefined &&
    (named === undefined || !canStart(named)) &&
    chosen === undefined;
  const selfServe = tiers.filter((tier) => tier.selfServe);
  const open = selfServe.filter(canStart);
  // One stop in the tab order: the picked plan, else the first that can start.
  const focusable = chosen ?? open[0]?.id;

  const pick = (tier: TierCard) => {
    if (!locked && canStart(tier)) {
      onChoose(tier);
    }
  };
  // Arrow keys move between the plans that can start, and pick, as a radio group does.
  const step = (from: string, by: number) => {
    const at = open.findIndex((tier) => tier.id === from);
    const next = open[(at + by + open.length) % open.length];
    if (next !== undefined) {
      pick(next);
      cards.current.get(next.id)?.focus();
    }
  };

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
      {open.length === 0 ? (
        <p role="status" className="text-14 text-text-2 mt-12 leading-relaxed">
          No plan can be started here right now: talk to us.
        </p>
      ) : null}
      <div role="radiogroup" aria-label="Plans" className="mt-16 grid gap-12 sm:grid-cols-2">
        {selfServe.map((tier) => {
          const way = paidBy(tier.payable);
          const canBegin = canStart(tier);
          const picked = tier.id === chosen;
          return (
            <button
              key={tier.id}
              ref={(card) => {
                if (card === null) {
                  cards.current.delete(tier.id);
                } else {
                  cards.current.set(tier.id, card);
                }
              }}
              type="button"
              role="radio"
              data-tier={tier.id}
              aria-checked={picked}
              tabIndex={tier.id === focusable ? 0 : -1}
              disabled={!canBegin || locked}
              onClick={() => pick(tier)}
              onKeyDown={(event) => {
                const by = ARROW_STEPS[event.key];
                if (by !== undefined) {
                  event.preventDefault();
                  step(tier.id, by);
                }
              }}
              className={`rounded-16 flex h-full w-full flex-col gap-8 border p-16 text-left transition disabled:cursor-not-allowed disabled:opacity-60 ${
                picked ? 'border-accent-ink bg-accent-soft/40' : 'border-line hover:border-line-2'
              }`}
            >
              <span className="text-16 font-semibold">{tier.name}</span>
              <span className="text-20 font-semibold tracking-tight">{tier.price}</span>
              <span className="text-13 text-text-2 flex flex-col gap-4">
                {limitsOf(tier).map((line) => (
                  <span key={line}>{line}</span>
                ))}
              </span>
              <span className="text-13 text-text-3">{way ?? 'Not available yet'}</span>
            </button>
          );
        })}
      </div>
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
