import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import type { ConsoleApi } from '../lib/api';
import { explainAnswer } from '../lib/errors';
import { fieldOf } from '../lib/fields';
import { EVM_CHAINS, type SettingsForm, choiceOf } from '../lib/settings';
import type { KeptStore } from '../lib/use-kept-store';
import { Card } from './Card';
import { RailFields } from './RailFields';

interface Props {
  api: ConsoleApi;
  tenantId: string;
  kept: KeptStore;
}

const CHAIN_NAMES: Record<(typeof EVM_CHAINS)[number], string> = {
  ethereum: 'Ethereum (USDC)',
  arbitrum: 'Arbitrum (USDC)',
  base: 'Base (USDC)',
};

/**
 * The store's settings: name, domain, webhook and payment rails, saved through
 * cloud-api (which builds config.json and refuses what the node would). Saved
 * settings apply with the next cycle; until then the store shows what was.
 */
export function SettingsPanel({ api, tenantId, kept }: Props) {
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

  // The form is filled once, from the first read: the settings still waiting to be kept when there
  // are (a form of the kept ones would undo them when saved), else the kept ones. Later reads keep
  // what was typed.
  useEffect(() => {
    if (form === undefined && read !== undefined) {
      setForm(read.waitingForm ?? read.form);
    }
  }, [form, read]);

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
      // Read again: the edit now waits, and a new domain shows its record.
      reload();
      return;
    }
    const detail = fieldOf(answer.body, 'detail');
    if (fieldOf(answer.body, 'error') === 'store_refused' && typeof detail === 'string') {
      setProblems(detail.split('\n'));
      return;
    }
    setError(explainAnswer(answer.body, answer.status));
  };

  return (
    <Card title="Store settings">
      {form === undefined ? (
        <p
          className={`text-14 mt-12 ${readError === '' ? 'text-text-3' : 'text-error'}`}
          role={readError === '' ? undefined : 'alert'}
        >
          {readError === '' ? 'Loading...' : readError}
        </p>
      ) : (
        <div className="mt-16 flex flex-col gap-12">
          {readError === '' ? null : (
            <p role="alert" className="text-13 text-error">
              {readRecovers
                ? `Could not read the store just now (trying again): ${readError}`
                : `Could not read the store: ${readError}`}
            </p>
          )}
          {read?.pending === true ? (
            <p className="text-13 text-text-3">A saved change is being applied.</p>
          ) : null}
          {read?.refused === undefined ? null : (
            <div role="alert" className="text-13 text-error">
              <p>The last saved change was refused when it was applied:</p>
              <ul className="list-disc pl-20">
                {read.refused.map((problem, index) => (
                  <li key={index}>{problem}</li>
                ))}
              </ul>
            </div>
          )}
          <label htmlFor="store-name" className="text-14 font-medium">
            Store name
          </label>
          <Input
            id="store-name"
            type="text"
            value={form.name}
            onChange={(event) => change({ ...form, name: event.target.value })}
          />
          <label htmlFor="store-domain" className="text-14 font-medium">
            Your domain (optional, as shop.example)
          </label>
          <Input
            id="store-domain"
            type="text"
            value={form.domain}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => change({ ...form, domain: event.target.value })}
            mono
          />
          <label htmlFor="store-webhook" className="text-14 font-medium">
            Webhook URL (optional: paid orders are sent here)
          </label>
          <Input
            id="store-webhook"
            type="text"
            value={form.webhookUrl}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => change({ ...form, webhookUrl: event.target.value })}
            mono
          />
          <h3 className="text-15 mt-8 font-semibold">How buyers pay</h3>
          <RailFields
            id="rail-solana"
            label="Solana"
            rail={form.solana}
            onChange={(solana) =>
              change({ ...form, solana: { on: solana.on, rpcUrl: solana.rpcUrl } })
            }
          />
          <RailFields
            id="rail-tempo"
            label="Tempo"
            rail={form.tempo}
            onChange={(tempo) => change({ ...form, tempo: { on: tempo.on, rpcUrl: tempo.rpcUrl } })}
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
                    [chain]: {
                      on: rail.on,
                      rpcUrl: rail.rpcUrl,
                      credit: 'credit' in rail ? rail.credit : '',
                    },
                  },
                })
              }
            />
          ))}
          {problems.length === 0 ? null : (
            <ul role="alert" className="text-13 text-error list-disc pl-20">
              {problems.map((problem, index) => (
                <li key={index}>{problem}</li>
              ))}
            </ul>
          )}
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
          <Button disabled={busy} onClick={() => void save()} variant="primary" size="lg">
            Save settings
          </Button>
        </div>
      )}
    </Card>
  );
}
