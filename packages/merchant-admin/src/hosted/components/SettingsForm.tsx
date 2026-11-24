import { useState } from 'react';
import { ApiError } from '../lib/api';
import { fullConfig } from '../lib/config-input';
import { errorMessage } from '../lib/errors';
import type { StoreSession } from '../lib/store-session';
import type { EvmCredit, StoreConfig } from '../lib/types';
import { WEBHOOK_NOT_USABLE, WEBHOOK_REFUSED, webhookUrlInput } from '../lib/webhook-url';
import { BUTTON_SECONDARY, INPUT } from '../styles';
import { InboxRelays } from './InboxRelays';
import { Notice } from './Notice';

interface Props {
  session: StoreSession;
  config: StoreConfig;
  onSaved: () => void;
  onStale: () => void;
}

export const NAME_EMPTY = 'Enter the store name.';
export const NO_RELAYS = 'Keep one inbox relay at least.';
export const PAYOUTS_FIRST =
  'Save your payout addresses first (Payouts tab): settings cannot be saved without them.';

const CREDITS: readonly { value: EvmCredit; label: string }[] = [
  { value: 'fast', label: 'Fast: an EVM payment counts once it is in a block' },
  {
    value: 'safe',
    label: 'Safe: an EVM payment counts once its block is safe from reorgs (minutes)',
  },
];

/** Name, nip05, inbox relays, webhook URL, EVM credit: saved as the whole config, at the revision read. */
export function SettingsForm({ session, config, onSaved, onStale }: Props) {
  const [name, setName] = useState(config.name);
  const [nip05, setNip05] = useState(config.nip05 ?? '');
  const [relays, setRelays] = useState<string[]>(config.inboxRelays);
  const [credit, setCredit] = useState<EvmCredit>(config.evmCredit);
  const [webhook, setWebhook] = useState(config.webhookUrl ?? '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const hasPayouts = config.draftPayouts.length > 0;

  const save = async () => {
    if (name.trim() === '') {
      setProblem(NAME_EMPTY);
      return;
    }
    if (relays.length === 0) {
      setProblem(NO_RELAYS);
      return;
    }
    const webhookUrl = webhookUrlInput(webhook);
    if (webhookUrl === undefined) {
      setProblem(WEBHOOK_NOT_USABLE);
      return;
    }
    setBusy(true);
    setProblem(undefined);
    try {
      await session.api.putConfig(
        fullConfig(config, {
          name: name.trim(),
          nip05: nip05.trim(),
          inboxRelays: relays,
          evmCredit: credit,
          webhookUrl,
        }),
      );
      onSaved();
    } catch (error) {
      const webhookChanged = webhookUrl !== (config.webhookUrl ?? null);
      if (error instanceof ApiError && error.code === 'stale_config') {
        onStale();
      } else if (error instanceof ApiError && error.code === 'bad_config' && webhookChanged) {
        setProblem(WEBHOOK_REFUSED);
      } else {
        setProblem(errorMessage(error));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-16">
      <label className="text-14 flex flex-col gap-4">
        Store name
        <input
          id="settings-name"
          className={INPUT}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className="text-14 flex flex-col gap-4">
        Store address (nip05, optional)
        <input
          id="settings-nip05"
          className={INPUT}
          value={nip05}
          placeholder="shop@example.com"
          onChange={(event) => setNip05(event.target.value)}
        />
      </label>
      <label className="text-14 flex flex-col gap-4">
        Webhook URL (optional: your server is told of each paid order)
        <input
          id="settings-webhook"
          className={INPUT}
          value={webhook}
          placeholder="https://shop.example.com/paycore-webhook"
          onChange={(event) => setWebhook(event.target.value)}
        />
      </label>
      <InboxRelays allowed={session.meta.inboxRelays} selected={relays} onChange={setRelays} />
      <fieldset className="flex flex-col gap-8">
        <legend className="text-14 mb-4 font-medium">EVM payments</legend>
        {CREDITS.map((option) => (
          <label key={option.value} className="text-14 flex items-center gap-8">
            <input
              type="radio"
              name="evm-credit"
              id={`evm-credit-${option.value}`}
              checked={credit === option.value}
              onChange={() => setCredit(option.value)}
            />
            {option.label}
          </label>
        ))}
      </fieldset>
      {hasPayouts ? null : <Notice tone="info">{PAYOUTS_FIRST}</Notice>}
      <div>
        <button
          type="button"
          className={BUTTON_SECONDARY}
          disabled={busy || !hasPayouts}
          onClick={() => void save()}
        >
          Save settings
        </button>
      </div>
      {problem === undefined ? null : <Notice tone="error">{problem}</Notice>}
    </div>
  );
}
