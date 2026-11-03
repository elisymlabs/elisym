import { useCallback, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import type { ApiAnswer, ConsoleApi } from '../lib/api';
import { explain } from '../lib/errors';
import { fieldOf } from '../lib/fields';
import {
  type PlanNames,
  type SheetLines,
  planPreviewOf,
  previewLines,
  refusalLines,
  switchedWords,
} from '../lib/plan-change';
import { billingPageUrl } from '../lib/rails';
import type { TierCard } from '../lib/tiers';
import { usePlanStep } from '../lib/use-plan-step';
import { PlanPicker } from './PlanPicker';
import { ProductSheet } from './ProductSheet';

interface Props {
  api: ConsoleApi;
  tenantId: string;
  /** The plan in force. */
  current: string;
  /** The billing page's `customer_ref` (owner-bound), when the cloud gives one. */
  billingRef: string | undefined;
  billingUrl: string | undefined;
  names: PlanNames;
  loadTiers: () => Promise<ApiAnswer>;
  /** The server's clock now (the days left are counted on it). */
  now: () => number;
  onClose: () => void;
  /** The change was taken: the store is read again, with a line to say so, if any. */
  onDone: (notice?: string) => void;
  /** The change was refused or not answered: the store is read again. */
  onStale: () => void;
  onOpenPage: (page: 'products' | 'settings') => void;
}

/** The plan picked, and what the server said a change to it would do (undefined while it is asked). */
interface Asked {
  tier: TierCard;
  answer: ApiAnswer | undefined;
  /** The change itself was refused: its answer replaces the preview's. */
  refused: boolean;
}

const LINK = 'rounded-10 bg-accent text-accent-text text-15 px-20 py-12 text-center font-semibold';

/**
 * Change plan (plan `cloud-plan-change.md` 2.6): the plans, the current one
 * marked; a pick asks the server what the change would do
 * (`POST /tenants/:id/plan/preview`) and says it, with its one action: pay
 * and switch, move now or at the end of the paid time, the billing page, or
 * the page where what is over the plan is removed. The server decides again
 * when the change is sent; nothing here computes a price or a case.
 */
export function PlanChangeSheet({
  api,
  tenantId,
  current,
  billingRef,
  billingUrl,
  names,
  loadTiers,
  now,
  onClose,
  onDone,
  onStale,
  onOpenPage,
}: Props) {
  const [asked, setAsked] = useState<Asked | undefined>(undefined);
  const { busy, run } = usePlanStep();
  const latest = useRef(0);

  const choose = useCallback(
    (tier: TierCard) => {
      latest.current += 1;
      const mine = latest.current;
      setAsked({ tier, answer: undefined, refused: false });
      void api
        .request('POST', `/tenants/${tenantId}/plan/preview`, { tier: tier.id })
        .then((answer) => {
          // Only the newest pick's answer counts.
          if (mine === latest.current) {
            setAsked({ tier, answer, refused: false });
          }
        });
    },
    [api, tenantId],
  );

  const plans =
    asked === undefined ? undefined : { to: asked.tier.name, current: names.name(current) };
  let shown: SheetLines | undefined;
  if (asked?.answer !== undefined && plans !== undefined) {
    const preview =
      asked.answer.status === 200 && !asked.refused ? planPreviewOf(asked.answer.body) : undefined;
    if (preview !== undefined) {
      shown = previewLines(preview, names, now());
    } else if (asked.answer.status === 200) {
      shown = { lines: [explain(undefined, 200)], action: { kind: 'none' } };
    } else {
      shown = refusalLines(asked.answer.body, asked.answer.status, plans);
    }
  }

  const confirm = (tier: TierCard) =>
    run(async () => {
      latest.current += 1;
      const answer = await api.request('POST', `/tenants/${tenantId}/plan`, { tier: tier.id });
      if (answer.status === 200) {
        const request = fieldOf(answer.body, 'request');
        const scheduled = fieldOf(answer.body, 'scheduled');
        let notice: string | undefined;
        if (fieldOf(request, 'status') === 'done') {
          notice = switchedWords(tier.name);
        } else if (request === undefined && scheduled === undefined) {
          notice = `Your store is on ${tier.name} now.`;
        }
        onDone(notice);
        return '';
      }
      setAsked({ tier, answer, refused: true });
      // Refused, or not answered (a card change may still have been taken): the store is read again.
      onStale();
      return '';
    });

  let action = (
    <Button onClick={onClose} size="lg">
      Close
    </Button>
  );
  const kind = shown?.action.kind;
  if (shown?.action.kind === 'confirm' && asked !== undefined) {
    const { tier } = asked;
    action = (
      <Button variant="primary" size="lg" disabled={busy} onClick={() => void confirm(tier)}>
        {shown.action.label}
      </Button>
    );
  } else if (shown?.action.kind === 'page') {
    const { page, label } = shown.action;
    action = (
      <Button
        size="lg"
        onClick={() => {
          onOpenPage(page);
          onClose();
        }}
      >
        {label}
      </Button>
    );
  } else if (kind === 'billing_page' && billingUrl !== undefined) {
    action = (
      <a
        href={billingPageUrl(billingUrl, tenantId, billingRef)}
        target="_blank"
        rel="noopener noreferrer"
        className={LINK}
      >
        Open the billing page
      </a>
    );
  }

  return (
    <ProductSheet
      title="Change plan"
      changed={false}
      onDiscard={onClose}
      onClose={onClose}
      actions={action}
    >
      <div className="flex flex-col gap-16">
        <PlanPicker
          loadTiers={loadTiers}
          preselect={undefined}
          chosen={asked?.tier.id}
          onChoose={choose}
          locked={busy}
          current={current}
        />
        {asked !== undefined && asked.answer === undefined ? (
          <p role="status" className="text-14 text-text-3">
            Reading what this change does...
          </p>
        ) : null}
        {shown === undefined ? null : (
          <div role="status" className="rounded-12 bg-surface-2 flex flex-col gap-8 p-16">
            {shown.lines.map((line) => (
              <p key={line} className="text-14 leading-relaxed">
                {line}
              </p>
            ))}
            {kind === 'billing_page' && billingUrl === undefined ? (
              <p className="text-14 leading-relaxed">
                The billing page is not available here: contact elisym.
              </p>
            ) : null}
          </div>
        )}
      </div>
    </ProductSheet>
  );
}
