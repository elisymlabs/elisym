import { Button } from '../../components/Button';
import { SettingRow } from '../../components/SettingRow';
import type { ConsoleApi } from '../lib/api';
import { fieldOf } from '../lib/fields';
import {
  type PlanNames,
  type PlanNotice,
  planRefusalText,
  requestWords,
  switchedWords,
} from '../lib/plan-change';
import { stripeInvoiceUrl } from '../lib/rails';
import type { PlanRequestView } from '../lib/store-view';
import { usePlanStep } from '../lib/use-plan-step';

interface Props {
  api: ConsoleApi;
  tenantId: string;
  request: PlanRequestView;
  names: PlanNames;
  /** The plan in force. */
  current: string;
  /** The request moved: the store is read again, with a line to say what happened, if any. */
  onChanged: (notice?: PlanNotice) => void;
}

/**
 * A card plan change on its way, or one that ended without applying (plan
 * `cloud-plan-change.md` 2.6): its words, and its steps. Check again reads
 * where it stands; Confirm the payment opens the invoice page Stripe made (on
 * Stripe's invoice host only, never built here); Cancel voids it.
 */
export function PlanRequestRow({ api, tenantId, request, names, current, onChanged }: Props) {
  const { busy, error, run } = usePlanStep();
  const words = requestWords(request, names);
  if (words === undefined) {
    return null;
  }
  const to = names.name(request.to);
  const plans = { to, current: names.name(current) };
  const path = `/tenants/${tenantId}/plan/requests/${encodeURIComponent(request.id)}`;
  const payUrl =
    request.status === 'awaiting_confirmation' ? stripeInvoiceUrl(request.payUrl) : undefined;
  const waiting = request.status === 'charging' || request.status === 'awaiting_confirmation';

  const checkAgain = () =>
    run(async () => {
      const answer = await api.request('POST', `${path}/check`);
      if (answer.status === 200) {
        const status = fieldOf(fieldOf(answer.body, 'request'), 'status');
        onChanged(status === 'done' ? { text: switchedWords(to), tone: 'ok' } : undefined);
        return '';
      }
      if (answer.status === 404 || answer.status === 409) {
        onChanged();
      }
      return planRefusalText(answer.body, answer.status, plans);
    });

  const cancel = () =>
    run(async () => {
      const answer = await api.request('DELETE', path);
      if (answer.status === 200) {
        const said = fieldOf(answer.body, 'words');
        // Paid after all is good news; held for us is not.
        const tone = fieldOf(answer.body, 'outcome') === 'already_paid' ? 'ok' : 'warn';
        onChanged(typeof said === 'string' && said !== '' ? { text: said, tone } : undefined);
        return '';
      }
      if (answer.status === 404 || answer.status === 409) {
        onChanged();
      }
      return planRefusalText(answer.body, answer.status, plans);
    });

  return (
    <SettingRow label={`Change to ${to}`}>
      <p role="status" className="text-14" data-request={request.status}>
        {words}
      </p>
      {waiting ? (
        <div className="flex flex-wrap gap-8">
          {payUrl === undefined ? null : (
            <a
              href={payUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-10 bg-accent text-accent-text text-14 px-16 py-8 font-semibold"
            >
              Confirm the payment
            </a>
          )}
          <Button disabled={busy} onClick={() => void checkAgain()}>
            Check again
          </Button>
          {request.status === 'awaiting_confirmation' ? (
            <Button disabled={busy} onClick={() => void cancel()}>
              Cancel
            </Button>
          ) : null}
        </div>
      ) : null}
      <p role="alert" className="text-13 text-error empty:hidden">
        {error}
      </p>
    </SettingRow>
  );
}
