import { Button } from '../../components/Button';
import { SettingRow } from '../../components/SettingRow';
import type { ConsoleApi } from '../lib/api';
import {
  type PlanNames,
  keepRefusalText,
  planRefusalText,
  scheduledWords,
} from '../lib/plan-change';
import type { PlanScheduleView } from '../lib/store-view';
import { usePlanStep } from '../lib/use-plan-step';

interface Props {
  api: ConsoleApi;
  tenantId: string;
  scheduled: PlanScheduleView;
  names: PlanNames;
  /** The plan in force, kept until the switch. */
  current: string;
  onChanged: (notice?: string) => void;
}

/**
 * A downgrade the merchant scheduled (plan 2.4, 2.6): when it moves, and Keep
 * (`DELETE /tenants/:id/plan/scheduled`) unless the server says why not, in
 * its own words.
 */
export function PlanScheduleRow({ api, tenantId, scheduled, names, current, onChanged }: Props) {
  const { busy, error, run } = usePlanStep();
  const kept = names.name(current);
  const refusal = keepRefusalText(scheduled);

  const keep = () =>
    run(async () => {
      const answer = await api.request('DELETE', `/tenants/${tenantId}/plan/scheduled`);
      if (answer.status === 200) {
        onChanged(`Your store stays on ${kept}.`);
        return '';
      }
      if (answer.status === 409 || answer.status === 404) {
        onChanged();
      }
      return planRefusalText(answer.body, answer.status, {
        to: names.name(scheduled.tier),
        current: kept,
      });
    });

  return (
    <SettingRow label="Scheduled">
      <p className="text-14">{scheduledWords(scheduled, names)}</p>
      {refusal === undefined ? (
        <Button disabled={busy} onClick={() => void keep()} className="self-start">
          {`Keep ${kept}`}
        </Button>
      ) : (
        <p className="text-13 text-text-2">{refusal}</p>
      )}
      <p role="alert" className="text-13 text-error empty:hidden">
        {error}
      </p>
    </SettingRow>
  );
}
