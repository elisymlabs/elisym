import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { SettingRow } from '../../components/SettingRow';
import { SettingsSection } from '../../components/SettingsSection';
import type { ConsoleApi } from '../lib/api';
import { explainAnswer } from '../lib/errors';
import { fieldOf } from '../lib/fields';
import { type ProblemField, problemText } from '../lib/problems';
import { EVM_CHAINS, type SettingsForm, choiceOf } from '../lib/settings';
import type { KeptStore } from '../lib/use-kept-store';
import { ProblemList } from './ProblemList';
import { RailFields, railChange } from './RailFields';

interface Props {
  api: ConsoleApi;
  tenantId: string;
  kept: KeptStore;
  /** A save the store took: what reads the store's progress reads it again. */
  onSaved?: () => void;
}

/** The refusals shown under the payment networks row. */
const NETWORKS: readonly ProblemField[] = ['solana', 'tempo', 'ethereum', 'arbitrum', 'base'];

const CHAIN_NAMES: Record<(typeof EVM_CHAINS)[number], string> = {
  ethereum: 'Ethereum (USDC)',
  arbitrum: 'Arbitrum (USDC)',
  base: 'Base (USDC)',
};

/**
 * The store's settings as rows: name, domain, webhook and the networks it
 * takes, saved through cloud-api (which builds config.json and refuses what
 * the node would). A refusal is said in words at its field. The networks'
 * endpoints are ours: one a store was saved with of its own is named, with
 * "Use ours" to drop it (as turning the network off and on does). Saved
 * settings apply with the next cycle; until then the store shows what was.
 * While nothing is typed, the form follows what the store keeps (a name saved
 * in the checklist, a network the payouts turned on).
 */
export function SettingsPanel({ api, tenantId, kept, onSaved }: Props) {
  const { read, readError, readRecovers, reload } = kept;
  const [form, setForm] = useState<SettingsForm | undefined>(undefined);
  // A save's refusal: apart from a read's failure, so a later read never hides why a save failed.
  const [error, setError] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  // Every edit to the form: a save reports "Saved" only when nothing was edited since it was sent.
  const version = useRef(0);
  // The edit the form was last filled or saved at: past it, something is typed and kept as typed.
  const filledAt = useRef(0);

  // Filled from each read while nothing is typed since: the settings still waiting to be kept when
  // there are (a form of the kept ones would undo them when saved), else the kept ones.
  useEffect(() => {
    if (read !== undefined && version.current === filledAt.current) {
      setForm(read.waitingForm ?? read.form);
    }
  }, [read]);

  /** An edit to the form: what was said of the last save no longer holds. */
  const change = (next: SettingsForm) => {
    version.current += 1;
    setForm(next);
    setSaved(false);
  };

  const save = async () => {
    if (inFlight.current || form === undefined) {
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setSaved(false);
    setProblems([]);
    setError('');
    const sent = version.current;
    const answer = await api.request('POST', `/tenants/${tenantId}/store`, choiceOf(form));
    inFlight.current = false;
    setBusy(false);
    if (answer.status === 200) {
      setSaved(version.current === sent);
      if (version.current === sent) {
        // Saved as typed: the reads fill the form again.
        filledAt.current = sent;
      }
      // Read again: the edit now waits, and a new domain shows its record.
      reload();
      onSaved?.();
      return;
    }
    const detail = fieldOf(answer.body, 'detail');
    if (fieldOf(answer.body, 'error') === 'store_refused' && typeof detail === 'string') {
      setProblems(detail.split('\n'));
      return;
    }
    setError(explainAnswer(answer.body, answer.status));
  };

  const shown = problems.map(problemText);
  const at = (...fields: ProblemField[]) =>
    shown.filter((problem) => problem.field !== undefined && fields.includes(problem.field));
  const elsewhere = shown.filter(
    (problem) =>
      problem.field === undefined ||
      !(['name', 'domain', 'webhook', ...NETWORKS] as const).some(
        (field) => field === problem.field,
      ),
  );

  /** A field's help, and its refusals when it has some. */
  const described = (id: string, field: ProblemField) =>
    at(field).length > 0 ? `${id}-help ${id}-problems` : `${id}-help`;

  if (form === undefined) {
    return (
      <p
        className={`text-14 ${readError === '' ? 'text-text-3' : 'text-error'}`}
        role={readError === '' ? undefined : 'alert'}
      >
        {readError === '' ? 'Loading...' : readError}
      </p>
    );
  }
  return (
    <SettingsSection
      title="Your store"
      description="Saved changes apply to your store within a minute."
      footer={
        <>
          <ProblemList problems={elsewhere} />
          {error === '' ? null : (
            <p role="alert" className="text-13 text-error">
              {error}
            </p>
          )}
          {saved ? (
            <p role="status" className="text-13 text-text-2">
              Saved: it applies to the store shortly.
            </p>
          ) : null}
          <Button
            disabled={busy}
            onClick={() => void save()}
            variant="primary"
            className="self-start"
          >
            Save settings
          </Button>
        </>
      }
    >
      {readError === '' ? null : (
        <p role="alert" className="text-13 text-error px-20 py-12">
          {readRecovers
            ? `Could not read the store just now (trying again): ${readError}`
            : `Could not read the store: ${readError}`}
        </p>
      )}
      {read?.pending === true ? (
        <p className="text-13 text-text-3 px-20 py-12">A saved change is being applied.</p>
      ) : null}
      {read?.refused === undefined ? null : (
        <div className="flex flex-col gap-4 px-20 py-12">
          <p className="text-13 text-error">
            The last saved change was refused when it was applied:
          </p>
          <ProblemList problems={read.refused.map(problemText)} />
        </div>
      )}
      <SettingRow label="Store name" htmlFor="store-name" help="As buyers see it in the checkout.">
        <Input
          id="store-name"
          aria-describedby={described('store-name', 'name')}
          aria-invalid={at('name').length > 0 || undefined}
          type="text"
          value={form.name}
          onChange={(event) => change({ ...form, name: event.target.value })}
        />
        <ProblemList id="store-name-problems" problems={at('name')} />
      </SettingRow>
      <SettingRow
        label="Your domain"
        htmlFor="store-domain"
        help="Optional. Your own site, as shop.example: the checkout then shows it verified."
      >
        <Input
          id="store-domain"
          aria-describedby={described('store-domain', 'domain')}
          aria-invalid={at('domain').length > 0 || undefined}
          type="text"
          value={form.domain}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => change({ ...form, domain: event.target.value })}
          mono
        />
        <ProblemList id="store-domain-problems" problems={at('domain')} />
      </SettingRow>
      <SettingRow
        label="Webhook"
        htmlFor="store-webhook"
        help="Optional. An address on your server that is told of each paid order."
      >
        <Input
          id="store-webhook"
          aria-describedby={described('store-webhook', 'webhook')}
          aria-invalid={at('webhook').length > 0 || undefined}
          type="text"
          value={form.webhookUrl}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => change({ ...form, webhookUrl: event.target.value })}
          mono
        />
        <ProblemList id="store-webhook-problems" problems={at('webhook')} />
      </SettingRow>
      <SettingRow label="How buyers pay" help="The networks your store takes payments on.">
        <RailFields
          id="rail-solana"
          label="Solana"
          rail={form.solana}
          onChange={(solana) =>
            change({
              ...form,
              solana: railChange(form.solana, { on: solana.on, rpcUrl: solana.rpcUrl }),
            })
          }
        />
        <RailFields
          id="rail-tempo"
          label="Tempo"
          rail={form.tempo}
          onChange={(tempo) =>
            change({
              ...form,
              tempo: railChange(form.tempo, { on: tempo.on, rpcUrl: tempo.rpcUrl }),
            })
          }
        />
        {EVM_CHAINS.map((chain) => (
          <RailFields
            key={chain}
            id={`rail-${chain}`}
            label={CHAIN_NAMES[chain]}
            rail={form.evm[chain]}
            onChange={(rail) =>
              change({
                ...form,
                evm: {
                  ...form.evm,
                  [chain]: railChange(form.evm[chain], {
                    on: rail.on,
                    rpcUrl: rail.rpcUrl,
                    credit: 'credit' in rail ? rail.credit : '',
                  }),
                },
              })
            }
          />
        ))}
        <ProblemList problems={at(...NETWORKS)} />
      </SettingRow>
    </SettingsSection>
  );
}
